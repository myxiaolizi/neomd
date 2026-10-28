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
}

export class RemoteProxyStorageClient implements StorageClient {
  private readonly basePath: string;
  private readonly maxObjectBytes: number;
  private readonly vaultId: string;

  constructor(
    private readonly transport: ProxyTransport,
    options: ProxyClientOptions = {},
  ) {
    this.basePath = (options.basePath ?? '/api/storage').replace(/\/+$/, '');
    this.maxObjectBytes = options.maxObjectBytes ?? 25 * 1024 * 1024;
    this.vaultId = options.vaultId ?? '';
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
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(key)}`, {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'application/octet-stream',
        'x-object-key': key,
        'x-object-content-type': contentType,
        }),
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(await readError(res, '上传失败'));
  }

  /* ------------------------------ 读取 ------------------------------ */

  async getObject(key: string): Promise<Uint8Array> {
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(key)}`, { method: 'GET', headers: this.headers() });
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
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(key)}`, { method: 'HEAD', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      // 网络/权限类错误向上抛，让 SyncEngine 记进 errors 而不是静默当作「对象不存在」
      throw new Error(await readError(res, '读取对象信息失败'));
    }
    return {
      key,
      // content-length 属于 CORS 安全列表头，浏览器可直接读
      size: Number(res.headers.get('content-length') ?? 0),
      // etag 非安全列表头，跨域下可能读不到；同步协议不依赖它，读不到就留空
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      lastModified: 0,
    };
  }

  /* ------------------------------ 删除 ------------------------------ */

  async deleteObject(key: string): Promise<void> {
    const res = await this.transport.fetch(`${this.basePath}/object?key=${q(key)}`, { method: 'DELETE', headers: this.headers() });
    // 404 视为已删除（幂等），与 S3StorageClient 一致
    if (!res.ok && res.status !== 404) throw new Error(await readError(res, '删除失败'));
  }

  /* ------------------------------ 列举 ------------------------------ */

  async listObjects(prefix: string, maxKeys = 1000): Promise<S3ObjectMeta[]> {
    const limit = Math.min(1000, Math.max(1, Math.trunc(maxKeys) || 1000));
    const res = await this.transport.fetch(
      `${this.basePath}/list?prefix=${q(prefix)}&maxKeys=${limit}`,
      { method: 'GET' },
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
      key: String(obj.key ?? ''),
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
        key,
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
    return this.transport.resolveUrl(`${this.basePath}/object?key=${q(key)}`);
  }
}

export default { RemoteProxyStorageClient };
