# Neo MD Qt Green Edition

## Run

Double-click `NeoMD.exe` in this directory. The application is a portable Windows x64 build and does not require a system Python installation.

## Data location

Portable user data is stored in `data/` next to `NeoMD.exe`. The default vault is `data/vault/`.

## Included runtime

The build includes Python 3.12 runtime components, PySide6 6.12, and QtWebEngine. It hosts the bundled Neo MD web build on a loopback-only HTTP server and proxies `/api/*` to `https://md.zhengl.vip` with `x-neomd-shell: qt`.

## Known behavior

- The first start can be slower while QtWebEngine initializes its Chromium profile.
- The packaged build enables QtWebEngine's `--no-sandbox` Chromium switch. This is required for this PyInstaller `onedir` layout on the tested Windows host; only the loopback server is exposed.
- Network features require access to `https://md.zhengl.vip`; the editor shell can still load offline.
- File dialogs use the standard Windows file picker.
