//! Neo MD Tauri 2 桌面壳。
//!
//! 架构（与 docs/desktop-2.0-spec.md 一致，四个壳共用）：
//! 1. 内置一个只绑定 127.0.0.1 的本地 HTTP 服务器，托管 `apps/web/dist`；
//! 2. 同一服务器把 `/api/*` 反向代理到 `https://md.zhengl.vip`；
//! 3. 同一服务器提供 `/__bridge/<method>` 供页面调用原生能力；
//! 4. 返回 index.html 时把 `window.NeoMD` 注入 `<head>`，保证首帧前就绪。
//!
//! 为什么用「本地 HTTP + 同源代理」而不是自定义协议：
//! Web 端 `apps/web/src/lib/server-endpoint.ts` 的 `isRemoteWeb()` 判定
//! 「http(s) 且 host !== neomd」时让 `resolveServerBase()` 返回空串，
//! 于是所有 API 都走同源相对路径 `/api/...`，落到本地服务器再被代理转发，
//! 全程同源、不触发任何 CORS 预检。四个壳用同一套，行为可横向对比。
//!
//! 为什么注入脚本通过服务器返回时拼进 HTML，而不是用 initialization_script：
//! 前者不依赖 Tauri 的 webview 注入时机与 API 差异，四个壳行为完全一致，
//! 也便于在浏览器里直接开 http://127.0.0.1:<port>/ 调试。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::UNIX_EPOCH;

const UPSTREAM: &str = "https://md.zhengl.vip";
const APP_VERSION: &str = "2.1.0";

// ---------------------------------------------------------------- 路径解析

/// 可执行文件所在目录；绿色版的数据目录就放在它下面。
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 绿色版用户数据目录：`<exe目录>/data`。
fn data_dir() -> PathBuf {
    let d = exe_dir().join("data");
    let _ = fs::create_dir_all(&d);
    d
}

/// Web 产物目录（`apps/web/dist`）的查找顺序：
/// 1. 环境变量 `NEOMD_WEB_DIST`（调试/测试用）；
/// 2. exe 同级 `webdist/`（打包后随 exe 分发）；
/// 3. 开发态：从 `src-tauri` 往上找到 `apps/web/dist`。
fn web_dist() -> PathBuf {
    if let Ok(p) = std::env::var("NEOMD_WEB_DIST") {
        let p = PathBuf::from(p);
        if p.join("index.html").exists() {
            return p;
        }
    }

    let bundled = exe_dir().join("webdist");
    if bundled.join("index.html").exists() {
        return bundled;
    }

    // 开发态：src-tauri 的上一级是 apps/desktop-tauri，再上两级到仓库根
    let mut cur = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..5 {
        let candidate = cur.join("apps").join("web").join("dist");
        if candidate.join("index.html").exists() {
            return candidate;
        }
        if !cur.pop() {
            break;
        }
    }

    // 最后兜底：假设运行在 releases 目录结构里
    exe_dir().join("..").join("..").join("..").join("apps").join("web").join("dist")
}

// ---------------------------------------------------------------- MIME

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "map" => "application/json",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------- 注入脚本

