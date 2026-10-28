/**
 * 平台存储代理客户端：未自配 S3 的登录用户走服务端代理访问平台对象存储。
 *
 * 为什么要这个类：
 *   平台 OSS 的 AccessKey 只在服务端，浏览器/桌面端拿不到，也就无法用自己的
 *   `S3StorageClient` 直连。但 `SyncEngine` 只依赖 `StorageClient` 这个接口，
 *   所以这里把接口的每个方法映射到服务端 `/api/storage/*`，
 *   `SyncEngine` 完全不用改就能跑在「平台存储」上。
 *
 * 与 S3StorageClient 的差别：
 *   1. 不需要 endpoint / region / AK / SK —— 这些都在服务端；
 *   2. key 一律传**相对 key**（相对用户前缀），服务端会强制加
 *      `mdadmin/neomd/users/<username>/`，因此本类不可能访问到别人的数据；
 *   3. `presignGet/presignPut` 走 `POST /api/storage/presign`（服务端签名后返回 URL），
 *      客户端不会看到签名过程；
 *   4. `publicUrl` 返回一个**服务端代理地址**而不是对象存储直链 —— 平台桶通常是私有的，
 *      直链没有签名会 403，而代理地址带登录态、能稳定工作。
 */

import type { S3ObjectMeta, StorageClient } from './types';

/**
 * 精简的请求接口：由调用方注入，避免 `@neomd/core` 反向依赖 `apps/web` 的 api client。
 *
 * 为什么这样设计：`@neomd/core` 是跨端共享包（Web / 桌面 / 移动），
 * 不应该 import 某个具体 App 的 `api()`；由 App 侧注入实现，core 保持无依赖。
 */
export interface ProxyTransport {
  /**
   * 发起一次请求并返回原始 `Response`。
   * 实现方需要自行处理：
   *  - 私有化模式拦截（应抛 PrivacyModeError）；
   *  - 401 → refresh → 重试；
   *  - 服务端 URL 解析（自定义服务器 / 官方）。
   */
  fetch(path: string, init: ProxyFetchInit): Promise<Response>;
  /** 服务端 API 基地址解析（用于 publicUrl 拼接，不含结尾斜杠） */
  resolveUrl(path: string): string;
}

export interface ProxyFetchInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

/** 服务端返回的错误包体结构 */
interface ProxyErrorBody {
  ok?: boolean;
  error?: { code?: string; message?: string };
}

