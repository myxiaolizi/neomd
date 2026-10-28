/**
 * 桌面端打包入口：调用 electron-builder 产出 portable exe 与 NSIS 安装包。
 * 打包前确认 Web 产物存在。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist', 'index.html');
const outDir = path.join(repoRoot, 'dist-artifacts');

if (!existsSync(webDist)) {
  console.error('[build] 缺少 Web 产物，请先运行 pnpm --filter @neomd/web build');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

const args = [
  'electron-builder',
  '--win',
  '--x64',
  '--config',
  path.join(here, 'electron-builder.config.cjs'),
  ...process.argv.slice(2),
];

console.log('[build] electron-builder', args.join(' '));
const res = spawnSync('npx', args, { cwd: here, stdio: 'inherit', env, shell: true });
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

// 绿色版：把解压目录打成 zip，避免单文件 exe 体积过大且需自解压
const unpacked = path.join(outDir, 'win-unpacked');
const zipOut = path.join(outDir, 'NeoMD-1.1.9-win-x64.zip');
if (existsSync(unpacked)) {
  if (existsSync(zipOut)) rmSync(zipOut, { force: true });
  console.log('[build] 正在生成绿色版压缩包…');
  try {
    execFileSync('tar', ['-a', '-c', '-f', zipOut, '-C', unpacked, '.'], { stdio: 'inherit' });
    const size = statSync(zipOut).size;
    console.log(`[build] 绿色版已生成: ${zipOut} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.error('[build] 压缩失败:', e.message);
  }
} else {
  console.log('[build] 未找到 win-unpacked，跳过绿色版压缩');
}
