/**
 * Neo MD 桌面端主进程。
 * - 加载同一份 Web 构建产物（file:// 加载 dist/index.html）
 * - 通过 preload 暴露受控的文件系统 / 加密 / 打印 / 对话框能力
 * - 单实例 + .md 文件关联打开
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');

const isDev = process.argv.includes('--dev');
const APP_VERSION = require('./package.json').version;

/** 启动日志：便于排查打包后启动失败（userData 需等 app ready 后才可用） */
let logFile = null;
function log(...args) {
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'neomd-main.log');
    const line = `[${new Date().toISOString()}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`;
    fsSync.appendFileSync(logFile, line);
  } catch {
    /* 日志失败不影响运行 */
  }
}

process.on('uncaughtException', (err) => {
  log('uncaughtException', err && err.stack ? err.stack : String(err));
  try {
    dialog.showErrorBox('Neo MD 启动异常', String(err && err.message ? err.message : err));
  } catch {
    /* ignore */
  }
  app.quit();
});
process.on('unhandledRejection', (err) => {
  log('unhandledRejection', err && err.stack ? err.stack : String(err));
});

/** 待打开的文件（来自命令行或文件关联） */
let pendingOpenFile = null;
let mainWindow = null;

/**
 * 自定义标题栏高度（px）。
 * 必须与 packages/ui 里的 `--titlebar-h` 以及页面标签栏高度保持一致，
 * 否则 Windows 的原生窗口按钮覆盖层（WCO）会与网页标题栏错位，出现「顶部一条不能拖/挡不住」的问题。
 */
const TITLEBAR_HEIGHT = 40;

/**
 * 兜底拖拽样式。
 * 拖拽区本身由 packages/ui 的 `.nm-drag` 规则提供，这里再注入一份等价规则，
 * 目的是防止构建产物里漏掉该规则（或产物落后于源码）时，整个窗口彻底无法拖动。
 * 重复声明同值样式没有副作用。
 */
const DRAG_FALLBACK_CSS = `
html[data-runtime='desktop'] .nm-drag {
  -webkit-app-region: drag;
  app-region: drag;
  -webkit-user-select: none;
  user-select: none;
}
html[data-runtime='desktop'] .nm-drag button,
html[data-runtime='desktop'] .nm-drag a,
html[data-runtime='desktop'] .nm-drag input,
html[data-runtime='desktop'] .nm-drag textarea,
html[data-runtime='desktop'] .nm-drag select,
html[data-runtime='desktop'] .nm-drag [role='button'],
html[data-runtime='desktop'] .nm-drag [role='tab'],
html[data-runtime='desktop'] .nm-drag [contenteditable='true'],
html[data-runtime='desktop'] .nm-drag .no-drag {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
`;

/**
 * 推送窗口最大化状态给渲染进程。
 * 供 `app:window-state` 事件与 IPC 主动调用复用，避免多处各写一份。
 */
function pushWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('app:window-state', { maximized: win.isMaximized() });
  } catch {
    /* 窗口正在销毁时忽略 */
  }
}

/** 自定义协议：把前端资源映射到 resources/webdist */
const APP_SCHEME = 'neomd';
let webRoot = null;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function registerProtocolHandler() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      // 兜底：若页面上有未转成远程地址的 /api/* 请求，直接转发到线上服务端而非返回本地 index.html
      if (rel === 'api' || rel.startsWith('api/')) {
        const remoteUrl = `https://md.zhengl.vip/${rel}${url.search || ''}`;
        return net.fetch(remoteUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          duplex: 'half',
        });
      }
      if (!rel || rel === 'index.html') rel = 'index.html';
      const root = webRoot;
      if (!root) return new Response('web root not ready', { status: 500 });
      let target = path.join(root, rel);
      // 防止路径穿越
      const normalizedRoot = path.resolve(root) + path.sep;
      if (!path.resolve(target).startsWith(normalizedRoot) && path.resolve(target) !== path.resolve(root)) {
        return new Response('forbidden', { status: 403 });
      }
      // SPA 回退：无扩展名或不存在时返回 index.html
      if (!fsSync.existsSync(target) || fsSync.statSync(target).isDirectory()) {
        target = path.join(root, 'index.html');
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch (e) {
      log('protocol error', String(e));
      return new Response('not found', { status: 404 });
    }
  });
}

