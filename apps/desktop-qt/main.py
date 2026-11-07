from __future__ import annotations

import base64
import datetime
import json
import mimetypes
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# QtWebEngine resolves its helper and resources as its modules initialize.
if getattr(sys, "frozen", False):
    _webengine_root = Path(sys._MEIPASS) / "PySide6"  # type: ignore[attr-defined]
    os.environ.setdefault("QTWEBENGINEPROCESS_PATH", str(_webengine_root / "QtWebEngineProcess.exe"))
    os.environ.setdefault("QTWEBENGINE_RESOURCES_PATH", str(_webengine_root / "resources"))
    os.environ.setdefault("QTWEBENGINE_LOCALES_PATH", str(_webengine_root / "translations" / "qtwebengine_locales"))
    _chromium_flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    if "--no-sandbox" not in _chromium_flags.split():
        os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = (_chromium_flags + " --no-sandbox").strip()

from PySide6.QtCore import QObject, Qt, QUrl, Signal, Slot
from PySide6.QtGui import QIcon
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow

APP_NAME = "Neo MD"
APP_VERSION = "2.1.0"
API_ORIGIN = "https://md.zhengl.vip"

# 反代固定直连上游，显式忽略系统代理。
# 本机 WinINET 的系统代理曾被指向一个已关闭的本地端口（127.0.0.1:10801），
# 而 urllib 默认会读它，导致壳内反代连登录都发不出去。
PROXYLESS_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def bundle_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


def writable_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BUNDLE_ROOT = bundle_root()
DIST_DIR = BUNDLE_ROOT / "web-dist"
if not getattr(sys, "frozen", False):
    DIST_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"
DATA_DIR = writable_root() / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class DialogBridge(QObject):
    dialog_requested = Signal(str, object, object)

    def __init__(self) -> None:
        super().__init__()
        self.dialog_requested.connect(self._show_dialog)

    def request(self, action: str, args: Any) -> Any:
        complete = threading.Event()
        result: dict[str, Any] = {"value": None}
        self.dialog_requested.emit(action, args, (complete, result))
        complete.wait()
        return result["value"]

    @Slot(str, object, object)
    def _show_dialog(self, action: str, args: Any, context: Any) -> None:
        complete, result = context
        try:
            if action == "pickDirectory":
                value = QFileDialog.getExistingDirectory(None, "Choose a folder", str(Path.home()))
            elif action == "pickFile":
                filters = args[0] if args else []
                filter_text = "All Files (*)"
                if filters:
                    extensions = " ".join(f"*{item}" if str(item).startswith(".") else f"*.{item}" for item in filters)
                    filter_text = f"Supported Files ({extensions});;All Files (*)"
                value, _ = QFileDialog.getOpenFileName(None, "Open file", str(Path.home()), filter_text)
            elif action == "saveFile":
                default_name = str(args[0]) if args else "untitled.md"
                value, _ = QFileDialog.getSaveFileName(None, "Save file", str(Path.home() / default_name), "All Files (*)")
            else:
                value = None
            result["value"] = value or None
        finally:
            complete.set()


def mtime_ms(path: Path) -> int:
    return int(path.stat().st_mtime * 1000)


class WindowBus(QObject):
    """
    窗口控制指令总线（2.1.0）。

    bridge 请求跑在 HTTP 线程上，而所有窗口操作**必须**在 Qt 主线程执行。
    直接跨线程调 QWidget 会崩，所以这里用信号做线程安全的转投：
    跨线程 emit 时 Qt 自动按 QueuedConnection 排到主线程事件循环里执行。

    2.0.0 时 Qt 版根本没有 win.* 方法，页面里 `win.toggleMaximize()`、
    `.nm-drag` 拖拽区、以及最大化状态全都静默失效 —— 用户看到的是
    「标题栏能点但拖不动、双击不变大」。
    """

    minimizeReq = Signal()
    toggleReq = Signal()
    closeReq = Signal()
    startDragReq = Signal()
    isMaximizedReq = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._maximized = False


# 进程内单例。bridge_call 从这里发指令，MainWindow 负责连接与真正执行。
WINDOW_BUS = WindowBus()


