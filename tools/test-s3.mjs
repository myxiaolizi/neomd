/**
 * 真实对象存储验证：用打包后的 S3 客户端对阿里云 OSS 执行
 * probe（列举/写入/读取/删除），并验证 sync 引擎的三方合并。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '.s3test.mjs')).toString());
const { S3StorageClient, probeStorage, signRequestV4 } = mod;

const config = {
  provider: 'aliyun-oss',
  endpoint: 'https://s3.oss-cn-guangzhou.aliyuncs.com',
  region: 'cn-guangzhou',
  bucket: 'zhengle',
  // 1.1.7 安全修复：不再硬编码真实 AK/SK（曾把凭据写死在源码里，违反项目安全红线）。
  // 签名测试只需要「非空且格式合法」的假值即可，因此这里用固定占位串，
  // 既不影响签名逻辑的验证，也不会泄露任何真实凭据。
  accessKeyId: 'TEST_ACCESS_KEY_ID_0000',
  accessKeySecret: 'TEST_ACCESS_KEY_SECRET_0000000000',
  publicDomain: 'https://mdadmin.zhengl.vip',
  urlStyle: 'virtual-hosted',
  isPrivate: false,
  basePrefix: 'mdadmin/',
  useTls: true,
};

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    fail += 1;
    console.log('  ✗ ' + label + (extra ? ' — ' + extra : ''));
  }
}

console.log('S3 签名与连通性（真实阿里云 OSS）');
const probe = await probeStorage(config, 'mdadmin/synctest/');
check(probe.ok, 'probe 全绿（列举+写入+读取）', probe.message);
check(probe.canDelete, '可删除对象', probe.message);
console.log('    耗时 ' + probe.latencyMs + 'ms');

const client = new S3StorageClient(config);

console.log('\n读写与列举');
const key = `mdadmin/synctest/neomd-${Date.now()}.md`;
const content = '# 同步测试\n\n中文内容 with **bold**。\n';
await client.putObject(key, content, 'text/markdown; charset=utf-8');
const back = await client.getObjectText(key);
check(back === content, '中文内容字节级往返一致');
const head = await client.headObject(key);
check(head !== null && head.size > 0, 'HEAD 返回对象元信息');
const list = await client.listObjects('mdadmin/synctest/', 20);
check(list.some((o) => o.key === key), '列举包含刚写入的对象');
await client.deleteObject(key);
const afterDelete = await client.headObject(key);
check(afterDelete === null, '删除后对象不存在');

console.log('\n公开访问地址');
const pubUrl = client.publicUrl('mdadmin/test.png');
check(pubUrl === 'https://mdadmin.zhengl.vip/mdadmin/test.png', '自定义域名拼接正确: ' + pubUrl);

console.log('\n预签名');
const signed = await client.presignGet('mdadmin/synctest/x.md', 600);
check(signed.includes('X-Amz-Signature=') && signed.includes('X-Amz-Expires=600'), '预签名 URL 含签名与有效期');

console.log('\n三方合并');
const merge = mod.threeWayMerge;
check(merge('a\nb\nc', 'a\nB\nc', 'a\nb\nC') === 'a\nB\nC', '不同行修改可自动合并');
check(merge('a\nb\nc', 'a\nX\nc', 'a\nY\nc') === null, '同一行冲突返回 null');
check(merge('a\nb', 'a\nb', 'a\nB') === 'a\nB', '仅远端修改取远端');
check(merge('a\nb', 'a\nB', 'a\nb') === 'a\nB', '仅本地修改取本地');

console.log('\n签名稳定性');
const fixedDate = new Date('2026-10-23T00:00:00Z');
const s1 = signRequestV4(config, { method: 'GET', key: 'a/b.md', payloadHash: 'UNSIGNED-PAYLOAD', date: fixedDate });
const s2 = signRequestV4(config, { method: 'GET', key: 'a/b.md', payloadHash: 'UNSIGNED-PAYLOAD', date: fixedDate });
check(s1.headers.authorization === s2.headers.authorization, '相同输入签名可复现');
// 断言里用 config.accessKeyId 而不是写死字面量：既避免泄露，也让测试与配置保持一致
check(
  s1.headers.authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/`),
  'Authorization 头格式正确',
);
check(s1.url.startsWith('https://zhengle.s3.oss-cn-guangzhou.aliyuncs.com/a/b.md'), '虚拟主机风格 URL 正确: ' + s1.url);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
