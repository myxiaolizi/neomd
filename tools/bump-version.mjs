/**
 * 把五个桌面壳的运行时版本常量统一改到目标版本。
 *
 * 用法：node tools/bump-version.mjs 2.3.0
 *
 * 与旧版（bump-220.mjs 硬编码 2.1.0 -> 2.2.0）的区别：
 *   - 目标版本从命令行传入；
 *   - **当前版本自动从文件里探测**，不再写死。
 *
 * 为什么要自动探测：旧脚本把源版本写死成 2.1.0，升到 2.2.0 之后再跑就全部 MISS
 * （11 处一条都没替换），必须每次手工改脚本，极易漏掉某个壳、造成五个壳版本号
 * 不一致 —— 而版本号不一致会让 boot.json / 产物元数据 / 关于页三处对不上。
 *
 * 只改「运行时真正会读到的版本号」；历史注释里提到的旧版本号保持原样，
 * 那是版本沿革说明，改掉反而失真。
 */
import fs from 'node:fs';

const TARGET = (process.argv[2] ?? '').trim();
if (!/^\d+\.\d+\.\d+$/.test(TARGET)) {
  console.error('usage: node tools/bump-version.mjs <x.y.z>');
  process.exit(1);
}

/**
 * 每项声明：文件 + 一条能唯一识别版本号的正则（用于探测当前版本）
 *           + 一组 [from 模板, to 模板]，模板里的 {V} 会被换成版本号。
 */
const edits = [
  // Flutter：boot.json 的 version、bridge 的 getVersion、以及 Dart 侧常量
  ['apps/desktop-flutter/lib/main.dart', /version:\s*'(\d+\.\d+\.\d+)'/, [
    ["version: '{V}',", "version: '{N}',"],
    ["return Promise.resolve('{V}');", "return Promise.resolve('{N}');"],
    ["'version': '{V}',", "'version': '{N}',"],
    ["result = '{V}';", "result = '{N}';"],
  ]],
  // Qt：APP_VERSION 同时用于窗口标题与 boot.json
  ['apps/desktop-qt/main.py', /APP_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/, [
    ['APP_VERSION = "{V}"', 'APP_VERSION = "{N}"'],
  ]],
  // WinUI3：C# 常量 + 注入到页面的 BridgeScript
  ['apps/desktop-winui3/App.xaml.cs', /AppVersion\s*=\s*"(\d+\.\d+\.\d+)"/, [
    ['public const string AppVersion = "{V}";', 'public const string AppVersion = "{N}";'],
  ]],
  ['apps/desktop-winui3/BridgeScript.cs', /VERSION\s*=\s*'(\d+\.\d+\.\d+)'/, [
    ["const VERSION = '{V}';", "const VERSION = '{N}';"],
  ]],
  // Tauri：Rust 常量 + Cargo + tauri.conf（conf 的 version 决定产物元数据）
  ['apps/desktop-tauri/src-tauri/src/main.rs', /APP_VERSION:\s*&str\s*=\s*"(\d+\.\d+\.\d+)"/, [
    ['const APP_VERSION: &str = "{V}";', 'const APP_VERSION: &str = "{N}";'],
  ]],
  ['apps/desktop-tauri/src-tauri/Cargo.toml', /^version\s*=\s*"(\d+\.\d+\.\d+)"/m, [
    ['version = "{V}"', 'version = "{N}"'],
  ]],
  ['apps/desktop-tauri/src-tauri/tauri.conf.json', /"version":\s*"(\d+\.\d+\.\d+)"/, [
    ['"version": "{V}",', '"version": "{N}",'],
    ['"title": "Neo MD {V}"', '"title": "Neo MD {N}"'],
  ]],
];

let failed = 0;
const found = new Set();

/**
 * 顺带把所有 package.json 的 version 也改掉。
 *
 * 这些不参与桌面壳的运行时版本显示，但会被 npm workspace 与打包脚本读取；
 * 漏掉会造成"壳里显示 2.3.0、包管理里还是 2.2.0"的错觉，排查时容易误判。
 * 用 JSON 解析再写回，避免正则误伤其他字段（如依赖版本）。
 */
const PKG_FILES = [
  'package.json',
  'apps/android/package.json',
  'apps/desktop/package.json',
  'apps/web/package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'packages/ui/package.json',
  'services/api/package.json',
];
for (const f of PKG_FILES) {
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(raw);
  if (j.version === TARGET) { console.log(`${f}  已是 ${TARGET}，跳过`); continue; }
  const prev = j.version;
  j.version = TARGET;
  // 保留原有缩进（这些文件都是 2 空格）
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8');
  found.add(prev);
  console.log(`${f}  ${prev} -> ${TARGET}`);
}

for (const [file, probe, pairs] of edits) {
  let s = fs.readFileSync(file, 'utf8');
  const m = probe.exec(s);
  if (!m) {
    console.log(`  PROBE-FAIL ${file}`);
    failed += 1;
    continue;
  }
  const current = m[1];
  found.add(current);
  if (current === TARGET) {
    console.log(`${file}  已是 ${TARGET}，跳过`);
    continue;
  }
  let n = 0;
  for (const [fromT, toT] of pairs) {
    const from = fromT.replace('{V}', current);
    const to = toT.replace('{N}', TARGET);
    if (s.includes(from)) { s = s.split(from).join(to); n += 1; }
    else { console.log(`  MISS ${file} :: ${JSON.stringify(from)}`); failed += 1; }
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(`${file}  ${current} -> ${TARGET}  (${n}/${pairs.length})`);
}

console.log(`\n探测到的现有版本：${[...found].join(', ') || '（无）'}`);
if (found.size > 1) {
  console.log('  警告：各壳版本号原本就不一致，请人工核对');
}
console.log(failed === 0 ? 'ALL REPLACEMENTS OK' : `${failed} MISSING`);
process.exit(failed === 0 ? 0 : 1);