/// 宿主标记脚本：让 `detectRuntime()` 判定为 desktop，并提供 bridge。
///
/// bridge 的每个方法都通过 `fetch('/__bridge/<method>')` 打到本地服务器，
/// 由 Rust 侧真正执行文件系统操作。这样不依赖 Tauri 的 IPC，
/// 和 Qt / Flutter / WinUI3 三版实现方式完全一致。
fn injection_script() -> String {
    format!(
        r#"<script>
(function () {{
  if (window.NeoMD) return;
  function call(method, args) {{
    return fetch('/__bridge/' + encodeURIComponent(method), {{
      method: 'POST',
      headers: {{ 'content-type': 'application/json' }},
      body: JSON.stringify(args || [])
    }}).then(function (r) {{
      if (!r.ok) throw new Error('BRIDGE_FAIL:' + method + ':' + r.status);
      return r.json();
    }}).then(function (j) {{
      if (j && j.error) throw new Error(j.error);
      return j.result;
    }});
  }}
  var noop = function () {{ return Promise.reject(new Error('NOT_IMPLEMENTED')); }};
  window.NeoMD = {{
    env: 'desktop',
    version: '{ver}',
    bridge: {{
      fs: {{
        readText: function (p) {{ return call('fs.readText', [p]); }},
        readBinary: function (p) {{
          return call('fs.readBinary', [p]).then(function (b64) {{
            var bin = atob(b64);
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
          }});
        }},
        writeText: function (p, c) {{ return call('fs.writeText', [p, c]); }},
        writeBinary: function (p, d) {{
          var s = '';
          var arr = d instanceof Uint8Array ? d : new Uint8Array(d);
          for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
          return call('fs.writeBinary', [p, btoa(s)]);
        }},
        mkdirp: function (p) {{ return call('fs.mkdirp', [p]); }},
        remove: function (p) {{ return call('fs.remove', [p]); }},
        rename: function (a, b) {{ return call('fs.rename', [a, b]); }},
        list: function (p) {{ return call('fs.list', [p]); }},
        exists: function (p) {{ return call('fs.exists', [p]); }},
        stat: function (p) {{ return call('fs.stat', [p]); }}
      }},
      dialog: {{
        pickDirectory: function () {{ return call('dialog.pickDirectory', []); }},
        pickFile: function (f) {{ return call('dialog.pickFile', [f || null]); }},
        saveFile: function (n) {{ return call('dialog.saveFile', [n || 'untitled.md']); }}
      }},
      paths: {{
        documents: function () {{ return call('paths.documents', []); }},
        userData: function () {{ return call('paths.userData', []); }},
        vaultDefault: function () {{ return call('paths.vaultDefault', []); }}
      }},
      secrets: {{ encrypt: noop, decrypt: noop }},
      shell: {{
        openExternal: function (u) {{ return call('shell.openExternal', [u]); }},
        showItemInFolder: function (p) {{ return call('shell.showItemInFolder', [p]); }}
      }},
      // 2.1.0：窗口控制接上真实实现。2.0.0 时这四个全是 noop，
      // 于是标题栏拖拽、双击最大化、以及最大化状态订阅全部静默失效。
      win: {{
        isMaximized: function () {{ return call('win.isMaximized', []); }},
        toggleMaximize: function () {{ return call('win.toggleMaximize', []); }},
        minimize: function () {{ return call('win.minimize', []); }},
        close: function () {{ return call('win.close', []); }},
        startDrag: function () {{ return call('win.startDrag', []); }}
      }},
      app: {{
        version: function () {{ return Promise.resolve('{ver}'); }},
        onOpenFile: function (cb) {{ window.__neoMDOpenFile = cb; }}
      }}
    }}
  }};
}})();
</script>"#,
        ver = APP_VERSION
    )
}

// ---------------------------------------------------------------- bridge 实现

