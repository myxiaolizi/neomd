/**
 * 桌面端打包入口：调用 electron-builder 产出 NSIS 安装包 + 绿色版（免安装）zip。
 *
 * 版本号唯一来源是 apps/desktop/package.json 的 version（electron-builder 的 ${version} 模板也读它）。
 * 之所以强调这点：早先版本这里把 zip 文件名硬编码成 `NeoMD-1.1.9-win-x64.zip`，
 * 每升一次版本就得手工改，漏改就会产出一个"文件名写着旧版本"的包直接发出去。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist', 'index.html');
const outDir = path.join(repoRoot, 'dist-artifacts');
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const version = pkg.version;

/** 产物命名与 electron-builder.config.cjs 的 artifactName 保持同一套规则 */
const setupName = `NeoMD-${version}-setup.exe`;
const greenName = `NeoMD-${version}-win-x64.zip`;
const setupPath = path.join(outDir, setupName);
const greenPath = path.join(outDir, greenName);
const unpacked = path.join(outDir, 'win-unpacked');

if (!version || typeof version !== 'string') {
  console.error('[build] 无法从 apps/desktop/package.json 读取 version');
  process.exit(1);
}
if (!existsSync(webDist)) {
  console.error('[build] 缺少 Web 产物，请先运行 pnpm --filter @neomd/web build');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/** 计算 SHA256（发布 GitHub Release 需要贴校验值） */
function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function describe(file, label) {
  if (!existsSync(file)) return null;
  const bytes = statSync(file).size;
  const info = { label, path: file, bytes, mb: Number((bytes / 1024 / 1024).toFixed(1)), sha256: sha256(file) };
  console.log(`[build] ${label}: ${file}`);
  console.log(`[build]   ${info.mb} MB  sha256=${info.sha256}`);
  return info;
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

// 先清掉本版本的旧产物，避免"构建失败但目录里躺着上一次的成功包"被误当成新包发布
for (const stale of [setupPath, greenPath]) {
  if (existsSync(stale)) rmSync(stale, { force: true });
}

const args = [
  'electron-builder',
  '--win',
  '--x64',
  '--config',
  path.join(here, 'electron-builder.config.cjs'),
  ...process.argv.slice(2),
];

console.log(`[build] 版本 ${version}，electron-builder ${args.join(' ')}`);
const res = spawnSync('npx', args, { cwd: here, stdio: 'inherit', env, shell: true });
if ((res.status ?? 1) !== 0) {
  console.error('[build] electron-builder 失败，退出码', res.status ?? 1);
  process.exit(res.status ?? 1);
}

/**
 * 绿色版：把 win-unpacked 整目录压成 zip。
 *
 * 为什么由 build.mjs 用 tar 压、而不是让 electron-builder 的 zip target 生成：
 * electron-builder.config.cjs 里只保留了 nsis 目标（见该文件的注释），
 * 保证「绿色版 zip 只有一个生产者」，不会出现两个进程写同一个文件名、谁后写谁生效的问题。
 * Windows 10+ 自带 bsdtar，`tar -a` 会按扩展名选 zip 格式，无需额外依赖。
 */
if (!existsSync(unpacked)) {
  console.error('[build] 未找到 win-unpacked，无法生成绿色版');
  process.exit(1);
}
if (!existsSync(path.join(unpacked, 'Neo MD.exe'))) {
  console.error('[build] win-unpacked 内缺少 Neo MD.exe（productName 被改动？）');
  process.exit(1);
}

console.log('[build] 正在生成绿色版压缩包…');
try {
  execFileSync('tar', ['-a', '-c', '-f', greenPath, '-C', unpacked, '.'], { stdio: 'inherit' });
} catch (e) {
  // 注意：这里以前只打印错误、退出码仍是 0，会出现"构建成功但没有绿包"的假成功
  console.error('[build] 绿色版压缩失败:', e.message);
  process.exit(1);
}
if (!existsSync(greenPath)) {
  console.error('[build] 绿色版压缩后仍找不到产物:', greenPath);
  process.exit(1);
}

console.log('\n[build] ===== 产物清单 =====');
const artifacts = [describe(greenPath, '绿色版 zip'), describe(setupPath, 'NSIS 安装包')].filter(Boolean);
if (!artifacts.length) {
  console.error('[build] 没有任何产物');
  process.exit(1);
}
// 机器可读的清单，供发布脚本/人工直接取用
console.log('[build] ARTIFACTS_JSON=' + JSON.stringify(artifacts));
