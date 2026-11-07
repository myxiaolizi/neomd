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
# 也让回滚失效。现在从环境变量 NEOMD_VERSION 取版本，默认 2.2.0。
APP_VERSION = os.environ.get("NEOMD_VERSION", "2.2.0")
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