function resolveWebDist() {
  const candidates = [];
  // 打包后：extraResources 放在 resources/webdist
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'webdist'));
    candidates.push(path.join(process.resourcesPath, 'app', 'web'));
  }
  // asar 内（若把 web 打进 asar）
  candidates.push(path.join(__dirname, 'web'));
  // 开发态：apps/desktop/../web/dist
  candidates.push(path.join(__dirname, '..', 'web', 'dist'));
  candidates.push(path.join(process.cwd(), '..', 'web', 'dist'));

  for (const dir of candidates) {
    if (fsSync.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error(
    '找不到 Web 构建产物。已尝试：\n' + candidates.join('\n') + '\n请先执行 pnpm --filter @neomd/web build 后重新打包。',
  );
}

/**
 * 创建应用窗口。
 *
 * 1.1.7 起支持传参，用于「移动到新窗口」：
 * - `cascade`：级联偏移像素。多个窗口完全重叠时用户会以为"没打开"，偏移一点更直观；
 * - `from`：参考窗口的 bounds（父窗口位置），以它为基准做级联；
 * - `route`：追加到 URL 上的查询串（如 `?doc=<docId>`），新窗口启动后据此打开指定文档。
 *
 * 之所以用 URL 传文档 id、而不是 `webContents.send`：新窗口此刻还没 did-finish-load，
 * 直接 send 会丢事件；URL 是窗口自身加载时就带的，最稳。
 *
 * 每次调用都会新建一个独立 BrowserWindow，因此天然支持多窗口同时运行。
 * （`app.requestSingleInstanceLock()` 限制的是"第二个应用进程"，不影响同一进程内多窗口。）
 */
function createWindow(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const cascade = Number.isFinite(options.cascade) ? options.cascade : 0;
  const from = options.from && typeof options.from === 'object' ? options.from : null;
  const route = typeof options.route === 'string' ? options.route : '';

  const windowOptions = {
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171c' : '#f7f8fa',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    // color 透明 + height 与页面标题栏一致：原生按钮浮在网页右上角，不占位、不错位
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e6e9ee' : '#1a1d21',
            height: TITLEBAR_HEIGHT,
          }
        : undefined,
    // frame 保持 true：保留系统阴影、贴边、Aero Snap 等窗口能力，标题栏只由 titleBarStyle 隐藏
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: true,
    },
  };

  // 多窗口级联定位：以父窗口（或主屏）左上角为基准偏移，并夹在工作区内避免跑出屏幕
  if (cascade > 0) {
    const area = from ? screen.getDisplayMatching(from).workArea : screen.getPrimaryDisplay().workArea;
    const anchorX = from ? from.x : area.x;
    const anchorY = from ? from.y : area.y;
    windowOptions.x = Math.max(area.x, Math.min(anchorX + cascade, area.x + area.width - windowOptions.width));
    windowOptions.y = Math.max(area.y, Math.min(anchorY + cascade, area.y + area.height - windowOptions.height));
  }

  const win = new BrowserWindow(windowOptions);

  // 显式确认窗口可移动（Windows/macOS 均支持），排除被外部代码误禁用的可能
  try {
    win.setMovable(true);
  } catch {
    /* 平台不支持时忽略 */
  }

  const dist = resolveWebDist();
  log('web dist =', dist);
  webRoot = dist;
  // 通过自定义协议在根路径托管前端，本机版直接进入 /app 编辑器，不展示网页营销首页。
  // route 用于「移动到新窗口」时把文档 id 带过去。
  const targetUrl = `${APP_SCHEME}://neomd/app${route}`;
  win.loadURL(targetUrl).catch((e) => {
    log('loadURL failed', String(e && e.stack ? e.stack : e));
    dialog.showErrorBox('启动失败', String(e && e.message ? e.message : e));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('did-fail-load', code, desc);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', JSON.stringify(details));
  });
  win.webContents.on('console-message', (_e, level, message) => {
    log('renderer:', level, message);
  });

  win.once('ready-to-show', () => win.show());

  // 运行平台标记尽早写入：App.vue 的 onMounted 才设置时，首帧到挂载之间存在样式空窗，
  // 这里在 DOM 就绪阶段先写一次，让标题栏拖拽区从第一帧起就可用（App.vue 再写一次同样值，无副作用）。
  win.webContents.on('dom-ready', () => {
    win.webContents
      .executeJavaScript(
        "if (!document.documentElement.dataset.runtime) { document.documentElement.dataset.runtime = 'desktop'; }",
      )
      .catch(() => undefined);
    // 兜底注入拖拽样式（见 DRAG_FALLBACK_CSS 注释）
    win.webContents.insertCSS(DRAG_FALLBACK_CSS).catch((e) => log('insertCSS failed', String(e)));
  });

  // 窗口最大化状态回传：渲染进程据此更新自定义标题栏样式
  /** 最大化前的常规窗口尺寸，用于还原后校正尺寸 */
  let normalBoundsBeforeZoom = null;
  win.on('maximize', () => {
    try {
      normalBoundsBeforeZoom = win.getNormalBounds();
    } catch {
      normalBoundsBeforeZoom = null;
    }
    pushWindowState(win);
  });
  win.on('unmaximize', () => {
    pushWindowState(win);
    // 已知问题：titleBarOverlay + 最大化/还原后偶发高度溢出（窗口比工作区还高，底部被裁掉）。
    // 这里只在「确实溢出工作区」时用最大化前的常规尺寸校正，避免干扰用户自己的窗口调整与 Aero Snap。
    const target = normalBoundsBeforeZoom;
    normalBoundsBeforeZoom = null;
    if (!target || process.platform !== 'win32') return;
    setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
      try {
        const cur = win.getBounds();
        const area = screen.getDisplayMatching(cur).workArea;
        const overflow = cur.height > area.height || cur.width > area.width;
        if (overflow) {
          win.setBounds({
            x: Math.max(area.x, Math.min(cur.x, area.x + area.width - target.width)),
            y: Math.max(area.y, Math.min(cur.y, area.y + area.height - target.height)),
            width: Math.min(target.width, area.width),
            height: Math.min(target.height, area.height),
          });
          log('unmaximize bounds corrected', JSON.stringify({ from: cur, area }));
        }
      } catch (e) {
        log('unmaximize bounds fix failed', String(e));
      }
    }, 80);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 自检模式：等待渲染完成后截图并退出
  const shotIdx = process.argv.indexOf('--shot');
  if (shotIdx > -1) {
    const shotPath = process.argv[shotIdx + 1];
    const routeIdx = process.argv.indexOf('--route');
    const route = routeIdx > -1 ? process.argv[routeIdx + 1] : '';
    if (route) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          win.webContents.executeJavaScript(`location.hash = ''; history.pushState({}, '', ${JSON.stringify(route)}); location.reload();`).catch(() => undefined);
        }, 800);
      });
    }
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const scriptIdx = process.argv.indexOf('--script');
          if (scriptIdx > -1) {
            const scriptPath = process.argv[scriptIdx + 1];
            const code = fsSync.readFileSync(scriptPath, 'utf8');
            const result = await win.webContents.executeJavaScript(code);
            log('script result', JSON.stringify(result));
            await new Promise((r) => setTimeout(r, 2500));
          }
          const image = await win.webContents.capturePage();
          await fs.writeFile(shotPath, image.toPNG());
          log('screenshot saved', shotPath);
        } catch (e) {
          log('screenshot failed', String(e && e.stack ? e.stack : e));
        }
        app.exit(0);
      }, route ? 9000 : 6000);
    });
  }

  return win;
}

