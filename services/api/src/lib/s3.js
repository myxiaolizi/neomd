/**
 * 纯 node:crypto 实现的 AWS Signature V4 S3 客户端。
 * 支持阿里云 OSS / 腾讯云 COS / 火山 TOS / 百度 BOS / 自定义 S3 等 S3 兼容服务，
 * 默认虚拟主机风格：https://<bucket>.<endpoint-host>/<key>。
 */
import crypto from 'node:crypto';

const SERVICE = 's3';
const REGION_FALLBACK = 'us-east-1';
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DEFAULT_TIMEOUT = 30_000;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function toHex(buffer) {
  return buffer.toString('hex');
}

/** 2024-01-02T03:04:05.678Z -> { long: 20240102T030405Z, short: 20240102 } */
function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { long: iso, short: iso.slice(0, 8) };
}

/** SigV4 / S3 规范要求的编码方式 */
function uriEncode(input, encodeSlash = true) {
  const text = String(input ?? '');
  let out = '';
  for (const ch of text) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += '/';
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** 对象键 -> 规范化 URI 路径 */
function encodeKeyPath(key) {
  const clean = String(key ?? '').replace(/^\/+/, '');
  if (clean === '') return '/';
  return `/${clean.split('/').map((seg) => uriEncode(seg, false)).join('/')}`;
}

/**
 * 补齐 endpoint 协议并去掉尾部斜杠。
 * 用户常只填 `oss-cn-guangzhou.aliyuncs.com`，这里统一补成 https。
 */
function normalizeEndpoint(raw) {
  const endpoint = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  if (endpoint.startsWith('//')) return `https:${endpoint}`; // 协议相对地址
  if (!/^https?:\/\//i.test(endpoint)) return `https://${endpoint}`;
  return endpoint;
}

/**
 * 识别阿里云 OSS 域名。
 *  - `oss-cn-guangzhou.aliyuncs.com`：OSS 原生域名（默认虚拟主机风格）
 *  - `s3.oss-cn-guangzhou.aliyuncs.com`：OSS 的 S3 兼容端点（不支持 path 风格）
 * @returns {{ aliyun: boolean, s3Compat: boolean, region: string|null }}
 */
function parseAliyunHost(host) {
  const s3Match = /^s3\.oss-([a-z0-9-]+)\.aliyuncs\.com$/i.exec(host);
  if (s3Match) return { aliyun: true, s3Compat: true, region: s3Match[1] };
  const nativeMatch = /^oss-([a-z0-9-]+)\.aliyuncs\.com$/i.exec(host);
  if (nativeMatch) return { aliyun: true, s3Compat: false, region: nativeMatch[1] };
  return { aliyun: false, s3Compat: false, region: null };
}

/**
 * 规范化配置：同时兼容 accessKeyId/accessKeySecret 与 ak/sk 两种写法。
 *
 * 额外做三件事（均有中文 warnings 说明）：
 *  1. endpoint 缺少 http(s) 协议时自动补 https://，并去掉尾部斜杠；
 *  2. region 为空时，从阿里云域名中解析地域（oss-cn-guangzhou → cn-guangzhou）；
 *  3. 阿里云 S3 兼容端点必须用虚拟主机风格，用户误选 path 时自动纠正。
 */
export function normalizeConfig(input = {}) {
  const warnings = [];
  const endpoint = normalizeEndpoint(input.endpoint || input.ossEndpoint || '');
  const explicitStyle = input.urlStyle === 'path' || input.urlStyle === 'virtual-hosted';
  let urlStyle = input.urlStyle === 'path' ? 'path' : 'virtual-hosted';
  let region = String(input.region || input.ossRegion || '').trim();

  if (endpoint) {
    let host = '';
    try {
      host = new URL(endpoint).hostname;
    } catch {
      throw new Error(`endpoint 格式不正确（${endpoint}），请填写域名或完整地址，例如 oss-cn-guangzhou.aliyuncs.com`);
    }
    const aliyun = parseAliyunHost(host);
    if (!region && aliyun.region) region = aliyun.region;
    // 阿里云 S3 兼容端点用 path 风格会被拒绝（SecondLevelDomainForbidden），直接纠正
    if (urlStyle === 'path' && aliyun.s3Compat) {
      urlStyle = 'virtual-hosted';
      warnings.push('阿里云 S3 兼容端点不支持路径风格（path），已自动切换为虚拟主机风格（virtual-hosted）');
    }
  }

  const cfg = {
    endpoint,
    region: region || REGION_FALLBACK,
    bucket: String(input.bucket || input.ossBucket || '').trim(),
    accessKeyId: String(input.accessKeyId || input.ak || input.accessKey || '').trim(),
    accessKeySecret: String(input.accessKeySecret || input.sk || input.secretAccessKey || '').trim(),
    publicDomain: normalizeEndpoint(input.publicDomain || input.publicUrl || ''),
    urlStyle,
    basePrefix: String(input.basePrefix || input.prefix || ''),
    useTls: input.useTls === undefined ? true : Boolean(input.useTls),
    isPrivate: Boolean(input.isPrivate),
    sessionToken: input.sessionToken ? String(input.sessionToken) : '',
    timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT,
    // 新增可选字段：调用方可据此提示用户“已自动纠正配置”，老调用方忽略即可
    warnings,
    urlStyleExplicit: explicitStyle,
  };
  if (!cfg.endpoint) throw new Error('对象存储缺少 endpoint 配置');
  if (!cfg.bucket) throw new Error('对象存储缺少 bucket 配置');
  if (!cfg.accessKeyId || !cfg.accessKeySecret) throw new Error('对象存储缺少访问密钥');
  return cfg;
}

/** 解析出真实请求主机与路径前缀 */
function resolveTarget(cfg) {
  const url = new URL(cfg.endpoint);
  const protocol = cfg.useTls ? 'https:' : url.protocol === 'https:' ? 'https:' : 'http:';
  if (cfg.urlStyle === 'path') {
    return { protocol, host: url.host, pathPrefix: `/${cfg.bucket}` };
  }
  return { protocol, host: `${cfg.bucket}.${url.host}`, pathPrefix: '' };
}

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

/**
 * 计算 SigV4 签名。
 * @returns {{ url: string, headers: Record<string,string> }}
 */
export function signRequest(cfg, options) {
  const target = resolveTarget(cfg);
  const now = options.date instanceof Date ? options.date : new Date();
  const { long, short } = amzDate(now);
  const region = cfg.region || REGION_FALLBACK;
  const keyPath = encodeKeyPath(options.key);
  const canonicalUri = `${target.pathPrefix}${keyPath}`.replace(/\/{2,}/g, '/') || '/';

  const query = options.query ?? {};
  const queryKeys = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null)
    .sort();
  const canonicalQuery = queryKeys
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  const rawHeaders = {
    host: target.host,
    'x-amz-date': long,
    'x-amz-content-sha256': options.payloadHash,
    ...(options.headers ?? {}),
  };
  const headerNames = Object.keys(rawHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const lowerHeaders = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    lowerHeaders[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const canonicalHeaders = headerNames.map((name) => `${name}:${lowerHeaders[name] ?? ''}\n`).join('');
  const signedHeaders = headerNames.join(';');

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join('\n');

  const credentialScope = `${short}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    long,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  let signingKey = hmacSha256(Buffer.from(`AWS4${cfg.accessKeySecret}`, 'utf8'), short);
  signingKey = hmacSha256(signingKey, region);
  signingKey = hmacSha256(signingKey, SERVICE);
  signingKey = hmacSha256(signingKey, 'aws4_request');
  const signature = toHex(hmacSha256(signingKey, stringToSign));

  const headers = { ...lowerHeaders };
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${target.protocol}//${target.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return { url, headers };
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

async function doFetch(cfg, url, init, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err?.name === 'AbortError' ? `请求超时（${Math.round(cfg.timeoutMs / 1000)} 秒）` : err?.message || String(err);
    const wrapped = new Error(`${what}失败：${reason}`);
    // 标记网络层失败，供上层区分「没连上」与「连上了但被拒绝」
    wrapped.isNetwork = true;
    wrapped.networkReason = reason;
    wrapped.cause = err;
    throw wrapped;
  }
  clearTimeout(timer);
  return res;
}

async function readSnippet(res) {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/** 从 S3 错误 XML 中提取错误码与错误描述 */
function parseS3Error(xml) {
  const text = String(xml ?? '');
  const code = /<Code>([\s\S]*?)<\/Code>/i.exec(text)?.[1] ?? '';
  const message = /<Message>([\s\S]*?)<\/Message>/i.exec(text)?.[1] ?? '';
  return { code: decodeXml(code).trim(), message: decodeXml(message).trim() };
}

/** 常见 S3 错误码对应的中文排查建议 */
const S3_ERROR_HINTS = {
  AccessDenied: '请检查 AccessKey 权限或 Bucket 归属',
  InvalidAccessKeyId: 'AccessKey ID 不存在或已被禁用',
  SignatureDoesNotMatch: 'AccessKey Secret 不正确，或 region 与 Bucket 所在地域不一致',
  NoSuchBucket: 'Bucket 不存在，请检查名称与地域',
  NoSuchKey: '对象不存在',
  SecondLevelDomainForbidden: '该端点不支持路径风格（path），请改为虚拟主机风格（virtual-hosted）',
  InvalidBucketName: 'Bucket 名称不合法',
  BucketNotEmpty: 'Bucket 非空，无法执行该操作',
  RequestTimeTooSkewed: '服务器时间与对象存储偏差过大，请校准系统时间',
  PermanentRedirect: 'endpoint 与 Bucket 所在地域不匹配',
  EntityTooLarge: '对象体积超出限制',
  InvalidArgument: '请求参数不合法',
  KmsAccessDenied: 'Bucket 已开启 KMS 加密但密钥权限不足',
};

/**
 * 构造带状态码与 S3 错误码的异常。
 * message 已是可读中文，且只保留 120 字符摘要，不会把整段 XML 抛给用户。
 */
async function responseError(res, what) {
  const snippet = await readSnippet(res);
  const { code, message } = parseS3Error(snippet);
  const hint = S3_ERROR_HINTS[code] ?? '';
  const summary = String(message || snippet || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  let text = `${what}失败：HTTP ${res.status}`;
  if (code) text += `（${code}${hint ? `，${hint}` : ''}）`;
  if (summary) text += `：${summary}`;
  const err = new Error(text);
  err.status = res.status;
  err.s3Code = code;
  err.s3Message = message;
  err.snippet = summary;
  return err;
}

async function send(cfg, { method, key, query, headers, body, contentType, what }) {
  const payload = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const payloadHash = payload.length === 0 ? EMPTY_PAYLOAD_SHA256 : sha256Hex(payload);
  const extraHeaders = { ...(headers ?? {}) };
  if (contentType) extraHeaders['content-type'] = contentType;
  // content-length 交给运行时自动填充，不参与签名，避免与分块传输冲突
  const signed = signRequest(cfg, {
    method,
    key,
    query,
    headers: extraHeaders,
    payloadHash,
  });
  const init = { method, headers: signed.headers };
  if (payload.length > 0 && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    init.body = payload;
  }
  const res = await doFetch(cfg, signed.url, init, what);
  return { res, payloadHash };
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 上传对象
 * @param {object} [options]
 * @param {string} [options.acl] 对象 ACL，如 public-read
 * @param {Record<string,string>} [options.headers] 额外请求头
 */
export async function putObject(cfgInput, key, body, contentType = 'application/octet-stream', options = {}) {
  const cfg = normalizeConfig(cfgInput);
  const extraHeaders = { ...(options.headers ?? {}) };
  if (options.acl) extraHeaders['x-amz-acl'] = options.acl;
  const { res } = await send(cfg, {
    method: 'PUT',
    key,
    body,
    contentType,
    headers: extraHeaders,
    what: '上传',
  });
  if (!res.ok) throw await responseError(res, '上传');
  return {
    key,
    etag: (res.headers.get('etag') || '').replace(/"/g, ''),
    url: publicUrl(cfg, key),
  };
}

/** 下载对象（Buffer） */
export async function getObject(cfgInput, key) {
  const cfg = normalizeConfig(cfgInput);
  const { res } = await send(cfg, { method: 'GET', key, what: '下载' });
  if (!res.ok) throw await responseError(res, '下载');
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    key,
    buffer,
    size: buffer.length,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    etag: (res.headers.get('etag') || '').replace(/"/g, ''),
    lastModified: res.headers.get('last-modified') || null,
  };
}

/** 下载对象文本 */
export async function getObjectText(cfgInput, key) {
  const obj = await getObject(cfgInput, key);
  return obj.buffer.toString('utf8');
}

/** 对象元信息，不存在返回 null */
export async function headObject(cfgInput, key) {
  const cfg = normalizeConfig(cfgInput);
  const { res } = await send(cfg, { method: 'HEAD', key, what: '读取对象信息' });
  if (res.status === 404) return null;
  if (!res.ok) throw await responseError(res, '读取对象信息');
  return {
    key,
    size: Number(res.headers.get('content-length') || 0),
    etag: (res.headers.get('etag') || '').replace(/"/g, ''),
    contentType: res.headers.get('content-type') || null,
    lastModified: res.headers.get('last-modified') || null,
  };
}

/** 删除对象（不存在视为成功） */
export async function deleteObject(cfgInput, key) {
  const cfg = normalizeConfig(cfgInput);
  const { res } = await send(cfg, { method: 'DELETE', key, what: '删除' });
  if (!res.ok && res.status !== 404) throw await responseError(res, '删除');
  return { key, deleted: true };
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlValues(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let match;
  while ((match = re.exec(xml))) out.push(decodeXml(match[1] ?? ''));
  return out;
}

/** 列举对象（ListObjectsV2） */
export async function listObjects(cfgInput, prefix = '', maxKeys = 1000) {
  const cfg = normalizeConfig(cfgInput);
  const { res } = await send(cfg, {
    method: 'GET',
    key: '',
    query: {
      'list-type': '2',
      prefix,
      'max-keys': String(Math.min(Math.max(1, Number(maxKeys) || 1000), 1000)),
    },
    what: '列举',
  });
  if (!res.ok) throw await responseError(res, '列举');
  const xml = await res.text();
  const objects = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1] ?? '';
    objects.push({
      key: xmlValues(block, 'Key')[0] ?? '',
      size: Number(xmlValues(block, 'Size')[0] ?? 0),
      etag: (xmlValues(block, 'ETag')[0] ?? '').replace(/"/g, ''),
      lastModified: xmlValues(block, 'LastModified')[0] ?? null,
    });
  }
  return {
    objects,
    truncated: /<IsTruncated>true<\/IsTruncated>/i.test(xml),
    nextToken: xmlValues(xml, 'NextContinuationToken')[0] ?? null,
    prefix,
  };
}

/**
 * 生成预签名 URL。
 * @param {'GET'|'PUT'} method
 */
export function presign(cfgInput, method, key, expiresSeconds = 3600) {
  const cfg = normalizeConfig(cfgInput);
  const target = resolveTarget(cfg);
  const now = new Date();
  const { long, short } = amzDate(now);
  const region = cfg.region || REGION_FALLBACK;
  const keyPath = encodeKeyPath(key);
  const canonicalUri = `${target.pathPrefix}${keyPath}`.replace(/\/{2,}/g, '/') || '/';
  const credentialScope = `${short}/${region}/${SERVICE}/aws4_request`;
  const signedHeaders = 'host';
  const expires = Math.min(Math.max(1, Number(expiresSeconds) || 3600), 604800);

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': long,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (cfg.sessionToken) query['X-Amz-Security-Token'] = cfg.sessionToken;

  const queryKeys = Object.keys(query).sort();
  const canonicalQuery = queryKeys.map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');
  const canonicalHeaders = `host:${target.host}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    long,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  let signingKey = hmacSha256(Buffer.from(`AWS4${cfg.accessKeySecret}`, 'utf8'), short);
  signingKey = hmacSha256(signingKey, region);
  signingKey = hmacSha256(signingKey, SERVICE);
  signingKey = hmacSha256(signingKey, 'aws4_request');
  const signature = toHex(hmacSha256(signingKey, stringToSign));

  return `${target.protocol}//${target.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** 预签名下载地址 */
export function presignGet(cfgInput, key, expiresSeconds = 3600) {
  return presign(cfgInput, 'GET', key, expiresSeconds);
}

/** 预签名上传地址 */
export function presignPut(cfgInput, key, expiresSeconds = 3600) {
  return presign(cfgInput, 'PUT', key, expiresSeconds);
}

/** 公共访问地址 */
export function publicUrl(cfgInput, key) {
  const cfg = normalizeConfig(cfgInput);
  const path = encodeKeyPath(key).replace(/^\//, '');
  if (cfg.publicDomain) {
    const prefix = cfg.urlStyle === 'path' ? `/${cfg.bucket}` : '';
    return `${cfg.publicDomain}${prefix}/${path}`;
  }
  const target = resolveTarget(cfg);
  return `${target.protocol}//${target.host}${target.pathPrefix}/${path}`;
}

/** 把单步失败整理成可读中文（不暴露整段 XML） */
function describeStepFailure(label, err) {
  if (err?.status) {
    const hint = S3_ERROR_HINTS[err.s3Code] ?? '';
    const summary = String(err.s3Message || err.snippet || '').replace(/\s+/g, ' ').trim();
    let text = `${label}失败：HTTP ${err.status}`;
    if (err.s3Code) text += `（${err.s3Code}${hint ? `，${hint}` : ''}）`;
    if (summary) text += `：${summary.slice(0, 120)}`;
    return text;
  }
  const reason = err?.networkReason || err?.message || String(err);
  return `${label}失败：${reason}`;
}

/**
 * 连通性自检：依次验证 列举 / 写入 / 读取 / 删除，并逐步计时。
 * 写入成功后一定删除探针对象；写入报错也会尝试清理，避免污染用户 Bucket。
 */
export async function probeStorage(cfgInput, prefix = 'mdadmin/probe/') {
  const started = Date.now();
  const result = {
    ok: false,
    canList: false,
    canPut: false,
    canGet: false,
    canDelete: false,
    latencyMs: 0,
    message: '',
    steps: [],
    warnings: [],
  };

  let cfg;
  try {
    cfg = normalizeConfig(cfgInput);
  } catch (err) {
    result.latencyMs = Date.now() - started;
    result.message = `存储配置不完整：${err.message}`;
    return result;
  }
  result.warnings = Array.isArray(cfg.warnings) ? [...cfg.warnings] : [];

  const cleanPrefix = String(prefix ?? '').trim();
  const listPrefix = cleanPrefix === '' || cleanPrefix.endsWith('/') ? cleanPrefix : `${cleanPrefix}/`;
  const key = `${listPrefix}probe-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`;
  const content = 'neomd-probe';

  /**
   * 执行单步并记录结果。
   * @param {'list'|'put'|'get'|'delete'} name 步骤标识
   * @param {string} label 中文展示名
   * @param {() => Promise<unknown>} fn 实际动作
   */
  const runStep = async (name, label, fn) => {
    const stepStarted = Date.now();
    try {
      await fn();
      result.steps.push({ name, ok: true, message: `${label}成功`, latencyMs: Date.now() - stepStarted });
      return true;
    } catch (err) {
      result.steps.push({
        name,
        ok: false,
        message: describeStepFailure(label, err),
        latencyMs: Date.now() - stepStarted,
      });
      return false;
    }
  };

  result.canList = await runStep('list', '列举', () => listObjects(cfg, listPrefix, 1));
  result.canPut = await runStep('put', '写入', () => putObject(cfg, key, content, 'text/plain; charset=utf-8'));

  if (result.canPut) {
    result.canGet = await runStep('get', '读取', async () => {
      const text = await getObjectText(cfg, key);
      if (text !== content) throw new Error('读取到的内容与写入内容不一致，请检查是否被 CDN 或中间层改写');
    });
  }

  // 写入即使报错也可能已落盘，因此无论结果如何都尝试删除探针对象
  result.canDelete = await runStep('delete', result.canPut ? '删除' : '清理探针', () => deleteObject(cfg, key));

  result.latencyMs = Date.now() - started;
  const failed = result.steps.filter((step) => !step.ok);
  result.ok = result.canList && result.canPut && result.canGet && result.canDelete;
  if (result.ok) {
    result.message = '对象存储连通性正常：列举、写入、读取、删除全部通过';
  } else {
    // 总括只给第一条失败原因，避免同一原因在 message 里重复堆叠；完整明细看 steps
    const first = failed[0];
    result.message = `${first ? first.message : '连通性自检未通过'}${
      failed.length > 1 ? `（共 ${failed.length} 项未通过，详见 steps）` : ''
    }`;
  }
  return result;
}

export default {
  normalizeConfig,
  signRequest,
  putObject,
  getObject,
  getObjectText,
  headObject,
  deleteObject,
  listObjects,
  presign,
  presignGet,
  presignPut,
  publicUrl,
  probeStorage,
};
