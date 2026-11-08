from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
DIST_SOURCE = PROJECT / "apps" / "web" / "dist"
# 发布目录要跟着版本走。之前这里写死 2.1.0，且 main() 一开始就 rmtree(RELEASE_ROOT)，
# 于是「构建 2.2.0」会把 2.1.0 的 Qt 产物直接删掉并覆盖 —— 既污染历史发布，
# 也让回滚失效。现在优先读环境变量 NEOMD_VERSION，未设置时从根 package.json 取。
def _default_version() -> str:
    r"""
    兜底版本号，从根 package.json 读，**不再硬编码**。

    为什么改：原先默认写死 "2.2.0"。构建 2.3.0 时脚本忘了传 NEOMD_VERSION，
    于是 main() 里那句 rmtree(RELEASE_ROOT) 把 releases\2.2.0\NeoMD-2.2.0-qt-x64
    **整个删掉并用 2.3.0 产物覆盖** —— 历史发布被污染，回滚路径失效。
    这正是本文件上面注释里描述过的事故，只是默认值本身又在重演它。

    从根 package.json 读版本后，bump-version.mjs 改一处，这里自动跟随，
    不会再出现"默认值和实际版本脱节"。
    """
    try:
        import json
        pkg = PROJECT / "package.json"
        return json.loads(pkg.read_text(encoding="utf-8"))["version"]
    except Exception:
        return "0.0.0"


APP_VERSION = os.environ.get("NEOMD_VERSION") or _default_version()
RELEASE_ROOT = Path(rf"C:\Data\BAC\neomd\releases\{APP_VERSION}\NeoMD-{APP_VERSION}-qt-x64")
BUILD_DIR = ROOT / "build"
PYINSTALLER_DIST = BUILD_DIR / "pyinstaller-dist"


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    if not DIST_SOURCE.is_dir():
        raise RuntimeError(f"Missing web build: {DIST_SOURCE}")
    run([sys.executable, "-m", "pip", "install", "--proxy=", "pyinstaller"])
    if RELEASE_ROOT.exists():
        shutil.rmtree(RELEASE_ROOT)
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "NeoMD", "--windowed", "--collect-all", "PySide6.QtWebEngineCore",
        "--collect-all", "PySide6.QtWebEngineWidgets", "--add-data", f"{DIST_SOURCE};web-dist",
        "--add-data", f"{DIST_SOURCE / 'icon-512.png'};.", "--distpath", str(PYINSTALLER_DIST),
        "--workpath", str(BUILD_DIR / "work"), "--specpath", str(BUILD_DIR / "spec"), str(ROOT / "main.py"),
    ])
    shutil.copytree(PYINSTALLER_DIST / "NeoMD", RELEASE_ROOT)
    shutil.copy2(ROOT / "RUN.md", RELEASE_ROOT / "RUN.md")
    print(f"Release created: {RELEASE_ROOT}")


if __name__ == "__main__":
    main()