/** 从失败响应里提取可读错误（优先服务端中文 message） */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${fallback}（HTTP ${res.status}）`;
    try {
      const json = JSON.parse(text) as ProxyErrorBody;
      const message = json?.error?.message;
      if (message) return message;
    } catch {
      /* 非 JSON 时用原文截断 */
    }
    return `${fallback}（HTTP ${res.status}）：${text.slice(0, 200)}`;
  } catch {
    return `${fallback}（HTTP ${res.status}）`;
  }
}

/** URL 编码单个 query 值（key 里含 `/`，必须整体编码） */
function q(value: string): string {
  return encodeURIComponent(value);
}

export interface ProxyClientOptions {
  /** 服务端接口前缀，默认 `/api/storage` */
  basePath?: string;
  /** 单个对象最大字节数（仅用于上传前本地拦截，服务端还会再校验一次） */
  maxObjectBytes?: number;
  /**
   * 当前仓库 id（1.1.5 新增）。
   *
   * 服务端据此把对象键拼到 `users/<user>/vaults/<vaultId>/` 下，
   * 并校验归属与启用状态。多仓库场景下**必须传**，否则所有仓库会共用一个前缀互相覆盖。
   * 作为 `x-vault-id` 请求头随每笔请求发出。
   */
  vaultId?: string;
  /**
   * 同步根前缀（1.1.9 新增，如 `mdadmin/neomd/users/admin/vaults/admin/`）。
   *
   * 为什么需要它 —— 这是「客户端与服务端谁负责拼前缀」的归属问题：
   * `SyncEngine` 内部一律使用**完整 key**（`rootPrefix + docs/...`），这是它与
   * `S3StorageClient` 共用的协议，不能为了走代理而改。但服务端代理接口的契约是
   * **相对 key**（服务端自己拼 `users/<user>/vaults/<vaultId>/`，客户端不该知道）。
   *
   * 1.1.8 之前两端都没做归一：客户端把完整 key 原样发过去，服务端靠
   * `toRelativeKey()` 反向剥离前缀兜着。能用，但很脆 —— 只要客户端的 rootPrefix
   * 与服务端拼出来的作用域有任何一个字符差异（末尾斜杠、大小写、vaultId 不一致），
   * 剥离就失败，key 会变成双前缀，表现为「上传成功但永远读不回来」。
   *
   * 现在由本类**在边界处单向归一**：出站一律剥成相对 key，入站（list 返回的 key）
   * 一律补回完整 key。这样 `SyncEngine` 继续用完整 key，网络上永远是相对 key，
   * 服务端的反向剥离退化为「防御性兜底」而不再是主路径。
   */
  rootPrefix?: string;
}

export class RemoteProxyStorageClient implements StorageClient {
  private readonly basePath: string;
  private readonly maxObjectBytes: number;
  private readonly vaultId: string;
  /** 同步根前缀（末尾保证带 `/`；为空表示不启用归一） */
  private readonly rootPrefix: string;

  constructor(
    private readonly transport: ProxyTransport,
    options: ProxyClientOptions = {},
  ) {
    this.basePath = (options.basePath ?? '/api/storage').replace(/\/+$/, '');
    this.maxObjectBytes = options.maxObjectBytes ?? 25 * 1024 * 1024;
    this.vaultId = options.vaultId ?? '';
    const root = (options.rootPrefix ?? '').trim();
    this.rootPrefix = root && !root.endsWith('/') ? `${root}/` : root;
  }

  /**
   * 完整 key → 相对 key（出站方向）。
   *
   * 已经是相对 key 的原样返回，因此本类对「上游传完整 key」和「上游传相对 key」
   * 两种调用都兼容 —— 这点很重要：`listObjects()` 返回的对象 key 有时被上游直接
   * 再传给 `getObject()`，若只认一种形态就会出现「列举得到但读不到」。
   */
  private toRelative(key: string): string {
    if (!this.rootPrefix) return key;
    if (key.startsWith(this.rootPrefix)) return key.slice(this.rootPrefix.length);
    return key;
  }

  /**
   * 相对 key → 完整 key（入站方向）。
   *
   * 只用于**服务端返回的列举结果**：服务端按契约只返回相对 key，
   * 而 `SyncEngine` 后续要拿这些 key 继续调 `getObjectText()` 并与其他
   * 完整 key 做比较（例如 `blobKey()` 拼出来的 key），所以必须补回完整前缀，
   * 否则会出现「同一对象在内存里有两种 key 表示」而导致的重复上传/误判缺失。
   */
  private toAbsolute(key: string): string {
    if (!this.rootPrefix) return key;
    return key.startsWith(this.rootPrefix) ? key : `${this.rootPrefix}${key}`;
  }

  /**
   * 统一构造请求头。
   *
   * 把 `x-vault-id` 集中在这里注入，而不是散落在每个方法里——
   * 这样将来再加公共头（比如幂等键、客户端版本）也只改一处，
   * 不会出现「某个方法漏传导致该接口失败」的隐蔽 bug。
   */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.vaultId) h['x-vault-id'] = this.vaultId;
    return h;
  }

  /* ------------------------------ 写入 ------------------------------ */

  async putObject(key: string, body: Uint8Array | string, contentType = 'application/octet-stream'): Promise<void> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    if (bytes.length > this.maxObjectBytes) {
      throw new Error(
        `对象超出大小限制：${bytes.length} 字节 > 上限 ${this.maxObjectBytes} 字节`,
      );
    }
    // 用 octet-stream 直传原始字节：相比 base64 省 33% 流量，也省一次编解码
    const rel = this.toRelative(key);
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(rel)}`, {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'application/octet-stream',
        // 同时带上相对 key：服务端优先取 query，这里只是给 multipart 等场景留的兜底
        'x-object-key': rel,
        'x-object-content-type': contentType,
        }),
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(await readError(res, '上传失败'));
  }

  /* ------------------------------ 读取 ------------------------------ */

  async getObject(key: string): Promise<Uint8Array> {
    const rel = this.toRelative(key);
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(rel)}`, { method: 'GET', headers: this.headers() });
    if (!res.ok) throw new Error(await readError(res, '下载失败'));
    return new Uint8Array(await res.arrayBuffer());
  }

  async getObjectText(key: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.getObject(key));
  }

  /**
   * 读取对象元信息（只用于「对象是否存在」判断，SyncEngine 不读 etag）。
   *
   * 用 HEAD 而不是 GET：元信息查询在同步里是高频操作
   * （每篇文档都要查 blob 与 version 是否存在），GET 会白白下载整个正文。
   * 对象不存在时返回 null（与 S3StorageClient 语义一致，不抛错）。
   */
  async headObject(key: string): Promise<S3ObjectMeta | null> {
    const rel = this.toRelative(key);
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(rel)}`, { method: 'HEAD', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      // 网络/权限类错误向上抛，让 SyncEngine 记进 errors 而不是静默当作「对象不存在」
      throw new Error(await readError(res, '读取对象信息失败'));
    }
    return {
      // 返回**完整 key**：调用方拿它继续比较时用的是完整 key（见 toAbsolute 说明）
      key: this.toAbsolute(key),
      // content-length 属于 CORS 安全列表头，浏览器可直接读
      size: Number(res.headers.get('content-length') ?? 0),
      // etag 非安全列表头，跨域下可能读不到；同步协议不依赖它，读不到就留空
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      lastModified: 0,
    };
  }

  /* ------------------------------ 删除 ------------------------------ */

  async deleteObject(key: string): Promise<void> {
    const rel = this.toRelative(key);
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(rel)}`, { method: 'DELETE', headers: this.headers() });
    // 404 视为已删除（幂等），与 S3StorageClient 一致
    if (!res.ok && res.status !== 404) throw new Error(await readError(res, '删除失败'));
  }

  /* ------------------------------ 列举 ------------------------------ */

  async listObjects(prefix: string, maxKeys = 1000): Promise<S3ObjectMeta[]> {
    const limit = Math.min(1000, Math.max(1, Math.trunc(maxKeys) || 1000));
    const relPrefix = this.toRelative(prefix);
    const res = await this.transport.fetch(
      `${this.basePath}/list?prefix=${q(relPrefix)}&maxKeys=${limit}`,
      { method: 'GET', headers: this.headers() },
    );
    if (!res.ok) throw new Error(await readError(res, '列举失败'));
    // 服务端返回 { ok, data: { objects: [...], truncated, prefix } }
    interface ListPayload {
      objects?: Array<{ key?: unknown; size?: unknown; etag?: unknown; lastModified?: unknown }>;
    }
    let payload: ListPayload | null = null;
    try {
      const json = (await res.json()) as { ok?: boolean; data?: ListPayload };
      payload = json?.data ?? null;
    } catch {
      payload = null;
    }
    const objects = Array.isArray(payload?.objects) ? payload.objects : [];
    return objects.map((obj) => ({
      // 服务端按契约返回相对 key；这里补回完整前缀，保证本类对外只暴露一种 key 表示
      key: this.toAbsolute(String(obj.key ?? '')),
      size: Number(obj.size ?? 0),
      etag: String(obj.etag ?? '').replace(/"/g, ''),
      lastModified: Number(obj.lastModified ?? 0),
    }));
  }

  /* ------------------------------ 预签名 ------------------------------ */

  private async presign(key: string, method: 'GET' | 'PUT', expiresSeconds: number, contentType?: string): Promise<string> {
    const res = await this.transport.fetch(`${this.basePath}/presign`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        key: this.toRelative(key),
        method,
        expiresSeconds: Math.min(604800, Math.max(60, Math.trunc(expiresSeconds) || 3600)),
        ...(contentType ? { contentType } : {}),
      }),
    });
    if (!res.ok) throw new Error(await readError(res, '生成签名地址失败'));
    try {
      const json = (await res.json()) as { ok?: boolean; data?: { url?: string } };
      const url = json?.data?.url;
      if (!url) throw new Error('服务端未返回签名地址');
      return url;
    } catch (e) {
      if (e instanceof Error && e.message === '服务端未返回签名地址') throw e;
      throw new Error('签名地址响应解析失败');
    }
  }

  async presignGet(key: string, expiresSeconds = 3600): Promise<string> {
    return this.presign(key, 'GET', expiresSeconds);
  }

  async presignPut(key: string, expiresSeconds = 3600, contentType?: string): Promise<string> {
    return this.presign(key, 'PUT', expiresSeconds, contentType);
  }

  /* ------------------------------ 公开地址 ------------------------------ */

  /**
   * 平台桶通常是私有的，直链没有签名会 403，
   * 因此这里返回**带登录态的代理地址**：`/api/storage/object?key=...`。
   * 注意它不是真正公开的——访问时仍需登录，语义上更接近「可分享给你自己的链接」。
   */
  publicUrl(key: string): string {
    return this.transport.resolveUrl(`${this.basePath}/object?key=${q(this.toRelative(key))}`);
  }
}

export default { RemoteProxyStorageClient };
