/**
 * 修补 Tauri 版 main() 的窗口创建逻辑。
 *
 *   node tools/fix-tauri-main.mjs
 *
 * 问题：tauri.conf.json 的 app.windows 已经声明了 label = "main" 的窗口，
 * setup 里又 WebviewWindowBuilder::new(app, "main", ...) 会 panic：
 *   a webview with label `main` already exists
 *
 * 修法：setup 里不再新建窗口，只取出配置声明的窗口并 navigate 到本地服务器地址。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const file = join(root, 'apps', 'desktop-tauri', 'src-tauri', 'src', 'main.rs');

const original = readFileSync(file, 'utf8');

// 定位 fn main() 之后到文件末尾的整段，整体替换（避免空白差异导致匹配失败）
const idx = original.indexOf('fn main() {');
if (idx < 0) {
  console.error('✗ 找不到 fn main()');
  process.exit(1);
}

const newMain = `fn main() {
    let port = start_server();
    let url = format!("http://127.0.0.1:{port}/");
    eprintln!("[neomd-tauri] serving {url}");

    // 窗口由 tauri.conf.json 的 app.windows 声明（label = "main"）。
    // 这里**不能**在 setup 里再 WebviewWindowBuilder::new(app, "main", ..)，
    // 否则运行期直接 panic：a webview with label \`main\` already exists。
    // 只需要把已声明的窗口导航到本机服务器地址。
    tauri::Builder::default()
        .setup(move |app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let target = url.parse().expect("bad url");
                let _ = win.navigate(target);
                let _ = win.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;

const patched = original.slice(0, idx) + newMain;

// 无 BOM 写回（写 .rs 也保持无 BOM，cargo 虽能处理 BOM 但没必要留坑）
writeFileSync(file, patched.replace(/^\uFEFF/, ''), 'utf8');

const after = readFileSync(file);
const hasBom = after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf;
console.log(`${hasBom ? '✗ BOM!' : '✓ 无 BOM'}  ${file}`);
console.log('✓ main() 已改为复用配置声明的窗口（不再重复创建）');
