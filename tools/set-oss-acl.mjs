/**
 * 设置 releases/ 下对象为公共读（对象级 ACL，走阿里云 OSS 原生 API）。
 * 同时配置 CORS，便于网页端直连下载。
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
 * 安全说明（1.1.7 修复）：此处历史上把**真实的阿里云 AK/SK 写死在源码里**。
 * 现在不允许硬编码，缺失即报错，强制运行前显式提供。
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
const CUSTOM = 'https://mdadmin.zhengl.vip';
const PREFIX = 'mdadmin/releases/';

const FILES = ['NeoMD-1.0.0-win-x64.zip', 'NeoMD-1.0.0-setup.exe', 'NeoMD-1.0.0.apk'];

function sign(method, key, contentType, date, ossHeaders = {}, subresource = '') {
  const canon = Object.entries(ossHeaders)
    .map(([k, v]) => `${k.toLowerCase()}:${v}`)
    .sort()
    .join('\n');
  // OSS V1 规范资源：/bucket/key?子资源（子资源必须计入签名）
  const resource = (key ? `/${BUCKET}/${key}` : `/${BUCKET}/`) + (subresource ? `?${subresource}` : '');
  const sts = [method, '', contentType, date, (canon ? canon + '\n' : '') + resource].join('\n');
  const sig = crypto.createHmac('sha1', SK).update(sts, 'utf8').digest('base64');
  return `OSS ${AK}:${sig}`;
}

async function putObjectAcl(key, acl) {
  const date = new Date().toUTCString();
  const ossHeaders = { 'x-oss-object-acl': acl };
  const auth = sign('PUT', key, '', date, ossHeaders, 'acl');
  const res = await fetch(`https://${HOST}/${encodeURI(key)}?acl`, {
    method: 'PUT',
    headers: { Authorization: auth, Date: date, ...ossHeaders },
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 200) };
}

async function getObjectAcl(key) {
  const date = new Date().toUTCString();
  const auth = sign('GET', key, '', date, {}, 'acl');
  const res = await fetch(`https://${HOST}/${encodeURI(key)}?acl`, { headers: { Authorization: auth, Date: date } });
  return { ok: res.ok, text: await res.text() };
}

async function putCors() {
  const date = new Date().toUTCString();
  const cors = `<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;
  const md5 = crypto.createHash('md5').update(Buffer.from(cors, 'utf8')).digest('base64');
  const auth = sign('PUT', '', 'application/xml', date, { 'Content-MD5': md5 }, 'cors');
  const res = await fetch(`https://${HOST}/?cors`, {
    method: 'PUT',
    headers: { Authorization: auth, Date: date, 'Content-Type': 'application/xml', 'Content-MD5': md5 },
    body: cors,
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 300) };
}

async function main() {
  console.log('1. 设置对象 ACL 为 public-read');
  for (const f of FILES) {
    const key = `${PREFIX}${f}`;
    const r = await putObjectAcl(key, 'public-read');
    console.log(`   ${r.ok ? '✓' : '✗'} ${f} => ${r.status} ${r.body}`);
  }

  console.log('2. 校验 ACL');
  for (const f of FILES) {
    const r = await getObjectAcl(`${PREFIX}${f}`);
    const grant = /public-read/.test(r.text) ? 'public-read' : 'private/unknown';
    console.log(`   ${f}: ${grant}`);
  }

  console.log('3. 配置 CORS');
  const cors = await putCors();
  console.log(`   ${cors.ok ? '✓' : '✗'} CORS => ${cors.status} ${cors.body}`);

  console.log('4. 匿名下载验证');
  let allOk = true;
  for (const f of FILES) {
    const url = `${CUSTOM}/${PREFIX}${f}`;
    const res = await fetch(url, { method: 'HEAD' });
    const len = res.headers.get('content-length');
    console.log(`   ${res.status === 200 ? '✓' : '✗'} ${url} => ${res.status} ${len ? (len / 1024 / 1024).toFixed(2) + ' MB' : ''}`);
    if (res.status !== 200) allOk = false;
  }

  fs.writeFileSync(
    path.join(repo, 'dist-artifacts', 'releases.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), prefix: PREFIX, ok: allOk }, null, 2),
  );
  console.log(allOk ? '\n全部可下载' : '\n仍有文件不可下载');
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
