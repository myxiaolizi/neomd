/**
 * 发布客户端到 OSS 并开放 releases/ 前缀匿名读取。
 * 使用阿里云 OSS 原生 REST（V1 签名），因为对象级 ACL 在 S3 兼容端点不生效。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/**
 * 从环境变量读取必需凭据。
 *
 * 安全说明（1.1.8 修复）：此处历史上把**真实的阿里云 AK/SK 写成默认值**，
 * 一旦代码随 git 历史公开，凭据即永久泄露、只能吊销重建。
 * 现在不允许任何默认值，缺失就明确报错。
 *
 * 运行前请设置：
 *   PowerShell:  $env:OSS_AK='<ak>'; $env:OSS_SK='<sk>'
 *   bash:        export OSS_AK='<ak>' OSS_SK='<sk>'
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`缺少环境变量 ${name}。请先设置后再运行本脚本。`);
    process.exit(1);
  }
  return v.trim();
}

const AK = requireEnv('OSS_AK');
const SK = requireEnv('OSS_SK');
const BUCKET = 'zhengle';
const REGION = 'cn-guangzhou';
const HOST = `${BUCKET}.oss-${REGION}.aliyuncs.com`;
const CUSTOM_DOMAIN = 'https://mdadmin.zhengl.vip';
const PREFIX = 'mdadmin/releases/';

/**
 * OSS V1 签名。
 *
 * 注意：`?policy` / `?acl` 这类**子资源**必须计入 resource（形如 `/bucket/?policy`），
 * 否则服务端算出的 StringToSign 与客户端不一致，返回 SignatureDoesNotMatch。
 */
function ossSign(method, key, contentType = '', date = new Date().toUTCString(), extraHeaders = {}, subResource = '') {
  const canonicalizedOSSHeaders = Object.entries(extraHeaders)
    .map(([k, v]) => `${k.toLowerCase()}:${v}`)
    .sort()
    .join('\n');
  const base = key ? `/${BUCKET}/${key}` : `/${BUCKET}/`;
  const resource = subResource ? `${base}?${subResource}` : base;
  const sts = [method, '', contentType, date, (canonicalizedOSSHeaders ? canonicalizedOSSHeaders + '\n' : '') + resource].join('\n');
  const sig = crypto.createHmac('sha1', SK).update(sts, 'utf8').digest('base64');
  return `OSS ${AK}:${sig}`;
}

async function putObject(key, body, contentType) {
  const date = new Date().toUTCString();
  const auth = ossSign('PUT', key, contentType, date);
  const res = await fetch(`https://${HOST}/${key}`, {
    method: 'PUT',
    headers: { Authorization: auth, Date: date, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${key} 失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.headers.get('etag');
}

async function getObjectText(key) {
  const date = new Date().toUTCString();
  const auth = ossSign('GET', key, '', date);
  const res = await fetch(`https://${HOST}/${key}`, { headers: { Authorization: auth, Date: date } });
  if (!res.ok) throw new Error(`GET ${key} 失败 ${res.status}`);
  return res.text();
}

async function putBucketPolicy(policyXml) {
  const date = new Date().toUTCString();
  const contentType = 'application/xml';
  const auth = ossSign('PUT', '', contentType, date, {}, 'policy');
  const res = await fetch(`https://${HOST}/?policy`, {
    method: 'PUT',
    headers: { Authorization: auth, Date: date, 'Content-Type': contentType },
    body: policyXml,
  });
  if (!res.ok) throw new Error(`PUT policy 失败 ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

async function main() {
  /*
   * 产物清单**从 package.json 推导**，不再硬编码版本号。
   *
   * 原先这里写死 `NeoMD-1.1.8-*`，与 `services/api/src/routes/download.js`
   * 的硬编码清单是同一个隐患：发版时漏改就会「构建成功但客户端下载 404」，
   * 而且构建日志全绿、只有用户点下载才发现。1.3.1 把两处一起改成动态推导，
   * 版本号自此只有 `package.json` 一个事实源。
   *
   * 只发布当前版本的产物：历史版本仍留在 OSS 桶里（不删除），
   * 旧链接继续可用，只是本脚本不重复上传。
   */
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const releases = [
    { file: `NeoMD-${version}-win-x64.zip`, type: 'application/zip' },
    { file: `NeoMD-${version}-setup.exe`, type: 'application/vnd.microsoft.portable-executable' },
    { file: `NeoMD-${version}.apk`, type: 'application/vnd.android.package-archive' },
  ];
  console.log(`发布版本：${version}`);
  console.log(`产物：${releases.map((r) => r.file).join(' / ')}`);

  console.log('1. 开放 releases/ 前缀匿名读取（可选，桶策略）');
  console.log('   说明：线上 OSS_PUBLIC_READ=false，所有下载均走 /api/download/:file 的 302 预签名直链，');
  console.log('   本步骤仅用于让自定义域名 mdadmin.zhengl.vip 也能直接匿名访问，失败不影响下载功能。');
  const policy = `<?xml version="1.0" encoding="UTF-8"?>
<Policy>
  <Version>1</Version>
  <Statement>
    <Effect>Allow</Effect>
    <Principal>*</Principal>
    <Action>oss:GetObject</Action>
    <Resource>acs:oss:*:*:${BUCKET}/${PREFIX}*</Resource>
  </Statement>
</Policy>`;
  try {
    await putBucketPolicy(policy);
    console.log('   OK 桶策略已写入');
  } catch (e) {
    // 不阻断发布：下载走预签名直链，不依赖桶策略
    console.log('   ! 桶策略写入失败（不影响下载功能）:', e.message.split('\n')[0]);
  }

  console.log('2. 上传安装包');
  const manifest = [];
  for (const r of releases) {
    const local = path.join(repo, 'dist-artifacts', r.file);
    if (!fs.existsSync(local)) {
      console.log('   - 跳过（不存在）:', r.file);
      continue;
    }
    const body = fs.readFileSync(local);
    await putObject(PREFIX + r.file, body, r.type);
    const size = body.length;
    manifest.push({ file: r.file, size, type: r.type });
    console.log(`   OK ${r.file} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log('3. 验证匿名下载');
  for (const m of manifest) {
    const url = `${CUSTOM_DOMAIN}/${PREFIX}${m.file}`;
    const res = await fetch(url, { method: 'HEAD' });
    const flag = res.status === 200 ? 'OK' : 'FAIL';
    console.log(`   ${flag} ${url} => ${res.status} len=${res.headers.get('content-length')}`);
  }

  fs.writeFileSync(
    path.join(repo, 'dist-artifacts', 'releases.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), prefix: PREFIX, files: manifest }, null, 2),
  );
  console.log('完成');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
