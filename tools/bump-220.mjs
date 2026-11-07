/**
 * 把五个桌面壳的运行时版本常量从 2.1.0 升到 2.2.0。
 *
 * 只改「运行时真正会读到的版本号」；历史注释里提到 2.1.0 的修复记录保持原样，
 * 那是版本沿革说明，改成 2.2.0 反而会失真。
 *
 * 用 .mjs 而不是 node -e：本机 PowerShell 5.1 会把内联脚本里的引号、& 改写掉。
 */
import fs from 'node:fs';

const edits = [
  // Flutter：boot.json 的 version、bridge 的 getVersion、以及 Dart 侧常量
  ['apps/desktop-flutter/lib/main.dart', [
    ["version: '2.1.0',", "version: '2.2.0',"],
    ["return Promise.resolve('2.1.0');", "return Promise.resolve('2.2.0');"],
    ["'version': '2.1.0',", "'version': '2.2.0',"],
    ["result = '2.1.0';", "result = '2.2.0';"],
  ]],
  // Qt：APP_VERSION 同时用于窗口标题与 boot.json
  ['apps/desktop-qt/main.py', [
    ['APP_VERSION = "2.1.0"', 'APP_VERSION = "2.2.0"'],
  ]],
  // WinUI3：C# 常量 + 注入到页面的 BridgeScript
  ['apps/desktop-winui3/App.xaml.cs', [
    ['public const string AppVersion = "2.1.0";', 'public const string AppVersion = "2.2.0";'],
  ]],
  ['apps/desktop-winui3/BridgeScript.cs', [
    ["const VERSION = '2.1.0';", "const VERSION = '2.2.0';"],
  ]],
  // Tauri：Rust 常量 + Cargo + tauri.conf（conf 的 version 决定产物元数据）
  ['apps/desktop-tauri/src-tauri/src/main.rs', [
    ['const APP_VERSION: &str = "2.1.0";', 'const APP_VERSION: &str = "2.2.0";'],
  ]],
  ['apps/desktop-tauri/src-tauri/Cargo.toml', [
    ['version = "2.1.0"', 'version = "2.2.0"'],
  ]],
  ['apps/desktop-tauri/src-tauri/tauri.conf.json', [
    ['"version": "2.1.0",', '"version": "2.2.0",'],
    ['"title": "Neo MD 2.1.0",', '"title": "Neo MD 2.2.0",'],
  ]],
];

let failed = 0;
for (const [file, pairs] of edits) {
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const [from, to] of pairs) {
    if (s.includes(from)) {
      s = s.split(from).join(to);
      n += 1;
    } else {
      console.log(`  MISS ${file} :: ${JSON.stringify(from)}`);
      failed += 1;
    }
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(`${file} -> ${n}/${pairs.length}`);
}
console.log(failed === 0 ? '\nALL REPLACEMENTS OK' : `\n${failed} MISSING`);
