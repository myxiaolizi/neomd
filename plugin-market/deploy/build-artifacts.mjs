/**
 * Neo MD 社区插件 · 发布产物构建器
 *
 *   node plugin-market/deploy/build-artifacts.mjs                # 严格模式（默认：必须 50/50 齐全且无校验问题）
 *   node plugin-market/deploy/build-artifacts.mjs --allow-partial # 允许缺失（只打包已就绪的，打印「已就绪 X/50」）
 *   node plugin-market/deploy/build-artifacts.mjs --out <dir>     # 自定义输出目录
 *
 * 产出：
 *   dist/plugins-payload.json  [{ pluginId, name, version, category, icon, description, readmeMd, codeJs, nn }]
 *   dist/manifest.json         { suiteVersion, generatedAt, total, items:[{ nn, pluginId, file, bytes, sha256, lines }] }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const planPath = join(root, 'PLAN.json');

const argv = process.argv.slice(2);
const allowPartial = argv.includes('--allow-partial');
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 && argv[outIdx + 1] ? resolve(process.cwd(), argv[outIdx + 1]) : join(root, 'dist');

const MAX_BYTES = 12 * 1024;
const EXPECTED_TOTAL = 50;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** 校验 Buffer 是否为严格合法的 UTF-8（且不含 U+FFFD 替换符） */
function decodeStrictUtf8(buf) {
  try {
    const str = utf8Decoder.decode(buf);
    if (str.includes('\uFFFD')) return null;
    return str;
  } catch {
    return null;
  }
}

/** 校验字符串是否不含孤立 UTF-16 代理项或 U+FFFD，且 UTF-8 往返一致 */
function isValidUtf8String(value) {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0xfffd) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return decodeStrictUtf8(Buffer.from(value, 'utf8')) !== null;
}

if (!existsSync(planPath)) {
  console.error(`构建失败：找不到契约文件 ${planPath}`);
  process.exit(1);
}

const planBuf = readFileSync(planPath);
const planRaw = decodeStrictUtf8(planBuf);
if (planRaw === null) {
  console.error('构建失败：PLAN.json 包含非合法 UTF-8 内容');
  process.exit(1);
}

let plan;
try {
  plan = JSON.parse(planRaw);
} catch (err) {
  console.error(`构建失败：PLAN.json 解析失败（${err.message}）`);
  process.exit(1);
}

const problems = [];
const items = [];

const planPlugins = Array.isArray(plan?.plugins) ? plan.plugins : [];
if (planPlugins.length !== EXPECTED_TOTAL) {
  problems.push(`PLAN 条目数为 ${planPlugins.length}，应为 ${EXPECTED_TOTAL}`);
}

for (const p of planPlugins) {
  const file = join(root, 'plugins', p.file);
  if (!existsSync(file)) {
    problems.push(`缺少文件：plugins/${p.file}`);
    continue;
  }
  const buf = readFileSync(file);
  const codeJs = decodeStrictUtf8(buf);
  if (codeJs === null) {
    problems.push(`${p.file} 包含非 UTF-8 字节或编码替换符`);
    continue;
  }
  if (buf.length > MAX_BYTES) {
    problems.push(`${p.file} 体积 ${buf.length} 字节，超过 ${MAX_BYTES} (12KB)`);
  }
  if (!codeJs.includes('export default')) {
    problems.push(`${p.file} 缺少 export default`);
  }
  if (!codeJs.includes(`id: '${p.id}'`) && !codeJs.includes(`id: "${p.id}"`)) {
    problems.push(`${p.file} 源码 id 与 PLAN 不一致（应为 ${p.id}）`);
  }
  const hasNameQuoted =
    codeJs.includes(`name: '${p.name}'`) ||
    codeJs.includes(`name: "${p.name}"`) ||
    codeJs.includes(p.name);
  if (!hasNameQuoted) {
    problems.push(`${p.file} 源码 name 与 PLAN 不一致（应为 ${p.name}）`);
  }
  if (p.commandId && !codeJs.includes(p.commandId)) {
    problems.push(`${p.file} 源码 commandId 与 PLAN 不一致（应为 ${p.commandId}）`);
  }

  for (const [k, v] of [
    ['id', p.id],
    ['name', p.name],
    ['category', p.category],
    ['icon', p.icon],
    ['description', p.description],
    ['readme', p.readme],
    ['nn', p.nn],
  ]) {
    if (!isValidUtf8String(String(v ?? ''))) {
      problems.push(`${p.file} 的 PLAN 字段 ${k} 含非 UTF-8 内容`);
    }
  }

  items.push({
    nn: p.nn,
    file: p.file,
    pluginId: p.id,
    name: p.name,
    version: '1.0.0',
    category: p.category,
    icon: p.icon,
    description: p.description,
    readmeMd: p.readme,
    codeJs,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    lines: codeJs.split('\n').length,
  });
}

const payload = items.map((x) => ({
  pluginId: x.pluginId,
  name: x.name,
  version: x.version,
  category: x.category,
  icon: x.icon,
  description: x.description,
  readmeMd: x.readmeMd,
  codeJs: x.codeJs,
  nn: x.nn,
}));

const payloadText = JSON.stringify(payload, null, 2) + '\n';
const payloadBuf = Buffer.from(payloadText, 'utf8');
if (decodeStrictUtf8(payloadBuf) === null) {
  problems.push('序列化后的 plugins-payload.json 出现非 UTF-8 内容');
}

const blocking = allowPartial
  ? problems.filter((m) => !m.startsWith('缺少文件'))
  : problems;

if (blocking.length) {
  console.error(`构建失败（已就绪 ${items.length}/${planPlugins.length}），存在以下 ${blocking.length} 个问题：`);
  for (const m of blocking) console.error(' - ' + m);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const manifest = {
  suiteVersion: plan.suiteVersion,
  generatedAt: new Date().toISOString(),
  total: items.length,
  items: items.map(({ nn, pluginId, file, bytes, sha256, lines }) => ({
    nn,
    pluginId,
    file,
    bytes,
    sha256,
    lines,
  })),
};

const payloadPath = resolve(outDir, 'plugins-payload.json');
const manifestPath = resolve(outDir, 'manifest.json');
writeFileSync(payloadPath, payloadBuf);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const totalBytes = items.reduce((s, x) => s + x.bytes, 0);
const maxBytes = items.length ? Math.max(...items.map((x) => x.bytes)) : 0;
console.log(`已就绪 ${items.length}/${planPlugins.length}`);
console.log(`payload  → ${payloadPath} (${statSync(payloadPath).size} 字节)`);
console.log(`manifest → ${manifestPath} (${statSync(manifestPath).size} 字节)`);
console.log(`插件源码合计 ${totalBytes} 字节，单款最大 ${maxBytes} 字节`);
if (problems.length) {
  console.log(`待补齐（共 ${problems.length} 项）：`);
  for (const m of problems) console.log(' - ' + m);
}
