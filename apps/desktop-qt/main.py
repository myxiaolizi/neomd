from __future__ import annotations

import base64
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

from PySide6.QtCore import QObject, QUrl, Signal, Slot
from PySide6.QtGui import QIcon
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow

APP_NAME = "Neo MD"
APP_VERSION = "2.0.0"
API_ORIGIN = "https://md.zhengl.vip"


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
    env: 'desktop', version: '2.0.0',
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
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/__bridge/"):
            self.handle_bridge()
            return
        if self.path.startswith("/api/"):
            self.proxy_request()
            return
        self.send_error(404)

    def serve_index(self) -> None:
        html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace("<head>", "<head><script>" + BRIDGE_SCRIPT + "</script>", 1)
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
            value = bridge_call(method, args if isinstance(args, list) else [], self.dialogs)
            self.send_json(200, {"ok": True, "value": value})
        except Exception as error:
            self.send_json(500, {"ok": False, "error": str(error) or error.__class__.__name__})

    def proxy_request(self) -> None:
        try:
            body = None
            if self.command in {"POST", "PUT", "PATCH", "DELETE"}:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            headers = {"x-neomd-shell": "qt"}
            if self.headers.get("Content-Type"):
                headers["Content-Type"] = self.headers["Content-Type"]
            request = urllib.request.Request(API_ORIGIN + self.path, data=body, method=self.command, headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
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
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="neomd-http", daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown(); self.server.server_close()


class LoggingPage(QWebEnginePage):
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
        self.view = QWebEngineView(self)
        self.view.setPage(LoggingPage(self.view))
        self.setCentralWidget(self.view)
        profile = QWebEngineProfile.defaultProfile()
        script = QWebEngineScript()
        script.setName("neomd-native-bridge")
        script.setSourceCode(BRIDGE_SCRIPT)
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        profile.scripts().insert(script)
        self.view.loadFinished.connect(self._loaded)
        self.view.load(QUrl(server.url))

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