/* ---------------- IPC：文件系统 ---------------- */

function guard(p) {
  if (typeof p !== 'string' || !p) throw new Error('非法路径');
  return p;
}

ipcMain.handle('fs:readText', async (_e, p) => fs.readFile(guard(p), 'utf8'));
ipcMain.handle('fs:readBinary', async (_e, p) => {
  const buf = await fs.readFile(guard(p));
  return new Uint8Array(buf);
});
ipcMain.handle('fs:writeText', async (_e, p, content) => {
  await fs.mkdir(path.dirname(guard(p)), { recursive: true });
  await fs.writeFile(guard(p), content, 'utf8');
});
ipcMain.handle('fs:writeBinary', async (_e, p, data) => {
  await fs.mkdir(path.dirname(guard(p)), { recursive: true });
  await fs.writeFile(guard(p), Buffer.from(data));
});
ipcMain.handle('fs:mkdirp', async (_e, p) => {
  await fs.mkdir(guard(p), { recursive: true });
});
ipcMain.handle('fs:remove', async (_e, p) => {
  await fs.rm(guard(p), { recursive: true, force: true });
});
ipcMain.handle('fs:rename', async (_e, from, to) => {
  await fs.mkdir(path.dirname(guard(to)), { recursive: true });
  await fs.rename(guard(from), guard(to));
});
ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    await fs.access(guard(p));
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('fs:stat', async (_e, p) => {
  try {
    const st = await fs.stat(guard(p));
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
});
ipcMain.handle('fs:list', async (_e, p) => {
  const dir = guard(p);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(path.join(dir, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* 忽略无权限条目 */
    }
    out.push({ name: e.name, isDirectory: e.isDirectory(), size, mtime });
  }
  return out;
});

/* ---------------- IPC：窗口控制（自定义标题栏用） ---------------- */

function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

ipcMain.handle('window:isMaximized', (event) => senderWindow(event)?.isMaximized() ?? false);

/**
 * 新建一个独立的应用窗口（1.1.7，多窗口）。
 *
 * 用户原话：「修复标签栏右键在移动至新窗口功能不可用的问题，可同时打开程序多个窗口」。
 *
 * 关键点：
 * 1. `createWindow()` 每次都会新建一个 BrowserWindow，多窗口天然可行；
 *    `mainWindow` 只用于「第二个实例激活时聚焦哪个窗口」等兜底，不限制窗口数量。
 * 2. 传进来的 `docId` / `route` 通过 URL hash 交给新窗口，渲染层启动后自行打开该文档。
 *    用 query 而不是 IPC 推送，是因为新窗口的 webContents 此时还没加载完，直接 send 会丢。
 * 3. 位置做级联偏移，避免多个窗口完全重叠、用户以为"没打开"。
 */
ipcMain.handle('window:newWindow', async (event, docId) => {
  log('window:newWindow', 'docId=' + String(docId ?? ''));
  const parent = senderWindow(event);
  const cascade = (BrowserWindow.getAllWindows().length % 8) * 28;
  const win = createWindow({
    cascade,
    // 以父窗口当前位置为基准做级联，多窗口不会叠在一起
    from: parent && !parent.isDestroyed() ? parent.getBounds() : null,
    route: docId ? `?doc=${encodeURIComponent(String(docId))}` : '',
  });
  return win.id;
});

/**
 * 切换最大化 / 还原。
 *
 * Windows 上 maximize()/unmaximize() 是异步生效的，调用后立刻读 isMaximized() 可能还是旧值，
 * 因此这里返回「目标状态」（下一次的真实状态），并由 `app:window-state` 事件推送实际结果修正；
 * 同时补一次延迟推送，保证即使事件因窗口状态特殊（如贴边 Snapping）未触发，渲染层也能同步。
 */
ipcMain.handle('window:toggleMaximize', (event) => {
  const win = senderWindow(event);
  if (!win || win.isDestroyed()) return false;
  const next = !win.isMaximized();
  try {
    if (next) win.maximize();
    else win.unmaximize();
  } catch (e) {
    log('toggleMaximize failed', String(e));
    return win.isMaximized();
  }
  setTimeout(() => pushWindowState(win), 120);
  return next;
});

ipcMain.handle('window:minimize', (event) => {
  senderWindow(event)?.minimize();
});

ipcMain.handle('window:close', (event) => {
  senderWindow(event)?.close();
});

/* ---------------- IPC：对话框与系统 ---------------- */

ipcMain.handle('dialog:pickDirectory', async () => {
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

ipcMain.handle('dialog:pickFile', async (_e, filters) => {
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openFile'],
    filters: (filters ?? ['md']).map((ext) => ({ name: ext.toUpperCase(), extensions: [ext] })),
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

ipcMain.handle('dialog:saveFile', async (_e, defaultName) => {
  const res = await dialog.showSaveDialog(mainWindow ?? undefined, { defaultPath: defaultName });
  return res.canceled ? null : (res.filePath ?? null);
});

ipcMain.handle('paths:documents', async () => app.getPath('documents'));
ipcMain.handle('paths:userData', async () => app.getPath('userData'));
ipcMain.handle('paths:vaultDefault', async () => {
  const p = path.join(app.getPath('documents'), 'Neo MD');
  await fs.mkdir(p, { recursive: true });
  return p;
});

ipcMain.handle('secrets:encrypt', async (_e, plain) => {
  if (!safeStorage.isEncryptionAvailable()) return plain;
  return safeStorage.encryptString(String(plain)).toString('base64');
});
ipcMain.handle('secrets:decrypt', async (_e, cipher) => {
  if (!safeStorage.isEncryptionAvailable()) return String(cipher);
  try {
    return safeStorage.decryptString(Buffer.from(String(cipher), 'base64'));
  } catch {
    return '';
  }
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (/^https?:/.test(String(url))) await shell.openExternal(String(url));
});
ipcMain.handle('shell:showItemInFolder', async (_e, p) => {
  const full = path.resolve(guard(p));
  try {
    const st = await fs.stat(full);
    if (st.isDirectory()) {
      await shell.openPath(full);
    } else {
      shell.showItemInFolder(full);
    }
  } catch {
    await shell.openPath(path.dirname(full));
  }
});
ipcMain.handle('app:version', async () => APP_VERSION);

/** 用打印引擎生成真正的 PDF */
ipcMain.handle('app:printToPdf', async (_e, html, title) => {
  const tmpDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'neomd-pdf-'));
  const htmlPath = path.join(tmpDir, 'doc.html');
  await fs.writeFile(htmlPath, String(html), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },
    });
    const safeTitle = String(title || 'document').replace(/[\\/:*?"<>|]/g, ' ');
    const res = await dialog.showSaveDialog(mainWindow ?? undefined, {
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!res.canceled && res.filePath) {
      await fs.writeFile(res.filePath, pdf);
      return res.filePath;
    }
    return '';
  } finally {
    win.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/* ---------------- 文件关联 ---------------- */

function extractFileArg(argv) {
  const args = argv.slice(isDev ? 2 : 1);
  for (const a of args) {
    if (/\.(md|markdown|board|base)$/i.test(a) && fsSync.existsSync(a)) return path.resolve(a);
  }
  return null;
}

function openFileInWindow(filePath) {
  if (!mainWindow) return;
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('app:open-file', filePath));
  } else {
    mainWindow.webContents.send('app:open-file', filePath);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = extractFileArg(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) openFileInWindow(file);
    }
  });

  app.whenReady().then(() => {
    log('--- start ---', 'argv=' + JSON.stringify(process.argv), 'resourcesPath=' + process.resourcesPath);
    registerProtocolHandler();
    pendingOpenFile = extractFileArg(process.argv);
    mainWindow = createWindow();
    if (pendingOpenFile) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('app:open-file', pendingOpenFile);
        pendingOpenFile = null;
      });
    }
    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('app:theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
