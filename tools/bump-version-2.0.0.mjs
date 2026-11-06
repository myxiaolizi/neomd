/**
 * 把仓库内所有「真正的版本号常量」提升到 2.0.0。
 *
 *   node tools/bump-version-2.0.0.mjs
 *
 * 重要区分：
 *   - **要改**：package.json 的 version 字段、env.ts 的 APP_VERSION 与下载文件名、
 *     apps/desktop/package.json、各子包 package.json。
 *   - **不能改**：源码注释/文档里形如「1.4.0 新增了 xxx」的历史说明。
 *     那是「某能力在某版本引入」的记述，改了就是篡改历史，会让后来人误判
 *     功能的引入版本。所以本脚本只做精确的行级替换，绝不全文正则扫 1.4.0。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const OLD = '1.4.0';
const NEW = '2.0.0';

let changed = 0;

/** 读文件，无 BOM */
function read(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 写文件，无 BOM */
function write(file, text) {
  writeFileSync(file, text, 'utf8');
}

/** 改 package.json 的 version 字段（只动 version 这一个键） */
function bumpPackageJson(rel) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    console.log(`  - 跳过（不存在）：${rel}`);
    return;
  }
  const raw = read(file);
  const before = JSON.parse(raw);
  if (before.version === NEW) {
    console.log(`  = 已是 ${NEW}：${rel}`);
    return;
  }

  // 用正则精确替换顶层 "version" 字段，保留原有缩进和键顺序
  const out = raw.replace(/^(\s*)"version"\s*:\s*"[^"]*"/m, `$1"version": "${NEW}"`);
  if (out === raw) {
    console.log(`  ! 未匹配到 version 字段：${rel}`);
    return;
  }
  const after = JSON.parse(out);
  if (after.version !== NEW) {
    console.error(`  ✗ 替换后校验失败：${rel}`);
    process.exitCode = 1;
    return;
  }
  write(file, out);
  console.log(`  ✓ ${rel}: ${before.version} -> ${NEW}`);
  changed++;
}

console.log(`\n[1/2] 提升 package.json version -> ${NEW}`);
[
  'package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'apps/android/package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'packages/ui/package.json',
  'services/api/package.json',
].forEach(bumpPackageJson);

console.log(`\n[2/2] 提升 apps/web/src/env.ts`);
const envFile = join(root, 'apps', 'web', 'src', 'env.ts');
if (existsSync(envFile)) {
  let t = read(envFile);
  const before = t;

  // APP_VERSION 常量
  t = t.replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${NEW}';`);

  // 下载文件名：只替换 ASCII 文件名里的版本号（形如 NeoMD-1.4.0-win-x64.zip）
  t = t.replace(/(['"`\/])NeoMD-1\.4\.0(-)/g, `$1NeoMD-${NEW}$2`);

  if (t === before) {
    console.log('  = 无变化（可能已是 2.0.0）');
  } else {
    write(envFile, t);
    console.log(`  ✓ apps/web/src/env.ts 已更新`);
    changed++;
  }

  // 校验：不再有 APP_VERSION = '1.4.0'
  const chk = read(envFile);
  if (/APP_VERSION = '1\.4\.0'/.test(chk)) {
    console.error('  ✗ APP_VERSION 仍是 1.4.0');
    process.exitCode = 1;
  } else {
    console.log(`  ✓ 校验通过：APP_VERSION 已不是 1.4.0`);
  }
  // 校验：下载链接已带 2.0.0
  const hasDownload = /NeoMD-2\.0\.0-/.test(chk);
  console.log(`  ${hasDownload ? '✓' : '✗'} 下载文件名已带 2.0.0`);
} else {
  console.error(`  ✗ 找不到 ${envFile}`);
  process.exitCode = 1;
}

console.log(`\n完成，共修改 ${changed} 个文件。`);
console.log('注意：源码注释里「1.4.0 新增 xxx」这类历史说明保持原样，未改动。');
