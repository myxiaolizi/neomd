/**
 * 六家对象存储 + 自定义 S3 的统一客户端。
 *
 * 服务端/桌面端使用 AWS Signature V4 直连；浏览器端不持有 Secret，
 * 由 `RemoteProxyStorageClient` 走服务端代理（见 proxy-client.ts）。
 */

import type { StorageConfig } from '@neomd/shared';
import type { S3ObjectMeta, StorageClient } from './types';

const textEncoder = new TextEncoder();

export function sha256HexSync(bytes: Uint8Array): string {
  // 同步实现：SHA-256（无 SubtleCrypto 依赖，浏览器/Node 通用）
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  const rr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rr(w[i - 15]!, 7) ^ rr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rr(w[i - 2]!, 17) ^ rr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0]!, H[1]!, H[2]!, H[3]!, H[4]!, H[5]!, H[6]!, H[7]!];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  let hex = '';
  for (const v of H) hex += v.toString(16).padStart(8, '0');
  return hex;
}

export function hmacSha256(key: Uint8Array, data: string): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = hexToBytes(sha256HexSync(k));
  const padded = new Uint8Array(blockSize);
  padded.set(k);
  const oKey = new Uint8Array(blockSize);
  const iKey = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    oKey[i] = padded[i]! ^ 0x5c;
    iKey[i] = padded[i]! ^ 0x36;
  }
  const inner = sha256Bytes(concat(iKey, textEncoder.encode(data)));
  return sha256Bytes(concat(oKey, inner));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return hexToBytes(sha256HexSync(bytes));
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += ch;
    } else {
      const bytes = textEncoder.encode(ch);
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function amzDate(d: Date): { long: string; short: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long: iso, short: iso.slice(0, 8) };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface SignOptions {
  method: string;
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  date?: Date;
}

export function signRequestV4(config: StorageConfig, opts: SignOptions): SignedRequest {
  const date = opts.date ?? new Date();
  const { long, short } = amzDate(date);
  const region = config.region || 'us-east-1';
  const service = 's3';

  const endpoint = config.endpoint.replace(/\/+$/, '');
  const u = new URL(endpoint);
  const useVirtualHost = config.urlStyle === 'virtual-hosted';
  let host: string;
  let pathPrefix: string;
  if (useVirtualHost) {
    host = `${config.bucket}.${u.host}`;
    pathPrefix = '';
  } else {
    host = u.host;
    pathPrefix = `/${config.bucket}`;
  }

  const canonicalUri = `${pathPrefix}/${uriEncode(opts.key, false)}`.replace(/\/{2,}/g, '/');
  const query = new URLSearchParams();
  const sortedQueryKeys = Object.keys(opts.query ?? {}).sort();
  for (const k of sortedQueryKeys) query.set(k, opts.query![k]!);
  const canonicalQuery = sortedQueryKeys.map((k) => `${uriEncode(k)}=${uriEncode(query.get(k) ?? '')}`).join('&');

  const headers: Record<string, string> = {
    host,
    'x-amz-date': long,
    'x-amz-content-sha256': opts.payloadHash,
    ...opts.headers,
  };
  const signedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${lower[k] ?? ''}\n`).join('');
  const signedHeaders = signedHeaderKeys.join(';');

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n');

  const credentialScope = `${short}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', long, credentialScope, sha256HexSync(textEncoder.encode(canonicalRequest))].join('\n');

  let signingKey = hmacSha256(textEncoder.encode(`AWS4${config.accessKeySecret}`), short);
  signingKey = hmacSha256(signingKey, region);
  signingKey = hmacSha256(signingKey, service);
  signingKey = hmacSha256(signingKey, 'aws4_request');
  const signature = toHex(hmacSha256(signingKey, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const finalHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) finalHeaders[k] = v;
  finalHeaders.authorization = authorization;

  const url = `${u.protocol}//${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return { url, headers: finalHeaders };
}

function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1] ?? ''));
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseListXml(xml: string): S3ObjectMeta[] {
  const out: S3ObjectMeta[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRe.exec(xml))) {
    const block = m[1] ?? '';
    out.push({
      key: xmlValues(block, 'Key')[0] ?? '',
      size: Number(xmlValues(block, 'Size')[0] ?? 0),
      etag: (xmlValues(block, 'ETag')[0] ?? '').replace(/"/g, ''),
      lastModified: new Date(xmlValues(block, 'LastModified')[0] ?? 0).getTime(),
    });
  }
  return out;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class S3StorageClient implements StorageClient {
  constructor(public readonly config: StorageConfig) {}

  private async request(
    method: string,
    key: string,
    body?: Uint8Array,
    query?: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const payload = body ?? new Uint8Array(0);
    const payloadHash = body ? sha256HexSync(body) : EMPTY_SHA256;
    const headers: Record<string, string> = { ...extraHeaders };
    if (body) headers['content-length'] = String(body.length);
    const signed = signRequestV4(this.config, { method, key, query, headers, payloadHash });
    const init: RequestInit = { method, headers: signed.headers };
    if (body && method !== 'GET' && method !== 'HEAD') init.body = body as unknown as BodyInit;
    return fetch(signed.url, init);
  }

  async putObject(key: string, body: Uint8Array | string, contentType = 'application/octet-stream'): Promise<void> {
    const bytes = typeof body === 'string' ? textEncoder.encode(body) : body;
    const res = await this.request('PUT', key, bytes, undefined, { 'content-type': contentType });
    if (!res.ok) throw new Error(`上传失败 ${res.status}: ${await safeText(res)}`);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const res = await this.request('GET', key);
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${await safeText(res)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getObjectText(key: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.getObject(key));
  }

  async headObject(key: string): Promise<S3ObjectMeta | null> {
    const res = await this.request('HEAD', key);
    if (!res.ok) return null;
    return {
      key,
      size: Number(res.headers.get('content-length') ?? 0),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      lastModified: new Date(res.headers.get('last-modified') ?? 0).getTime(),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`删除失败 ${res.status}: ${await safeText(res)}`);
  }

  async listObjects(prefix: string, maxKeys = 1000): Promise<S3ObjectMeta[]> {
    const res = await this.request('GET', '', undefined, {
      'list-type': '2',
      prefix,
      'max-keys': String(maxKeys),
    });
    if (!res.ok) throw new Error(`列举失败 ${res.status}: ${await safeText(res)}`);
    return parseListXml(await res.text());
  }

  async presignGet(key: string, expiresSeconds = 3600): Promise<string> {
    return this.presign('GET', key, expiresSeconds);
  }

  async presignPut(key: string, expiresSeconds = 3600, contentType?: string): Promise<string> {
    return this.presign('PUT', key, expiresSeconds, contentType);
  }

  private presign(method: string, key: string, expires: number, contentType?: string): string {
    const date = new Date();
    const { long, short } = amzDate(date);
    const region = this.config.region || 'us-east-1';
    const u = new URL(this.config.endpoint.replace(/\/+$/, ''));
    const useVirtualHost = this.config.urlStyle === 'virtual-hosted';
    const host = useVirtualHost ? `${this.config.bucket}.${u.host}` : u.host;
    const pathPrefix = useVirtualHost ? '' : `/${this.config.bucket}`;
    const canonicalUri = `${pathPrefix}/${uriEncode(key, false)}`.replace(/\/{2,}/g, '/');
    const credentialScope = `${short}/${region}/s3/aws4_request`;
    const q: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': String(Math.min(expires, 604800)),
      'X-Amz-SignedHeaders': 'host',
    };
    if (method !== 'GET') q['X-Amz-SignedHeaders'] = 'host';
    const queryKeys = Object.keys(q).sort();
    const canonicalQuery = queryKeys.map((k) => `${uriEncode(k)}=${uriEncode(q[k]!)}`).join('&');
    const canonicalHeaders = `host:${host}\n`;
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, q['X-Amz-SignedHeaders'], 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', long, credentialScope, sha256HexSync(textEncoder.encode(canonicalRequest))].join('\n');
    let signingKey = hmacSha256(textEncoder.encode(`AWS4${this.config.accessKeySecret}`), short);
    signingKey = hmacSha256(signingKey, region);
    signingKey = hmacSha256(signingKey, 's3');
    signingKey = hmacSha256(signingKey, 'aws4_request');
    const signature = toHex(hmacSha256(signingKey, stringToSign));
    const extra = contentType ? `&x-content-type=${encodeURIComponent(contentType)}` : '';
    return `${u.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}${extra}`;
  }

  publicUrl(key: string): string {
    const clean = key.replace(/^\/+/, '');
    if (this.config.publicDomain) {
      const base = this.config.publicDomain.replace(/\/+$/, '');
      const prefix = this.config.urlStyle === 'path' ? `/${this.config.bucket}` : '';
      return `${base}${prefix}/${clean}`;
    }
    const u = new URL(this.config.endpoint.replace(/\/+$/, ''));
    if (this.config.urlStyle === 'virtual-hosted') {
      return `${u.protocol}//${this.config.bucket}.${u.host}/${clean}`;
    }
    return `${u.protocol}//${u.host}/${this.config.bucket}/${clean}`;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return '';
  }
}

