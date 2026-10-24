import type { SyncSettings } from './types';

/** RFC3986 编码：保留 A-Za-z0-9-_.~，其余按 UTF-8 百分号编码 */
function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += '/';
    } else {
      const bytes = encoder.encode(ch);
      for (let i = 0; i < bytes.length; i++) {
        out += '%' + bytes[i].toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}
/** S3 对象条目 */
export interface S3Object {
  key: string;
  etag: string;
  size: number;
  lastModified: number;
}

export interface S3ListResult {
  objects: S3Object[];
  truncated: boolean;
  nextToken?: string;
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** XML 值反转义 */
function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 从 XML 中提取所有指定标签的内容 */
function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(unxml(m[1]));
  return out;
}

function xmlFirst(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unxml(m[1]) : undefined;
}

/** 十六进制字符串转 Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 取底层 ArrayBuffer，规避 ArrayBufferLike 的类型收窄问题 */
function bufOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bufOf(data));
  return bytesToHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    bufOf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, bufOf(encoder.encode(msg)));
  return new Uint8Array(sig);
}

/** 规范化时间戳 */
function amzDate(d: Date): { full: string; short: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full: iso, short: iso.slice(0, 8) };
}

/**
 * S3 客户端：SigV4 签名 + 虚拟主机/路径两种寻址。
 * 仅依赖 WebCrypto 与 fetch，Tauri 中同样可用。
 */
export class S3Client {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly pathStyle: boolean;
  private readonly basePath: string;

  constructor(private readonly cfg: SyncSettings) {
    let endpoint = cfg.endpoint.trim();
    if (!endpoint) throw new S3Error('未配置 Endpoint', 0);
    if (!/^https?:\/\//i.test(endpoint)) endpoint = 'https://' + endpoint;
    const u = new URL(endpoint);
    this.basePath = u.pathname.replace(/\/+$/, '');
    this.endpoint = `${u.protocol}//${u.host}`;
    this.region = cfg.region.trim() || 'us-east-1';
    this.bucket = cfg.bucket.trim();
    this.accessKeyId = cfg.accessKeyId.trim();
    this.secretAccessKey = cfg.secretAccessKey.trim();
    this.sessionToken = cfg.sessionToken?.trim() || undefined;
    this.pathStyle = cfg.forcePathStyle;
  }

  /** 主机头 */
  private host(): string {
    const u = new URL(this.endpoint);
    return this.pathStyle ? u.host : `${this.bucket}.${u.host}`;
  }

  /** 构造规范资源路径（已按 S3 规则编码） */
  private canonicalPath(key: string): string {
    const encodedKey = key
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => uriEncode(s, false))
      .join('/');

    if (this.pathStyle) {
      const parts = [this.basePath, this.bucket, encodedKey].filter(Boolean).join('/');
      return '/' + parts.replace(/^\/+/, '');
    }
    const parts = [this.basePath, encodedKey].filter(Boolean).join('/');
    return '/' + parts.replace(/^\/+/, '');
  }

