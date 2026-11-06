/**
 * 探测 Tauri 2 在本机的构建可行性，并确保产出的 JSON 配置**不带 BOM**。
 *
 *   node tools/probe-tauri.mjs --dir <目录>
 *
 * 为什么单独写脚本而不是用 PowerShell Set-Content：
 * 本机是 Windows PowerShell 5.1，`Set-Content -Encoding utf8` 会写 UTF-8 BOM，
 * 而 Tauri 的 build script 用 serde_json 解析 tauri.conf.json，遇到 BOM 直接
 * 「expected value at line 1 column 1」——这个坑在本会话已经踩过一次。
 * 所有 JSON / JS / TOML / Rust 源文件一律用 Node 写，保证无 BOM。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const dirArgIdx = process.argv.indexOf('--dir');
const workDir = dirArgIdx >= 0 ? resolve(process.argv[dirArgIdx + 1]) : join(root, '.probe-tauri');

/** 只写 utf8 且无 BOM 的文本 */
function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // Node 的 writeFileSync 默认不写 BOM；这里显式去掉可能残留在入参上的 BOM
  writeFileSync(path, text.replace(/^\uFEFF/, ''), 'utf8');
}

/** 自检：确认文件头没有 BOM */
function assertNoBom(path) {
  const buf = readFileSync(path);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  console.log(`${hasBom ? '✗ BOM!' : '✓ 无 BOM'}  ${path}  (首字节 ${[...buf.subarray(0, 4)].join(',')})`);
  return !hasBom;
}

const srcTauri = join(workDir, 'src-tauri');

// 1) 前端占位产物
writeText(join(workDir, 'dist', 'index.html'), '<!doctype html><html><body><h1>tauri probe</h1></body></html>');

// 2) Cargo.toml
writeText(
  join(srcTauri, 'Cargo.toml'),
  `[package]
name = "tauri_probe"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
`
);

// 3) build.rs
writeText(join(srcTauri, 'build.rs'), 'fn main() { tauri_build::build() }\n');

// 4) main.rs
writeText(
  join(srcTauri, 'src', 'main.rs'),
  `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`
);

// 5) tauri.conf.json —— 用 JSON.stringify 保证是合法无 BOM JSON
const conf = {
  productName: 'tauri-probe',
  version: '0.1.0',
  identifier: 'vip.zhengl.tauriprobe',
  build: { frontendDist: '../dist' },
  app: { windows: [{ title: 'tauri probe', width: 800, height: 600 }] },
  bundle: { active: false, targets: 'all' }
};
writeText(join(srcTauri, 'tauri.conf.json'), JSON.stringify(conf, null, 2) + '\n');

// 自检
const checks = [
  assertNoBom(join(srcTauri, 'tauri.conf.json')),
  assertNoBom(join(srcTauri, 'Cargo.toml')),
  assertNoBom(join(srcTauri, 'build.rs'))
];

const confText = readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8');
let parses = false;
try {
  JSON.parse(confText);
  parses = true;
} catch (e) {
  console.log('✗ JSON 解析失败：' + e.message);
}
console.log(`${parses ? '✓' : '✗'} tauri.conf.json 可被 JSON.parse`);

if (existsSync(join(srcTauri, 'Cargo.toml'))) {
  console.log('✓ 骨架已生成：' + srcTauri);
}

process.exit(checks.every(Boolean) && parses ? 0 : 1);