/** 连通性自检：依次验证列举/写入/读取/删除 */
export async function probeStorage(config: StorageConfig, prefix = 'mdadmin/probe/'): Promise<{
  ok: boolean;
  canList: boolean;
  canPut: boolean;
  canGet: boolean;
  canDelete: boolean;
  latencyMs: number;
  message: string;
}> {
  const client = new S3StorageClient(config);
  const started = Date.now();
  let canList = false;
  let canPut = false;
  let canGet = false;
  let canDelete = false;
  const errors: string[] = [];
  try {
    await client.listObjects(prefix, 1);
    canList = true;
  } catch (e) {
    errors.push(`列举: ${(e as Error).message}`);
  }
  const key = `${prefix}probe-${Date.now()}.txt`;
  try {
    await client.putObject(key, 'neomd-probe', 'text/plain');
    canPut = true;
  } catch (e) {
    errors.push(`写入: ${(e as Error).message}`);
  }
  if (canPut) {
    try {
      const text = await client.getObjectText(key);
      canGet = text === 'neomd-probe';
      if (!canGet) errors.push('读取内容不一致');
    } catch (e) {
      errors.push(`读取: ${(e as Error).message}`);
    }
    try {
      await client.deleteObject(key);
      canDelete = true;
    } catch (e) {
      errors.push(`删除: ${(e as Error).message}`);
    }
  }
  return {
    ok: canList && canPut && canGet,
    canList,
    canPut,
    canGet,
    canDelete,
    latencyMs: Date.now() - started,
    message: errors.length ? errors.join('；') : '连接正常',
  };
}