  /** 发起签名请求 */
  private async request(
    method: string,
    key: string,
    opts: {
      query?: Record<string, string>;
      body?: Uint8Array;
      headers?: Record<string, string>;
      /** 期望二进制返回 */
      raw?: boolean;
    } = {},
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const { query = {}, body = new Uint8Array(0), headers: extra = {} } = opts;

    const canonicalUri = this.canonicalPath(key);
    const host = this.host();
    const { full: amzFull, short: amzShort } = amzDate(new Date());
    const payloadHash = await sha256Hex(body);

    // 参与签名的头
    const signHeaders: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzFull,
      ...(this.sessionToken ? { 'x-amz-security-token': this.sessionToken } : {}),
    };
    for (const [k, v] of Object.entries(extra)) {
      const lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'host' || lk === 'authorization') continue;
      signHeaders[lk] = String(v).trim();
    }

    // 规范查询串
    const qKeys = Object.keys(query).sort();
    const canonicalQuery = qKeys
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`)
      .join('&');

    // 规范头
    const hKeys = Object.keys(signHeaders).sort();
    const canonicalHeaders = hKeys.map((k) => `${k}:${signHeaders[k]}\n`).join('');
    const signedHeaders = hKeys.join(';');

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${amzShort}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzFull,
      scope,
      await sha256Hex(encoder.encode(canonicalRequest)),
    ].join('\n');

    let signingKey: Uint8Array = encoder.encode('AWS4' + this.secretAccessKey);
    for (const part of [amzShort, this.region, 's3', 'aws4_request']) {
      signingKey = await hmac(signingKey, part);
    }
    const signature = bytesToHex(await hmac(signingKey, stringToSign));

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `${this.endpoint}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;

    const reqHeaders: Record<string, string> = {
      ...signHeaders,
      authorization,
    };
    delete reqHeaders.host;

    let res: Response;
    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers: reqHeaders,
        body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new S3Error(
        `网络请求失败：${msg}。若在浏览器中使用，请确认存储桶已配置 CORS 允许当前来源。`,
        0,
      );
    }

    const buf = new Uint8Array(await res.arrayBuffer());

    if (res.status >= 400) {
      const text = decoder.decode(buf);
      const code = xmlFirst(text, 'Code');
      const message = xmlFirst(text, 'Message');
      throw new S3Error(
        `S3 ${res.status}${code ? ` ${code}` : ''}${message ? `：${message}` : ''}`,
        res.status,
        code,
      );
    }

    return { status: res.status, headers: res.headers, body: buf };
  }

  /** 测试连通性 */
  async test(): Promise<void> {
    await this.list('', 1);
  }

  /** 列举对象 */
  async list(prefix: string, maxKeys = 1000, token?: string): Promise<S3ListResult> {
    const query: Record<string, string> = {
      'list-type': '2',
      prefix,
      'max-keys': String(maxKeys),
    };
    if (token) query['continuation-token'] = token;

    const res = await this.request('GET', '', { query });
    const xml = decoder.decode(res.body);

    const objects: S3Object[] = [];
    const blocks = xmlAll(xml, 'Contents');
    for (const block of blocks) {
      const key = xmlFirst(block, 'Key');
      if (!key) continue;
      objects.push({
        key,
        etag: (xmlFirst(block, 'ETag') ?? '').replace(/&quot;|"/g, ''),
        size: Number(xmlFirst(block, 'Size') ?? 0),
        lastModified: Date.parse(xmlFirst(block, 'LastModified') ?? '') || 0,
      });
    }

    const truncated = (xmlFirst(xml, 'IsTruncated') ?? 'false').toLowerCase() === 'true';
    const next = xmlFirst(xml, 'NextContinuationToken');
    return { objects, truncated, nextToken: truncated ? next : undefined };
  }

  /** 列举全部（自动翻页） */
  async listAll(prefix: string): Promise<S3Object[]> {
    const all: S3Object[] = [];
    let token: string | undefined;
    for (let i = 0; i < 200; i++) {
      const r = await this.list(prefix, 1000, token);
      all.push(...r.objects);
      if (!r.truncated || !r.nextToken) break;
      token = r.nextToken;
    }
    return all;
  }

  /** 上传对象 */
  async put(key: string, data: Uint8Array, contentType = 'text/markdown; charset=utf-8'): Promise<string> {
    const res = await this.request('PUT', key, {
      body: data,
      headers: {
        'content-type': contentType,
        'content-length': String(data.length),
      },
    });
    return (res.headers.get('etag') ?? '').replace(/"/g, '');
  }

  /** 上传文本 */
  async putText(key: string, text: string, contentType?: string): Promise<string> {
    return this.put(key, encoder.encode(text), contentType);
  }

  /** 下载对象，不存在返回 null */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.request('GET', key);
      return res.body;
    } catch (e) {
      if (e instanceof S3Error && (e.status === 404 || e.code === 'NoSuchKey')) return null;
      throw e;
    }
  }

  /** 下载文本 */
  async getText(key: string): Promise<string | null> {
    const buf = await this.get(key);
    return buf === null ? null : decoder.decode(buf);
  }

  /** 读取元信息，不存在返回 null */
  async head(key: string): Promise<{ etag: string; size: number; lastModified: number } | null> {
    try {
      const res = await this.request('HEAD', key);
      return {
        etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
        size: Number(res.headers.get('content-length') ?? 0),
        lastModified: Date.parse(res.headers.get('last-modified') ?? '') || 0,
      };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  /** 删除对象 */
  async remove(key: string): Promise<void> {
    try {
      await this.request('DELETE', key);
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return;
      throw e;
    }
  }

  /** 批量删除（最多 1000 个/次） */
  async removeMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      for (const k of chunk) {
        await this.remove(k);
      }
    }
  }
}

export { hexToBytes, bytesToHex };
