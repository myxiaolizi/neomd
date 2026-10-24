use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/* ============================ 数据结构 ============================ */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExternalPayload {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HttpReq {
    pub url: String,
    pub method: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HttpRes {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, AppError>;

fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(AppError::Msg(msg.into()))
}

/* ============================ 路径安全 ============================ */

/// 将相对路径拼接到仓库根目录，并阻止越界访问
fn resolve(root: &str, rel: &str) -> Result<PathBuf> {
    let root_path = PathBuf::from(root);
    if !root_path.is_absolute() {
        return err("仓库路径必须是绝对路径");
    }

    let rel_norm = rel.replace('\\', "/");
    if rel_norm.split('/').any(|seg| seg == "..") {
        return err("非法路径：不允许访问上级目录");
    }

    let mut target = root_path.clone();
    for seg in rel_norm.split('/').filter(|s| !s.is_empty()) {
        target.push(seg);
    }

    // 规范化后再次确认仍在根目录内
    if let (Ok(t), Ok(r)) = (target.canonicalize(), root_path.canonicalize()) {
        if !t.starts_with(&r) {
            return err("非法路径：超出仓库范围");
        }
    }
    Ok(target)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ============================ 文件系统命令 ============================ */

#[tauri::command]
fn vault_list(root: String) -> Result<Vec<FileEntry>> {
    let base = PathBuf::from(&root);
    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&base)
        .max_depth(12)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir()
                && (name.starts_with('.') || name == "node_modules" || name == "target"))
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        let rel = match path.strip_prefix(&base) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(FileEntry {
            path: rel,
            size: meta.len(),
            mtime: mtime_ms(&meta),
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

#[tauri::command]
fn vault_read(root: String, path: String) -> Result<String> {
    let full = resolve(&root, &path)?;
    Ok(std::fs::read_to_string(full)?)
}

#[tauri::command]
fn vault_write(root: String, path: String, content: String) -> Result<()> {
    let full = resolve(&root, &path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // 先写临时文件再原子替换，避免半截写入
    let tmp = full.with_extension("md.tmp");
    std::fs::write(&tmp, content.as_bytes())?;
    std::fs::rename(&tmp, &full)?;
    Ok(())
}

#[tauri::command]
fn vault_remove(root: String, path: String) -> Result<()> {
    let full = resolve(&root, &path)?;
    if full.exists() {
        std::fs::remove_file(full)?;
    }
    Ok(())
}

#[tauri::command]
fn vault_move(root: String, from: String, to: String) -> Result<()> {
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(src, dst)?;
    Ok(())
}

#[tauri::command]
fn vault_exists(root: String, path: String) -> Result<bool> {
    Ok(resolve(&root, &path)?.exists())
}

#[tauri::command]
fn vault_ensure_dir(root: String, dir: String) -> Result<()> {
    let full = resolve(&root, &dir)?;
    std::fs::create_dir_all(full)?;
    Ok(())
}

/* ============================ 对话框 ============================ */

#[tauri::command]
async fn pick_folder(_app: tauri::AppHandle) -> Result<Option<String>> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let picked = rfd::AsyncFileDialog::new()
            .set_title("选择笔记仓库文件夹")
            .pick_folder()
            .await;
        Ok(picked.map(|h| h.path().to_string_lossy().to_string()))
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端没有「选择文件夹」概念，仓库固定落在应用私有目录。
        use tauri::Manager;
        let dir = _app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Msg(format!("无法定位应用目录：{e}")))?;
        let vault = dir.join("vault");
        std::fs::create_dir_all(&vault)?;
        Ok(Some(vault.to_string_lossy().to_string()))
    }
}

#[tauri::command]
async fn pick_markdown_file(_app: tauri::AppHandle) -> Result<Option<ExternalPayload>> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let picked = rfd::AsyncFileDialog::new()
            .set_title("打开 Markdown 文件")
            .add_filter("Markdown", &["md", "markdown"])
            .pick_file()
            .await;

        let Some(handle) = picked else {
            return Ok(None);
        };
        let path = handle.path().to_path_buf();
        let content = std::fs::read_to_string(&path)?;
        Ok(Some(ExternalPayload {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名.md".into()),
            path: path.to_string_lossy().to_string(),
            content,
        }))
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端走系统文档选择器；前端本身也能用 <input type=file> 处理，
        // 这里返回 None 让前端回退即可。
        Ok(None)
    }
}

/* ============================ HTTP 代理（绕过 CORS） ============================ */

#[tauri::command]
async fn http_request(req: HttpReq) -> Result<HttpRes> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("mdnote/1.0")
        .build()
        .map_err(|e| AppError::Msg(format!("创建 HTTP 客户端失败：{e}")))?;

    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| AppError::Msg(format!("非法方法：{e}")))?;

    let mut builder = client.request(method, &req.url);

    for (k, v) in &req.headers {
        // 这些头由 HTTP 客户端自行处理
        let lk = k.to_lowercase();
        if lk == "host" || lk == "content-length" || lk == "connection" {
            continue;
        }
        builder = builder.header(k, v);
    }

    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("请求失败：{e}")))?;

    let status = resp.status().as_u16();
    let mut headers = std::collections::HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            headers.insert(k.as_str().to_lowercase(), s.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Msg(format!("读取响应失败：{e}")))?
        .to_vec();

    Ok(HttpRes {
        status,
        headers,
        body,
    })
}

/* ============================ 外部文件接入 ============================ */

/// 待处理的启动文件，由前端主动取走
#[derive(Default)]
struct StartupFile(Mutex<Option<ExternalPayload>>);

fn load_external(path: &Path) -> Option<ExternalPayload> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "md" && ext != "markdown" {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    Some(ExternalPayload {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名.md".into()),
        path: path.to_string_lossy().to_string(),
        content,
    })
}

#[tauri::command]
fn take_startup_file(state: State<'_, StartupFile>) -> Option<ExternalPayload> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/* ============================ 应用入口 ============================ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // 单实例：第二次打开文件时转交给已运行窗口
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv.iter().skip(1) {
                let p = PathBuf::from(arg);
                if let Some(payload) = load_external(&p) {
                    let _ = app.emit("mdnote://open-file", payload);
                    break;
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(StartupFile::default())
        .setup(|app| {
            // 首次启动时解析命令行中的 .md 路径
            let mut startup = None;
            for arg in std::env::args().skip(1) {
                let p = PathBuf::from(&arg);
                if let Some(payload) = load_external(&p) {
                    startup = Some(payload);
                    break;
                }
            }
            if let Some(p) = startup {
                if let Ok(mut guard) = app.state::<StartupFile>().0.lock() {
                    *guard = Some(p);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_list,
            vault_read,
            vault_write,
            vault_remove,
            vault_move,
            vault_exists,
            vault_ensure_dir,
            pick_folder,
            pick_markdown_file,
            http_request,
            take_startup_file,
        ])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}

// Emitter 仅在桌面（单实例回调）分支使用
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Emitter;