fn json_err(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn json_ok(v: serde_json::Value) -> String {
    serde_json::json!({ "result": v }).to_string()
}

/// 执行一次 bridge 调用。返回 JSON 文本（成功 `{result}` / 失败 `{error}`）。
fn bridge_call(method: &str, args: &[serde_json::Value]) -> String {
    let sarg = |i: usize| -> String {
        args.get(i)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    match method {
        // ---------------- fs ----------------
        "fs.readText" => match fs::read_to_string(sarg(0)) {
            Ok(s) => json_ok(serde_json::Value::String(s)),
            Err(e) => json_err(&e.to_string()),
        },

        "fs.readBinary" => match fs::read(sarg(0)) {
            Ok(bytes) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                json_ok(serde_json::Value::String(b64))
            }
            Err(e) => json_err(&e.to_string()),
        },

        "fs.writeText" => {
            let p = PathBuf::from(sarg(0));
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::write(&p, sarg(1)) {
                Ok(_) => json_ok(serde_json::Value::Null),
                Err(e) => json_err(&e.to_string()),
            }
        }

        "fs.writeBinary" => {
            let p = PathBuf::from(sarg(0));
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(sarg(1)) {
                Ok(bytes) => match fs::write(&p, bytes) {
                    Ok(_) => json_ok(serde_json::Value::Null),
                    Err(e) => json_err(&e.to_string()),
                },
                Err(e) => json_err(&e.to_string()),
            }
        }

        "fs.mkdirp" => match fs::create_dir_all(sarg(0)) {
            Ok(_) => json_ok(serde_json::Value::Null),
            Err(e) => json_err(&e.to_string()),
        },

        "fs.remove" => {
            let p = PathBuf::from(sarg(0));
            let r = if p.is_dir() {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
            match r {
                Ok(_) => json_ok(serde_json::Value::Null),
                Err(e) => json_err(&e.to_string()),
            }
        }

        "fs.rename" => match fs::rename(sarg(0), sarg(1)) {
            Ok(_) => json_ok(serde_json::Value::Null),
            Err(e) => json_err(&e.to_string()),
        },

        "fs.exists" => json_ok(serde_json::Value::Bool(Path::new(&sarg(0)).exists())),

        // 注意：不存在时返回 null，不报错——与接口约定的 `| null` 对齐
        "fs.stat" => match fs::metadata(sarg(0)) {
            Ok(m) => {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                json_ok(serde_json::json!({ "size": m.len(), "mtime": mtime }))
            }
            Err(_) => json_ok(serde_json::Value::Null),
        },

        // 注意字段名是 isDirectory，不是 isDir
        "fs.list" => match fs::read_dir(sarg(0)) {
            Ok(rd) => {
                let mut items = Vec::new();
                for entry in rd.flatten() {
                    let path = entry.path();
                    let meta = entry.metadata().ok();
                    let name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                    let mtime = meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let _ = path;
                    items.push(serde_json::json!({
                        "name": name,
                        "isDirectory": is_dir,
                        "size": size,
                        "mtime": mtime
                    }));
                }
                json_ok(serde_json::Value::Array(items))
            }
            Err(e) => json_err(&e.to_string()),
        },

        // ---------------- dialog ----------------
        "dialog.pickDirectory" => {
            let picked = rfd::FileDialog::new().pick_folder();
            match picked {
                Some(p) => json_ok(serde_json::Value::String(p.to_string_lossy().to_string())),
                None => json_ok(serde_json::Value::Null),
            }
        }

        "dialog.pickFile" => {
            let picked = rfd::FileDialog::new()
                .add_filter("Markdown", &["md", "markdown", "txt"])
                .pick_file();
            match picked {
                Some(p) => json_ok(serde_json::Value::String(p.to_string_lossy().to_string())),
                None => json_ok(serde_json::Value::Null),
            }
        }

        "dialog.saveFile" => {
            let default_name = {
                let n = sarg(0);
                if n.is_empty() {
                    "untitled.md".to_string()
                } else {
                    n
                }
            };
            let picked = rfd::FileDialog::new()
                .add_filter("Markdown", &["md", "markdown"])
                .set_file_name(&default_name)
                .save_file();
            match picked {
                Some(p) => json_ok(serde_json::Value::String(p.to_string_lossy().to_string())),
                None => json_ok(serde_json::Value::Null),
            }
        }

        // ---------------- paths ----------------
        "paths.documents" => {
            let p = dirs_documents();
            json_ok(serde_json::Value::String(p.to_string_lossy().to_string()))
        }
        "paths.userData" => json_ok(serde_json::Value::String(data_dir().to_string_lossy().to_string())),
        "paths.vaultDefault" => json_ok(serde_json::Value::String(
            data_dir().join("vault").to_string_lossy().to_string(),
        )),

        // ---------------- shell ----------------
        "shell.openExternal" => {
            let url = sarg(0);
            // 只允许 http/https，避免被页面拿来执行任意命令
            if url.starts_with("http://") || url.starts_with("https://") {
                let _ = std::process::Command::new("cmd")
                    .args(["/C", "start", "", &url])
                    .spawn();
                json_ok(serde_json::Value::Null)
            } else {
                json_err("UNSUPPORTED_SCHEME")
            }
        }

        "shell.showItemInFolder" => {
            let p = sarg(0);
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,{}", p))
                .spawn();
            json_ok(serde_json::Value::Null)
        }

        // ---------------- app ----------------
        "app.version" => json_ok(serde_json::Value::String(APP_VERSION.to_string())),

        // ---------------- win（2.1.0 新增）----------------
        //
        // 2.0.0 时这里全是 noop，导致页面里的 `.nm-drag` 拖拽区与
        // `useDesktopWindow()` 调 `win.toggleMaximize()` 全部静默失效。
        // 现在改为真正操作 Win32 窗口，并用 SetWindowLong 把窗口变成无边框，
        // 让 Web 的 TabBar 成为唯一标题栏（和 Electron 版一致）。
        "win.isMaximized" => json_ok(serde_json::Value::Bool(win_is_maximized())),
        "win.toggleMaximize" => {
            win_toggle_maximize();
            json_ok(serde_json::Value::Null)
        }
        "win.minimize" => {
            win_minimize();
            json_ok(serde_json::Value::Null)
        }
        "win.close" => {
            win_close();
            json_ok(serde_json::Value::Null)
        }
        // 页面在顶部拖拽区按下时调用，交给系统做原生窗口拖动
        "win.startDrag" => {
            win_start_drag();
            json_ok(serde_json::Value::Null)
        }

        other => json_err(&format!("NOT_IMPLEMENTED:{other}")),
    }
}

// ---------------------------------------------------------------- 窗口控制（Win32）

/// 主窗口句柄。由 `main()` 在 setup 里填入，bridge 线程只读。
static MAIN_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

fn set_main_hwnd(h: isize) {
    MAIN_HWND.store(h, std::sync::atomic::Ordering::SeqCst);
}

fn main_hwnd() -> *mut std::ffi::c_void {
    let h = MAIN_HWND.load(std::sync::atomic::Ordering::SeqCst);
    h as *mut std::ffi::c_void
}

#[cfg(windows)]
mod w32 {
    #[link(name = "user32")]
    extern "system" {
        pub fn IsZoomed(h: *mut std::ffi::c_void) -> i32;
        pub fn ShowWindow(h: *mut std::ffi::c_void, cmd: i32) -> i32;
        pub fn PostMessageW(h: *mut std::ffi::c_void, msg: u32, w: usize, l: isize) -> i32;
        pub fn IsWindow(h: *mut std::ffi::c_void) -> i32;
        pub fn SetWindowLongPtrW(h: *mut std::ffi::c_void, idx: i32, val: isize) -> isize;
        pub fn GetWindowLongPtrW(h: *mut std::ffi::c_void, idx: i32) -> isize;
        pub fn SetWindowPos(
            h: *mut std::ffi::c_void,
            after: *mut std::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        pub fn SendMessageW(h: *mut std::ffi::c_void, msg: u32, w: usize, l: isize) -> isize;
        pub fn ReleaseCapture() -> i32;
    }

    pub const SW_MINIMIZE: i32 = 6;
    pub const SW_RESTORE: i32 = 9;
    pub const SW_MAXIMIZE: i32 = 3;
    pub const WM_CLOSE: u32 = 0x0010;
    pub const WM_NCLBUTTONDOWN: u32 = 0x00A1;
    pub const HTCAPTION: usize = 2;
    pub const GWL_STYLE: i32 = -16;
    pub const WS_CAPTION: isize = 0x00C0_0000;
    pub const WS_THICKFRAME: isize = 0x0004_0000;
    pub const SWP_FRAMECHANGED: u32 = 0x0020;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOZORDER: u32 = 0x0004;
}

/// 窗口是否最大化
fn win_is_maximized() -> bool {
    let h = main_hwnd();
    if h.is_null() {
        return false;
    }
    unsafe { w32::IsZoomed(h) != 0 }
}

/// 最大化 / 还原切换
fn win_toggle_maximize() {
    let h = main_hwnd();
    if h.is_null() {
        return;
    }
    unsafe {
        if w32::IsWindow(h) == 0 {
            return;
        }
        let cmd = if w32::IsZoomed(h) != 0 {
            w32::SW_RESTORE
        } else {
            w32::SW_MAXIMIZE
        };
        w32::ShowWindow(h, cmd);
    }
}

fn win_minimize() {
    let h = main_hwnd();
    if h.is_null() {
        return;
    }
    unsafe {
        if w32::IsWindow(h) != 0 {
            w32::ShowWindow(h, w32::SW_MINIMIZE);
        }
    }
}

fn win_close() {
    let h = main_hwnd();
    if h.is_null() {
        return;
    }
    unsafe {
        if w32::IsWindow(h) != 0 {
            w32::PostMessageW(h, w32::WM_CLOSE, 0, 0);
        }
    }
}

/// 去掉系统标题栏边框，让 Web 的 TabBar 成为唯一标题栏。
///
/// 保留 `WS_THICKFRAME`（窗口边缘拖拽改尺寸、贴边、Aero Snap），
/// 只清掉 `WS_CAPTION`（标题栏本体 + 原生标题文字）。
/// 这是「去掉一整行系统标题栏、但仍能拖边缩放」的标准做法。
fn win_strip_caption() {
    let h = main_hwnd();
    if h.is_null() {
        return;
    }
    unsafe {
        if w32::IsWindow(h) == 0 {
            return;
        }
        let style = w32::GetWindowLongPtrW(h, w32::GWL_STYLE);
        let next = (style & !w32::WS_CAPTION) | w32::WS_THICKFRAME;
        if next != style {
            w32::SetWindowLongPtrW(h, w32::GWL_STYLE, next);
            w32::SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                w32::SWP_FRAMECHANGED | w32::SWP_NOMOVE | w32::SWP_NOSIZE | w32::SWP_NOZORDER,
            );
        }
    }
}

/// 让页面顶部拖拽区真正能拖动窗口。
///
/// WebView2 不会把 `app-region: drag` 翻译成 Win32 的拖动消息
/// （那是 Electron 自己实现的行为），所以这里由页面主动调用：
/// 命中拖拽区时发 `WM_NCLBUTTONDOWN(HTCAPTION)`，交给系统走原生拖动。
fn win_start_drag() {
    let h = main_hwnd();
    if h.is_null() {
        return;
    }
    unsafe {
        if w32::IsWindow(h) == 0 {
            return;
        }
        w32::ReleaseCapture();
        w32::SendMessageW(h, w32::WM_NCLBUTTONDOWN, w32::HTCAPTION, 0);
    }
}

/// Windows 文档目录；取不到就退回数据目录下的 documents/
fn dirs_documents() -> PathBuf {
    if let Ok(up) = std::env::var("USERPROFILE") {
        let d = PathBuf::from(up).join("Documents");
        if d.exists() {
            return d;
        }
    }
    let fallback = data_dir().join("documents");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

// ---------------------------------------------------------------- 静态服务 + 代理

/// 把 `/api/*` 转发到官方后端（同源代理，页面不感知）。
fn proxy_upstream(req: &mut tiny_http::Request) -> String {
    let url = req.url().to_string();
    let target = format!("{UPSTREAM}{url}");

    // 读请求体
    let mut body = Vec::new();
    let _ = req.as_reader().read_to_end(&mut body);

    let method = req.method().as_str().to_uppercase();
    let mut r = match method.as_str() {
        "GET" => ureq::get(&target),
        "POST" => ureq::post(&target),
        "PUT" => ureq::put(&target),
        "PATCH" => ureq::patch(&target),
        "DELETE" => ureq::delete(&target),
        "HEAD" => ureq::head(&target),
        _ => ureq::get(&target),
    };

    // 透传关键请求头
    for h in req.headers() {
        let name = h.field.as_str().as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "authorization"
                | "content-type"
                | "accept"
                | "x-user-ai-key"
                | "x-device-id"
                | "x-requested-with"
                | "x-vault-id"
                | "x-object-key"
                | "x-object-content-type"
        ) {
            r = r.set(&h.field.as_str().as_str(), h.value.as_str());
        }
    }
    // 标记来源壳，便于后端日志区分
    r = r.set("x-neomd-shell", "tauri");

    let resp = if body.is_empty() {
        r.call()
    } else {
        r.send_bytes(&body)
    };

    match resp {
        Ok(ok) => {
            let status = ok.status();
            let mut text = String::new();
            let mut reader = ok.into_reader();
            let _ = reader.read_to_string(&mut text);
            serde_json::json!({ "status": status, "body": text }).to_string()
        }
        Err(ureq::Error::Status(code, resp)) => {
            let mut text = String::new();
            let mut reader = resp.into_reader();
            let _ = reader.read_to_string(&mut text);
            serde_json::json!({ "status": code, "body": text }).to_string()
        }
        Err(e) => serde_json::json!({ "status": 502, "body": format!("{{\"error\":\"{e}\"}}") }).to_string(),
    }
}

fn handle_request(mut req: tiny_http::Request, dist: Arc<PathBuf>) {
    let url = req.url().to_string();
    let path_only = url.split('?').next().unwrap_or("/").to_string();

    // ---- 1) /api/* 反代 ----
    if path_only.starts_with("/api/") {
        let packed = proxy_upstream(&mut req);
        let v: serde_json::Value = serde_json::from_str(&packed).unwrap_or(serde_json::json!({
            "status": 502,
            "body": "{\"error\":\"PROXY_PARSE\"}"
        }));
        let status = v["status"].as_u64().unwrap_or(502) as u16;
        let body = v["body"].as_str().unwrap_or("").to_string();

        let ct = if body.trim_start().starts_with('{') || body.trim_start().starts_with('[') {
            "application/json; charset=utf-8"
        } else {
            "text/plain; charset=utf-8"
        };
        let header = tiny_http::Header::from_bytes(&b"content-type"[..], ct.as_bytes()).unwrap();
        let resp = tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(header);
        let _ = req.respond(resp);
        return;
    }

    // ---- 2) /__bridge/<method> ----
    if let Some(rest) = path_only.strip_prefix("/__bridge/") {
        let method = percent_decode(rest);
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let args: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
        let out = bridge_call(&method, &args);

        let header =
            tiny_http::Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
                .unwrap();
        let resp = tiny_http::Response::from_string(out).with_header(header);
        let _ = req.respond(resp);
        return;
    }

    // ---- 3) 静态文件 ----
    let mut rel = path_only.clone();
    if rel == "/" || rel.is_empty() {
        rel = "/index.html".to_string();
    }
    // 防目录穿越
    let rel_clean = rel.replace("..", "");
    let mut file = dist.join(rel_clean.trim_start_matches('/'));

    if file.is_dir() {
        file = file.join("index.html");
    }

    match fs::read(&file) {
        Ok(bytes) => {
            let is_html = file.extension().and_then(|e| e.to_str()) == Some("html");
            let body: Vec<u8> = if is_html {
                let text = String::from_utf8_lossy(&bytes).to_string();
                let injected = if let Some(idx) = text.find("<head>") {
                    let (a, b) = text.split_at(idx + 6);
                    format!("{a}\n{}{b}", injection_script())
                } else {
                    format!("{}{}", injection_script(), text)
                };
                injected.into_bytes()
            } else {
                bytes
            };

            let ct = mime_of(&file);
            let header = tiny_http::Header::from_bytes(&b"content-type"[..], ct.as_bytes()).unwrap();
            let cc = tiny_http::Header::from_bytes(&b"cache-control"[..], &b"no-store"[..]).unwrap();
            let resp = tiny_http::Response::from_data(body)
                .with_header(header)
                .with_header(cc);
            let _ = req.respond(resp);
        }
        Err(_) => {
            // SPA 兜底：任何未命中的路径都返回 index.html
            match fs::read(dist.join("index.html")) {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    let injected = if let Some(idx) = text.find("<head>") {
                        let (a, b) = text.split_at(idx + 6);
                        format!("{a}\n{}{b}", injection_script())
                    } else {
                        format!("{}{}", injection_script(), text)
                    };
                    let header = tiny_http::Header::from_bytes(
                        &b"content-type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .unwrap();
                    let resp = tiny_http::Response::from_string(injected).with_header(header);
                    let _ = req.respond(resp);
                }
                Err(_) => {
                    let _ = req.respond(tiny_http::Response::from_string("not found").with_status_code(404));
                }
            }
        }
    }
}

/// 极简 percent-decode（bridge 方法名里只可能出现 encodeURIComponent 的结果）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 起本地服务器，返回实际监听端口。
fn start_server() -> u16 {
    let dist = Arc::new(web_dist());
    eprintln!("[neomd-tauri] web dist = {}", dist.display());

    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind 127.0.0.1:0 failed");
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .expect("no port");

    thread::spawn(move || {
        for req in server.incoming_requests() {
            let d = Arc::clone(&dist);
            // 每个请求一个线程，避免大文件/慢代理阻塞其它请求
            thread::spawn(move || handle_request(req, d));
        }
    });

    port
}

// ---------------------------------------------------------------- main

fn main() {
    let port = start_server();
    let url = format!("http://127.0.0.1:{port}/");
    eprintln!("[neomd-tauri] serving {url}");

    // 窗口由 tauri.conf.json 的 app.windows 声明（label = "main"）。
    // 这里**不能**在 setup 里再 WebviewWindowBuilder::new(app, "main", ..)，
    // 否则运行期直接 panic：a webview with label `main` already exists。
    // 只需要把已声明的窗口导航到本机服务器地址。
    tauri::Builder::default()
        .setup(move |app| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                // 记下窗口句柄供 bridge 的 win.* 使用（跨线程只读原子）
                if let Ok(h) = win.hwnd() {
                    set_main_hwnd(h.0 as isize);
                }
                let target = url.parse().expect("bad url");
                let _ = win.navigate(target);
                let _ = win.set_focus();
                // 去掉系统标题栏，让 Web 的 TabBar 成为唯一标题栏（与 Electron 版一致）
                win_strip_caption();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
