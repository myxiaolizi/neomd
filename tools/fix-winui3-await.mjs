/**
 * 修复 WinUI 3 ShellWindow.xaml.cs 的 CS4008「无法等待 void」。
 *
 *   node tools/fix-winui3-await.mjs
 *
 * 原因：CoreWebView2.NavigateToString 是**同步 void** 方法，
 * 子智能体写成 `await WebView.CoreWebView2.NavigateToString(...)`，
 * C# 报 CS4008。去掉 await 即可。
 *
 * 附带：TryShowError 去掉 await 后变成「async 但无 await」，
 * 会有 CS1998 警告，这里一并把签名从 async Task 改成 void，
 * 调用处也同步改。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const file = join(root, 'apps', 'desktop-winui3', 'ShellWindow.xaml.cs');

// 该文件被写成了 GBK，按 latin1 读进来只改 ASCII 片段，再原样写回，避免破坏中文
let text = readFileSync(file, 'latin1');
const before = text;

// 1) await NavigateToString -> NavigateToString
text = text.replace(/await\s+(WebView\.CoreWebView2\.NavigateToString)/g, '$1');

// 2) TryShowError 改 void（去 await 后没有 await 了）
text = text.replace(/private async Task TryShowError\(Exception ex\)/, 'private void TryShowError(Exception ex)');

// 3) 调用处 await TryShowError -> TryShowError
text = text.replace(/await TryShowError\(ex\);/g, 'TryShowError(ex);');

if (text === before) {
  console.log('没有匹配到需要修改的片段，检查文件是否已修好');
} else {
  writeFileSync(file, text, 'latin1');
  console.log('✓ 已去掉 NavigateToString 的 await，TryShowError 改为 void');
}

// 验证
const after = readFileSync(file, 'latin1');
console.log('剩余 `await ...NavigateToString`:', /await\s+WebView\.CoreWebView2\.NavigateToString/.test(after));
console.log('TryShowError 签名:', /private void TryShowError/.test(after) ? 'void ✓' : '未改 ✗');