def bridge_call(method: str, args: list[Any], dialogs: DialogBridge) -> Any:
    try:
        if method == "fs.readText":
            return Path(str(args[0])).read_text(encoding="utf-8")
        if method == "fs.readBinary":
            return base64.b64encode(Path(str(args[0])).read_bytes()).decode("ascii")
        if method == "fs.writeText":
            path = Path(str(args[0])); path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(args[1]), encoding="utf-8")
            return None
        if method == "fs.writeBinary":
            path = Path(str(args[0])); path.parent.mkdir(parents=True, exist_ok=True)
            payload = args[1]
            if isinstance(payload, dict) and "base64" in payload:
                payload = payload["base64"]
            path.write_bytes(base64.b64decode(str(payload)))
            return None
        if method == "fs.mkdirp":
            Path(str(args[0])).mkdir(parents=True, exist_ok=True)
            return None
        if method == "fs.remove":
            path = Path(str(args[0]))
            if path.is_dir(): shutil.rmtree(path)
            elif path.exists(): path.unlink()
            return None
        if method == "fs.rename":
            Path(str(args[0])).rename(Path(str(args[1])))
            return None
        if method == "fs.list":
            path = Path(str(args[0]))
            return [{"name": child.name, "isDirectory": child.is_dir(), "size": 0 if child.is_dir() else child.stat().st_size, "mtime": mtime_ms(child)} for child in path.iterdir()]
        if method == "fs.exists":
            return Path(str(args[0])).exists()
        if method == "fs.stat":
            path = Path(str(args[0]))
            return {"size": path.stat().st_size, "mtime": mtime_ms(path)} if path.exists() else None
        if method in {"dialog.pickDirectory", "dialog.pickFile", "dialog.saveFile"}:
            return dialogs.request(method.removeprefix("dialog."), args)
        if method == "paths.documents":
            documents = Path.home() / "Documents"
            return str(documents if documents.exists() else Path.home())
        if method == "paths.userData":
            return str(DATA_DIR)
        if method == "paths.vaultDefault":
            vault = DATA_DIR / "vault"
            vault.mkdir(parents=True, exist_ok=True)
            return str(vault)
        if method == "app.version":
            return APP_VERSION
        # ---------------- win（2.1.0 新增）----------------
        if method == "win.isMaximized":
            WINDOW_BUS.isMaximizedReq.emit()
            return WINDOW_BUS._maximized
        if method == "win.toggleMaximize":
            WINDOW_BUS.toggleReq.emit()
            return None
        if method == "win.minimize":
            WINDOW_BUS.minimizeReq.emit()
            return None
        if method == "win.close":
            WINDOW_BUS.closeReq.emit()
            return None
        if method == "win.startDrag":
            WINDOW_BUS.startDragReq.emit()
            return None
        raise NotImplementedError("NOT_IMPLEMENTED")
    except FileNotFoundError:
        if method == "fs.stat":
            return None
        raise


BRIDGE_SCRIPT = r"""
(() => {
  const call = (method, args) => fetch('/__bridge/' + encodeURIComponent(method), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
  }).then(async response => {
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'BRIDGE_ERROR');
    return data.value;
  });
  const binaryFromBase64 = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const binaryToBase64 = value => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw);
  };
  window.NeoMD = {
    env: 'desktop', version: '__APP_VERSION__',
    bridge: {
      fs: {
        readText: p => call('fs.readText', [p]),
        readBinary: p => call('fs.readBinary', [p]).then(binaryFromBase64),
        writeText: (p, c) => call('fs.writeText', [p, c]),
        writeBinary: (p, d) => call('fs.writeBinary', [p, {base64: binaryToBase64(d)}]),
        mkdirp: p => call('fs.mkdirp', [p]), remove: p => call('fs.remove', [p]),
        rename: (a, b) => call('fs.rename', [a, b]), list: p => call('fs.list', [p]),
        exists: p => call('fs.exists', [p]), stat: p => call('fs.stat', [p])
      },
      dialog: {
        pickDirectory: () => call('dialog.pickDirectory', []),
        pickFile: filters => call('dialog.pickFile', [filters || []]),
        saveFile: defaultName => call('dialog.saveFile', [defaultName])
      },
      paths: { documents: () => call('paths.documents', []), userData: () => call('paths.userData', []), vaultDefault: () => call('paths.vaultDefault', []) },
      win: {
        isMaximized: () => call('win.isMaximized', []),
        toggleMaximize: () => call('win.toggleMaximize', []),
        minimize: () => call('win.minimize', []),
        close: () => call('win.close', []),
        startDrag: () => call('win.startDrag', [])
      },
      app: { version: () => call('app.version', []), onOpenFile: cb => { window.__neoMDOpenFile = cb; } }
    }
  };
})();
"""


class NeoMDHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    dialogs: DialogBridge

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path.startswith("/api/"):
            self.proxy_request()
            return
        if self.path in {"/", "/index.html"}:
            self.serve_index()
            return

        # ---------------- SPA 路由兜底（2.1.0 修复）----------------
        #
        # 前端用 history 模式路由，登录后地址会变成 `/app`。
        # 2.0.0 时代码只把 `/` 和 `/index.html` 交给 serve_index()，
        # 其余路径直接落到 SimpleHTTPRequestHandler —— 它在磁盘上找不到
        # `/app` 这个文件，返回 **404 空白页**。
        #
        # 用户侧表现：
        #   - 「打开后页面空白」（刷新 / 被系统恢复 URL 时）
        #   - 「登录无法打开」（登录后地址变成 /app，再加载就 404）
        #   - 页面里也没有 window.NeoMD（404 页面不含注入脚本），
        #     于是所有原生能力一起失效。
        #
        # 正确做法（Tauri / WinUI3 / Flutter 三版一直是这么做的）：
        # 路径能对应到磁盘文件就正常返回，否则一律回 index.html，
        # 让前端路由自己处理。这样深链接、刷新、前进后退都正常。
        local = (DIST_DIR / urllib.parse.unquote(self.path.split("?", 1)[0]).lstrip("/")).resolve()
        try:
            inside = str(local).startswith(str(DIST_DIR.resolve()))
        except Exception:
            inside = False
        if inside and local.is_file():
            super().do_GET()
            return
        self.serve_index()

    def do_POST(self) -> None:
        if self.path.startswith("/__bridge/"):
            self.handle_bridge()
            return
        if self.path.startswith("/api/"):
            self.proxy_request()
            return
        self.send_error(404)

    # ----------------------------------------------------------------
    # 把其余 REST 动词也交给反代（2.1.0 修复「登录成功但仓库不同步」）
    #
    # SimpleHTTPRequestHandler 只自带 do_GET / do_HEAD，
    # 其余动词一律回 **501 Unsupported method**。
    # 而前端同步引擎上传文档/清单用的是 PUT、删除用 DELETE、
    # 局部更新用 PATCH —— 于是每一次同步都在第一次上传就失败：
    #
    #   同步失败：上传失败（HTTP 501）
    #   → syncState 变 error，文档一篇都拉不下来
    #   → 用户看到「登录成功但仓库还是空的」。
    #
    # 另外 Tauri / WinUI3 / Flutter 三个壳都是自己写的 HTTP 服务，
    # 默认对所有方法放行，只有 Qt 版漏了这一层，才表现成「只有 Qt 不同步」。
    # ----------------------------------------------------------------
    def do_PUT(self) -> None:
        self._proxy_or_404()

    def do_DELETE(self) -> None:
        self._proxy_or_404()

    def do_PATCH(self) -> None:
        self._proxy_or_404()

    def do_HEAD(self) -> None:
        # HEAD 走 GET 的路径判断，但不写响应体
        if self.path.startswith("/api/"):
            self.proxy_request()
            return
        if self.path in {"/", "/index.html"} or not (DIST_DIR / self.path.lstrip("/")).is_file():
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:
        # 同源部署下浏览器一般不发预检；这里给一个通用响应，
        # 便于诊断工具与外部联调。
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def _proxy_or_404(self) -> None:
        if self.path.startswith("/api/"):
            self.proxy_request()
            return
        self.send_error(404)

    def serve_index(self) -> None:
        html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
        # 注入桥脚本时必须用替换过版本号的脚本，
        # 否则页面里看到的 version 是占位符 __APP_VERSION__
        script = BRIDGE_SCRIPT.replace("__APP_VERSION__", APP_VERSION)
        html = html.replace("<head>", "<head><script>" + script + "</script>", 1)
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_bridge(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            args = json.loads(self.rfile.read(size).decode("utf-8"))
            method = urllib.parse.unquote(self.path.removeprefix("/__bridge/"))
            # 桥参数既可能来自页面（数组），也可能来自诊断工具（对象）。
            # 统一归一化成 list，避免对象请求被当成空参数或直接报错。
            if isinstance(args, dict):
                args = [args] if args else []
            value = bridge_call(method, args, self.dialogs)
            self.send_json(200, {"ok": True, "value": value})
        except Exception as error:
            self.send_json(500, {"ok": False, "error": str(error) or error.__class__.__name__})

    def proxy_request(self) -> None:
        try:
            body = None
            if self.command in {"POST", "PUT", "PATCH", "DELETE"}:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            # 除逐跳头（hop-by-hop）外，把客户端请求头**原样透传**给上游。
            #
            # 这里曾只转发 Content-Type，直接导致登录虽然返回 200，
            # 但后续所有带 Authorization 的请求（/api/vaults、/api/storage/*）
            # 全部被上游判成未登录而返回 401 —— 表现为「能登录但仓库不同步」。
            # 鉴权头必须透传，否则登录形同虚设。
            SKIP_REQUEST_HEADERS = {
                "host",
                "connection",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
                "te",
                "trailer",
                "transfer-encoding",
                "upgrade",
                "content-length",  # 由 urllib 依据 body 自行计算
            }
            headers = {"x-neomd-shell": "qt"}
            for key, value in self.headers.items():
                if key.lower() in SKIP_REQUEST_HEADERS:
                    continue
                headers[key] = value
            # 反代自有标记优先级最高，避免被客户端伪造的同一头覆盖
            headers["x-neomd-shell"] = "qt"
            # ------------------------------------------------------------
            # 强制上游**不要压缩**响应（2.1.0 修复「登录成功但仓库为空」）
            #
            # 原来把浏览器的 `Accept-Encoding: gzip` 原样透传给上游，
            # 上游于是返回 gzip 压缩体；而下面写响应时又刻意跳过了
            # `content-encoding` 头，结果浏览器收到的是
            # 「没有任何编码标记的 gzip 字节」→ JSON.parse 直接失败。
            #
            # 用户侧表现正是：登录能成功（登录响应小，往往未压缩），
            # 但 /api/vaults 这类大响应解析不出来 → 仓库列表 0 个 →
            # 判定为「登录了但仓库不同步」。
            #
            # 这里显式要求 identity（不压缩），保证响应体是明文 JSON。
            # 另三个壳都是在解码后转发，行为由此对齐。
            # ------------------------------------------------------------
            headers["Accept-Encoding"] = "identity"

            # ------------------------------------------------------------
            # 阻止 urllib 凭空补 Content-Type（2.1.0 修复裸 DELETE 415）
            #
            # 实测直连上游同一个 URL：
            #   不带 Content-Type                                -> 401（正常进入鉴权分支）
            #   Content-Type: ""（空值）                         -> 415
            #   Content-Type: application/x-www-form-urlencoded  -> 415
            #
            # 即上游 Fastify 只要**看到** Content-Type 就按它解析，空值也不算缺省。
            # 而 CPython 的 AbstractHTTPHandler.do_request_ 在
            # `request.data is not None` 且没有 Content-Type 时会自动补
            # `application/x-www-form-urlencoded` —— 这正是桌面端「删除/同步
            # 偶尔 415、网页端却正常」的根因。
            #
            # 正确修法：无请求体时把 data 传 None（而不是 b"")，
            # urllib 就不会补这个头，请求与直连上游完全一致。
            # ------------------------------------------------------------
            request_data = body
            if body is not None and len(body) == 0:
                request_data = None

            request = urllib.request.Request(API_ORIGIN + self.path, data=request_data, method=self.command, headers=headers)
            # 显式禁用代理：本机 WinINET 系统代理曾被指向一个已关闭的本地端口，
            # urllib 默认会读取它，导致上游请求直接失败（登录都过不去）。
            # 反代目标固定为生产域名，直连更可靠。
            with PROXYLESS_OPENER.open(request, timeout=30) as response:
                payload = response.read()
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() not in {"connection", "transfer-encoding", "content-encoding", "content-length"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers(); self.wfile.write(payload)
        except urllib.error.HTTPError as error:
            payload = error.read()
            self.send_response(error.code); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
        except Exception as error:
            self.send_json(502, {"error": f"Proxy error: {error}"})

    def send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


class NeoMDServer:
    def __init__(self, dialogs: DialogBridge) -> None:
        handler = type("ConfiguredNeoMDHandler", (NeoMDHandler,), {"dialogs": dialogs})
        # 固定端口（2.1.0 修复）。
        #
        # 原来绑 ("127.0.0.1", 0) 让系统随机分配端口，意味着**每次启动 origin 都变**。
        # 浏览器 localStorage/IndexedDB 按 origin（协议+主机+端口）隔离，
        # 端口一变，登录态与全部设置就都读不到了 —— 用户表现是
        # 「登录过下次还要登录」「改了设置没生效」。
        #
        # 改为从 Qt 专属基端口起顺延尝试；只有极端情况（12 个端口全占）才退回随机，
        # 保证既能稳定复用 origin，又不会因端口冲突起不来。
        base_port = 51339
        last_error: Exception | None = None
        for offset in range(12):
            try:
                self.server = ThreadingHTTPServer(("127.0.0.1", base_port + offset), handler)
                break
            except OSError as error:
                last_error = error
        else:
            try:
                self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            except OSError as error:
                raise RuntimeError(f"无法绑定本地端口：{last_error or error}") from error
        self.thread = threading.Thread(target=self.server.serve_forever, name="neomd-http", daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/"

    def start(self) -> None:
        self.thread.start()
        # 写出 boot.json（2.1.0）。
        #
        # 其它三个壳都写这个文件，运维/诊断工具靠它找到本机服务端口，
        # 而不必去 netstat 里按 PID 反查（打包版 PID 与子进程关系还更绕）。
        # Qt 之前缺这一步，导致自动化验收只能猜端口，容易出现
        # 「测到的是上一次残留进程」这类误判。
        try:
            (DATA_DIR / "boot.json").write_text(
                json.dumps({
                    "at": datetime.datetime.now().astimezone().isoformat(),
                    "url": self.url,
                    "env": "desktop",
                    "version": APP_VERSION,
                    "up": True,
                }, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as error:
            print(json.dumps({"event": "bootJsonError", "error": str(error)}), flush=True)

    def stop(self) -> None:
        self.server.shutdown(); self.server.server_close()


class LoggingPage(QWebEnginePage):
    """把页面 console 转发到 stdout，便于运维与自动化验收排错。

    额外支持传入自定义 `QWebEngineProfile`（2.1.0）：
    默认的 `QWebEnginePage(parent)` 会挂到内存 profile 上，
    那样 localStorage 不会落盘，登录态无法跨重启保留。
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)

    def javaScriptConsoleMessage(self, level: Any, message: str, line_number: int, source_id: str) -> None:
        print(json.dumps({"event": "console", "level": int(level.value), "message": message, "line": line_number, "source": source_id}), flush=True)
        super().javaScriptConsoleMessage(level, message, line_number, source_id)


class MainWindow(QMainWindow):
    def __init__(self, server: NeoMDServer, start_time: float) -> None:
        super().__init__()
        self.server = server
        self.start_time = start_time
        self.setWindowTitle(f"{APP_NAME} {APP_VERSION}")
        self.resize(1440, 940)
        icon = BUNDLE_ROOT / "icon-512.png"
        if icon.exists(): self.setWindowIcon(QIcon(str(icon)))

        # ---------------- 标题栏合并（2.1.0）----------------
        #
        # 去掉系统标题栏，让 Web 前端自绘的 TabBar 成为唯一标题栏，
        # 与 Electron 版的视觉一致（用户明确要求「标题栏与顶部标签栏合并」）。
        # 保留系统边框能力：FramelessWindowHint 只隐藏标题栏，
        # 窗口仍可移动/缩放（缩放由 Qt 原生边缘处理）。
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        # 居中放置：无边框后系统不再自动居中
        self._center_on_screen()

        self.view = QWebEngineView(self)
        self.view.setPage(LoggingPage(self.view))
        self.setCentralWidget(self.view)

        # ---------------- 持久化 profile（2.1.0 关键修复）----------------
        #
        # 原来用 `QWebEngineProfile.defaultProfile()`，那是**内存 profile**：
        # cookie、localStorage、IndexedDB 全部只存在于进程内，进程一退出就没了。
        # 用户看到的就是最典型的抱怨——
        #   「明明登录成功了，下次打开又要重新登录」
        #   「改过的设置、字号、主题，重启后全变回去了」
        # 而且因为每次都是干净状态，也就永远拿不到「上次的仓库」。
        #
        # 改为把 profile 的存储路径指到 exe 同级 data/ 下（绿色版语义：
        # 不写注册表、不污染 %APPDATA%），并在析构时清理，
        # 使登录态与设置在重启后仍然保留。
        #
        # 注意：QWebEngineProfile 必须比 QWebEnginePage 活得久，
        # 因此挂在 self 上（而不是局部变量），否则页面会用到已销毁的 profile。
        profile_dir = DATA_DIR / "webengine"
        try:
            profile_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        self._profile = QWebEngineProfile("neomd", self)
        self._profile.setPersistentStoragePath(str(profile_dir / "storage"))
        self._profile.setCachePath(str(profile_dir / "cache"))
        # 允许 localStorage / cookie 持久化（默认值在不同 Qt 版本里不一致，显式声明更稳）
        try:
            self._profile.setPersistentCookiesPolicy(
                QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
            )
        except AttributeError:
            # 老版本 Qt 没有该枚举时忽略，storage 路径已足够
            pass

        self.view.setPage(LoggingPage(self._profile, self.view))

        script = QWebEngineScript()
        script.setName("neomd-native-bridge")
        script.setSourceCode(BRIDGE_SCRIPT.replace("__APP_VERSION__", APP_VERSION))
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        self._profile.scripts().insert(script)

        # 把窗口控制信号接到真正的窗口操作（HTTP 线程 → 主线程，线程安全）
        WINDOW_BUS.minimizeReq.connect(self.showMinimized)
        WINDOW_BUS.toggleReq.connect(self._toggle_maximize)
        WINDOW_BUS.closeReq.connect(self.close)
        WINDOW_BUS.startDragReq.connect(self._start_drag)
        WINDOW_BUS.isMaximizedReq.connect(self._publish_maximized)

        self.view.loadFinished.connect(self._loaded)
        self.view.load(QUrl(server.url))

    def _center_on_screen(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        available = screen.availableGeometry()
        width, height = 1440, 940
        self.resize(width, height)
        self.move(
            available.x() + max(0, (available.width() - width) // 2),
            available.y() + max(0, (available.height() - height) // 2),
        )

    def _toggle_maximize(self) -> None:
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()
        self._publish_maximized()

    def _publish_maximized(self) -> None:
        WINDOW_BUS._maximized = bool(self.isMaximized())

    def _start_drag(self) -> None:
        """
        由页面顶部拖拽区触发原生窗口拖动。

        浏览器控件不认 CSS 的 `-webkit-app-region: drag`，
        所以页面会显式调 win.startDrag()，这里用 Qt 自带的系统移动
        把拖动交给窗口管理器。
        """
        handle = self.windowHandle()
        if handle is not None and hasattr(handle, "startSystemMove"):
            handle.startSystemMove()

    @Slot(bool)
    def _loaded(self, ok: bool) -> None:
        elapsed = int((time.perf_counter() - self.start_time) * 1000)
        print(json.dumps({"event": "loadFinished", "ok": ok, "coldStartMs": elapsed, "url": self.view.url().toString()}), flush=True)
        if ok:
            self.view.page().runJavaScript("window.NeoMD && window.NeoMD.env", lambda env: print(json.dumps({"event": "bridgeCheck", "env": env}), flush=True))
        else:
            self.statusBar().showMessage("Neo MD failed to load")

    def closeEvent(self, event: Any) -> None:
        self.server.stop()
        super().closeEvent(event)


def main() -> int:
    if not DIST_DIR.exists():
        raise RuntimeError(f"Web dist not found: {DIST_DIR}")
    start_time = time.perf_counter()
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    dialogs = DialogBridge()
    server = NeoMDServer(dialogs)
    server.start()
    try:
        with urllib.request.urlopen(server.url, timeout=5) as response:
            print(json.dumps({"event": "serverCheck", "url": server.url, "status": response.status, "dist": str(DIST_DIR)}), flush=True)
    except Exception as error:
        print(json.dumps({"event": "serverCheck", "error": str(error), "dist": str(DIST_DIR)}), flush=True)
    window = MainWindow(server, start_time)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
