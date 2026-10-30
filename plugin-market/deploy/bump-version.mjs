/**
 * 把工作区版本号从 1.2.0 提升到 1.3.0（幂等，纯 Node，UTF-8 安全）
 *
 *   node plugin-market/deploy/bump-version.mjs [--to 1.3.0]
 *
 * 只改 package.json 的 version 字段与 apps/web/src/env.ts 的 APP_VERSION，
 * 不动下载文件名（那属于发布产物命名，需与实际上传文件一致）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const idx = process.argv.indexOf('--to');
const target = idx >= 0 ? process.argv[idx + 1] : '1.3.0';
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`版本号格式非法：${target}`);
  process.exit(1);
}

const pkgFiles = [
  'package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'apps/android/package.json',
  'services/api/package.json',
  'packages/shared/package.json',
  'packages/core/package.json',
  'packages/ui/package.json'
].filter((f) => existsSync(join(root, f)));

let changed = 0;
for (const f of pkgFiles) {
  const path = join(root, f);
  const text = readFileSync(path, 'utf8');
  const re = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  const m = re.exec(text);
  if (!m) {
    console.log(`- ${f}：无 version 字段，跳过`);
    continue;
  }
  if (m[2] === target) {
    console.log(`= ${f}：已是 ${target}`);
    continue;
  }
  const next = text.replace(re, `$1${target}$3`);
  writeFileSync(path, next, 'utf8');
  console.log(`✓ ${f}：${m[2]} → ${target}`);
  changed += 1;
}

// 前端展示版本
const envPath = join(root, 'apps/web/src/env.ts');
if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8');
  const re = /(export const APP_VERSION = ')(\d+\.\d+\.\d+)(')/;
  const m = re.exec(text);
  if (m && m[2] !== target) {
    writeFileSync(envPath, text.replace(re, `$1${target}$3`), 'utf8');
    console.log(`✓ apps/web/src/env.ts：APP_VERSION ${m[2]} → ${target}`);
    changed += 1;
  } else if (m) {
    console.log(`= apps/web/src/env.ts：APP_VERSION 已是 ${target}`);
  }
}

console.log(`共更新 ${changed} 个文件`);
