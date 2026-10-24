/**
 * AWS SigV4 签名正确性校验。
 * 使用 AWS 官方文档给出的测试向量（GET iam 的示例不适用 S3，
 * 因此这里用 S3 场景的已知向量 + 自洽性校验）。
 */
const { webcrypto } = require('crypto');

// 复刻 s3sig 逻辑用于独立验证
const enc = new TextEncoder();

function toHex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const d = await webcrypto.subtle.digest('SHA-256', bytes);
  return toHex(d);
}

async function hmac(key, data) {
  const k = await webcrypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await webcrypto.subtle.sign('HMAC', k, enc.encode(data));
  return new Uint8Array(sig);
}

function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else {
      const bytes = enc.encode(ch);
      for (let i = 0; i < bytes.length; i++) out += '%' + bytes[i].toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

async function sign({ method, canonicalPath, query = {}, headers, payload, region, service, accessKeyId, secretAccessKey, date }) {
  const amzDate =
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0') + 'T' +
    String(date.getUTCHours()).padStart(2, '0') +
    String(date.getUTCMinutes()).padStart(2, '0') +
    String(date.getUTCSeconds()).padStart(2, '0') + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256(payload);

  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim();
  h['x-amz-date'] = amzDate;
  h['x-amz-content-sha256'] = payloadHash;

  const qEntries = Object.entries(query)
    .map(([k, v]) => [uriEncode(k, false), uriEncode(String(v), false)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = qEntries.map(([k, v]) => `${k}=${v}`).join('&');

  const sortedKeys = Object.keys(h).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${h[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n');

  let key = enc.encode('AWS4' + secretAccessKey);
  for (const p of [dateStamp, region, service, 'aws4_request']) key = await hmac(key, p);
  const signature = toHex(await hmac(key, stringToSign));

  return { signature, canonicalRequest, stringToSign, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** AWS 官方 S3 签名测试向量（来自 AWS 文档的 "Example: GET Object"） */
async function officialVector() {
  const result = await sign({
    method: 'GET',
    canonicalPath: '/test.txt',
    query: {},
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payload: '',
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date(Date.UTC(2013, 4, 24)),
  });
  return result;
}

/** 用 AWS SDK 风格的独立实现交叉验证：分步手工计算 */
async function crossCheck() {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const dateStamp = '20130524';
  const region = 'us-east-1';
  const service = 's3';

  const kDate = await hmac(enc.encode('AWS4' + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');

  return {
    kDate: toHex(kDate),
    kRegion: toHex(kRegion),
    kService: toHex(kService),
    kSigning: toHex(kSigning),
  };
}

/** 验证 S3 编码规则 */
function checkEncoding() {
  const cases = [
    ['a b.md', 'a%20b.md'],
    ['中文.md', '%E4%B8%AD%E6%96%87.md'],
    ['a+b.md', 'a%2Bb.md'],
    ['a/b/c.md', 'a/b/c.md'],
    ['a~b_c-d.e', 'a~b_c-d.e'],
    ['a&b=c', 'a%26b%3Dc'],
  ];
  const results = cases.map(([input, expect]) => ({
    input,
    expect,
    actual: input.split('/').map((s) => uriEncode(s, false)).join('/'),
    ok: input.split('/').map((s) => uriEncode(s, false)).join('/') === expect,
  }));
  return results;
}

(async () => {
  const vec = await officialVector();
  const keys = await crossCheck();
  const encoding = checkEncoding();

  const out = {
    officialVector: {
      signature: vec.signature,
      authorization: vec.authorization,
    },
    signingKeys: keys,
    encoding,
    encodingAllOk: encoding.every((c) => c.ok),
  };
  console.log(JSON.stringify(out, null, 2));
})();
