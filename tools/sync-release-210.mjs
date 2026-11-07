#!/usr/bin/env node
/**
 * 把各壳的最新构建产物同步进 2.1.0 发布目录，并统一下发最新的 web dist。
 *
 * 为什么需要它：四个壳的主程序与 web 产物是分别构建的，
 * 只更新其中一个就会出现「壳是新的、页面是旧的」这类错配，
 * 表现为「改了没效果」。发布前必须整体对齐。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Data\\BAC\\neomd';
const SRC = path.join(ROOT, 'neomd-V1');
const WEB = path.join(SRC, 'apps', 'web', 'dist');
const REL = path.join(ROOT, 'releases', '2.1.0');
const OLD = path.join(ROOT, 'releases', '2.0.0');

const log = (m) => console.log(m);

/** 递归复制目录（覆盖） */
function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function must(p, label) {
  if (!fs.existsSync(p)) throw new Error(`缺少${label}: ${p}`);
  return p;
}

// 先基于 2.0.0 的完整目录复制一份 2.1.0（保留 data/ 之外的全部运行时依赖）
if (!fs.existsSync(REL)) {
  log(`创建 ${REL}（基于 2.0.0 目录结构）`);
  fs.cpSync(OLD, REL, { recursive: true });
}

const targets = {
  tauri: 'NeoMD-2.1.0-tauri-x64',
  qt: 'NeoMD-2.1.0-qt-x64',
  winui3: 'NeoMD-2.1.0-winui3-x64',
  flutter: 'NeoMD-2.1.0-flutter-x64',
};

// 2.0.0 -> 2.1.0 目录重命名
for (const [name, dirName] of Object.entries(targets)) {
  const dst = path.join(REL, dirName);
  const srcOld = path.join(REL, `NeoMD-2.0.0-${name}-x64`);
  if (!fs.existsSync(dst) && fs.existsSync(srcOld)) {
    fs.renameSync(srcOld, dst);
    log(`重命名 ${name}: 2.0.0 -> 2.1.0`);
  }
}

/* ---------------- tauri ---------------- */
{
  const dir = path.join(REL, targets.tauri);
  const exe = must(
    path.join(SRC, 'apps', 'desktop-tauri', 'src-tauri', 'target', 'release', 'neomd_tauri.exe'),
    'Tauri 二进制',
  );
  fs.copyFileSync(exe, path.join(dir, 'NeoMD.exe'));
  copyDir(WEB, path.join(dir, 'webdist'));
  log(`tauri   ok  exe ${(fs.statSync(path.join(dir, 'NeoMD.exe')).size / 1024 / 1024).toFixed(2)} MB`);
}

/* ---------------- winui3 ---------------- */
{
  const dir = path.join(REL, targets.winui3);
  const buildDir = path.join(
    SRC,
    'apps',
    'desktop-winui3',
    'bin',
    'Release',
    'net9.0-windows10.0.19041.0',
    'win-x64',
  );
  must(buildDir, 'WinUI3 输出目录');
  // 只覆盖构建产物，保留 data/
  for (const entry of fs.readdirSync(buildDir)) {
    const from = path.join(buildDir, entry);
    const to = path.join(dir, entry);
    if (entry === 'data') continue;
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
  copyDir(WEB, path.join(dir, 'webdist'));
  log(`winui3  ok  exe ${(fs.statSync(path.join(dir, 'NeoMD.WinUI3.exe')).size / 1024 / 1024).toFixed(2)} MB`);
}

/* ---------------- flutter ---------------- */
{
  const dir = path.join(REL, targets.flutter);
  const relBuild = path.join(SRC, 'apps', 'desktop-flutter', 'build', 'windows', 'x64', 'runner', 'Release');
  must(relBuild, 'Flutter 输出目录');
  fs.copyFileSync(path.join(relBuild, 'neomd_flutter.exe'), path.join(dir, 'neomd_flutter.exe'));
  // data/ 是程序必需资产（app.so / icudtl.dat / flutter_assets），必须同步
  copyDir(path.join(relBuild, 'data'), path.join(dir, 'data'));
  copyDir(WEB, path.join(dir, 'web-dist'));
  log(`flutter ok  exe ${(fs.statSync(path.join(dir, 'neomd_flutter.exe')).size / 1024).toFixed(0)} KB`);
}

/* ---------------- qt ---------------- */
{
  const dir = path.join(REL, targets.qt);
  // Qt 是 PyInstaller onedir：主程序在根目录，资源在 _internal/
  const internal = path.join(dir, '_internal');
  const webDistCandidates = [
    path.join(dir, 'web-dist'),
    path.join(internal, 'web-dist'),
  ];
  copyDir(WEB, webDistCandidates[1]);
  log(`qt      ok  web-dist -> _internal（Qt 主程序需重新打包，见 build 脚本）`);
}

log('\n同步完成。');
