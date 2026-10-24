/**
 * 最小 S3 兼容服务，用于端到端验证同步引擎。
 * 支持 ListObjectsV2 / PUT / GET / HEAD / DELETE，并在服务端校验 SigV4 签名。
 */
const http = require('http');
const crypto = require('crypto');

const ACCESS_KEY = 'TESTACCESSKEY';
const SECRET_KEY = 'TESTSECRETKEY0123456789';
const REGION = 'us-east-1';
const BUCKET = 'notes';

/** 内存对象存储 */
const store = new Map(); // key -> { body: Buffer, etag, lastModified }

const log = [];

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else {
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** 服务端 SigV4 校验 */
function verifySignature(req, bodyBuf) {
  const auth = req.headers['authorization'];
  if (!auth) return { ok: false, reason: 'missing authorization' };

  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return { ok: false, reason: 'bad authorization format' };

  const [, ak, dateStamp, region, service, signedHeaders, providedSig] = m;
  if (ak !== ACCESS_KEY) return { ok: false, reason: 'bad access key' };
  if (region !== REGION) return { ok: false, reason: `bad region: ${region}` };

  const amzDate = req.headers['x-amz-date'];
  const payloadHashHeader = req.headers['x-amz-content-sha256'];
  if (!amzDate) return { ok: false, reason: 'missing x-amz-date' };

  // 校验负载哈希
  const actualPayloadHash = sha256Hex(bodyBuf);
  if (payloadHashHeader && payloadHashHeader !== actualPayloadHash) {
    return { ok: false, reason: `payload hash mismatch: header=${payloadHashHeader} actual=${actualPayloadHash}` };
  }

  // 重建规范请求
  const url = new URL(req.url, `http://${req.headers.host}`);
  const canonicalUri = url.pathname;

  const qEntries = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = qEntries.map(([k, v]) => `${k}=${v}`).join('&');

  const headerNames = signedHeaders.split(';');
  const canonicalHeaders = headerNames
    .map((h) => {
      const v = h === 'host' ? req.headers.host : req.headers[h];
      return `${h}:${String(v ?? '').trim()}\n`;
    })
    .join('');

  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    actualPayloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  let k = Buffer.from('AWS4' + SECRET_KEY, 'utf8');
  for (const p of [dateStamp, region, service, 'aws4_request']) k = hmac(k, p);
  const expected = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');

  if (expected !== providedSig) {
    return {
      ok: false,
      reason: `signature mismatch: expected=${expected} provided=${providedSig}`,
      canonicalRequest,
    };
  }
  return { ok: true };
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function listXml(prefix, objects) {
  const items = objects
    .filter((o) => o.key.startsWith(prefix))
    .map(
      (o) => `<Contents><Key>${xmlEscape(o.key)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${objects.filter((o) => o.key.startsWith(prefix)).length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`;
}

function start(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // CORS：允许任意来源（真实部署时应收紧到具体域名）
      res.setHeader('access-control-allow-origin', req.headers.origin || '*');
      res.setHeader('access-control-allow-methods', 'GET, PUT, HEAD, DELETE, OPTIONS');
      res.setHeader(
        'access-control-allow-headers',
        'authorization, content-type, x-amz-date, x-amz-content-sha256, x-amz-security-token, range',
      );
      res.setHeader('access-control-expose-headers', 'etag, content-length, last-modified, x-amz-request-id');
      res.setHeader('access-control-max-age', '3600');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, `http://${req.headers.host}`);

        // 路径风格：/bucket/key...
        const pathParts = url.pathname.split('/').filter(Boolean);
        const bucketFromPath = pathParts[0];
        const key = decodeURIComponent(pathParts.slice(1).join('/'));

        const entry = {
          method: req.method,
          path: url.pathname,
          query: url.search,
          key,
          size: body.length,
        };

        // 验签
        const verdict = verifySignature(req, body);
        entry.auth = verdict.ok ? 'ok' : 'FAIL: ' + verdict.reason;
        log.push(entry);

        if (!verdict.ok) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          res.end(
            `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>${xmlEscape(verdict.reason)}</Message></Error>`,
          );
          return;
        }

        if (bucketFromPath !== BUCKET) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>');
          return;
        }

        // ListObjectsV2
        if (req.method === 'GET' && key === '') {
          const prefix = url.searchParams.get('prefix') || '';
          const objects = [...store.entries()].map(([k, v]) => ({ key: k, ...v }));
          const xml = listXml(prefix, objects);
          res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(xml) });
          res.end(xml);
          return;
        }

        if (req.method === 'PUT') {
          const etag = crypto.createHash('md5').update(body).digest('hex');
          store.set(key, { body, etag, lastModified: Date.now() });
          res.writeHead(200, { etag: `"${etag}"` });
          res.end();
          return;
        }

        if (req.method === 'HEAD') {
          const obj = store.get(key);
          if (!obj) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, {
            etag: `"${obj.etag}"`,
            'content-length': obj.body.length,
            'last-modified': new Date(obj.lastModified).toUTCString(),
          });
          res.end();
          return;
        }

        if (req.method === 'GET') {
          const obj = store.get(key);
          if (!obj) {
            res.writeHead(404, { 'content-type': 'application/xml' });
            res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>');
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/markdown',
            'content-length': obj.body.length,
            etag: `"${obj.etag}"`,
          });
          res.end(obj.body);
          return;
        }

        if (req.method === 'DELETE') {
          store.delete(key);
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(405);
        res.end();
      });
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        store,
        log,
        config: {
          endpoint: `http://127.0.0.1:${addr.port}`,
          region: REGION,
          bucket: BUCKET,
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
          forcePathStyle: true,
        },
      });
    });
  });
}

module.exports = { start, store, log };

if (require.main === module) {
  start(9000).then((s) => {
    console.log('mock S3 listening on', s.port);
  });
}
