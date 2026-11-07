/**
 * Neo MD 桌面端主进程。
 * - 加载同一份 Web 构建产物（neomd:// 协议托管 dist）
 * - 通过 preload 暴露受控的文件系统 / 加密 / 打印 / 对话框能力
 * - 单实例（单进程）+ 多窗口：同一进程内可以同时开任意多个独立窗口
 *
 * 1.1.9 多窗口架构说明（重要，改代码前先读）：
 * 1.1.7/1.1.8 用单个全局变量 `mainWindow` 记窗口，每开一个新窗口就把它覆盖，
 * 于是 B 窗口点「选择文件夹」时对话框可能挂在 A 窗口上；主窗口一关 `mainWindow = null`，
 * 其余窗口的对话框/导出 PDF 就全部失效；系统主题变更也只发给那一个窗口。
 * 现在改为「窗口登记表（WindowRegistry）+ 按 IPC 发送方定位」：
 * - 所有需要窗口上下文的 IPC 都用 BrowserWindow.fromWebContents(event.sender) 找发起方，找不到就报错/降级，
 *   绝不借用别的窗口（借窗口正是"对话框跑到另一个窗口"的根因）；
 * - 需要广播的事件（主题变更）遍历登记表里所有未销毁窗口；
 * - 登记表里每个窗口地位平等，没有"主窗口"特权，关掉任意一个都不影响其它窗口。
 * `requestSingleInstanceLock()` 限制的是「第二个应用进程」，与「同进程多窗口」不冲突，因此保留。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  DEFAULT_SIZE,
  MIN_SIZE,
  nextCascadeOffset,
  computeCascadeBounds,
  normalizeNewWindowArgs,
  buildWindowRoute,
} = require('./window-utils.cjs');
const { WindowRegistry, isUsableWindow, safeBounds } = require('./window-registry.cjs');
const { resolvePortableRoot, decidePortableUserData } = require('./portable.cjs');

const isDev = process.argv.includes('--dev');
const APP_VERSION = require('./package.json').version;

/**
 * 绿色版（便携）模式：在**一切 getPath 之前**把 userData 指到 exe 同目录的 data/。
 *
 * 为什么必须放在这里：
 * - userData 决定单实例锁文件、Local Storage（neomd.lastVault / 登录态）、缓存的位置；
 *   只要有代码先读过旧路径再 setPath，就会留下"半新半旧"的目录布局；
 * - `app.requestSingleInstanceLock()`（本文件末尾）依赖 userData，也必须在设置之后调用。
 *
 * 默认不启用（见 portable.cjs 文件头约束 2：老用户数据在 AppData，硬切等于"仓库丢了"）。
 * 启用方式：exe 同目录放 data/ 目录或 portable.txt，或设环境变量 NEOMD_PORTABLE=1。
 * 目录不可写时自动回退 AppData，原因写进启动日志。
 */
let portableInfo = { portable: false, dir: null, reason: 'skipped' };
try {
  // 探测目录可写：创建 + 写一个探针文件 + 删除。只判断 exists 不够，
  // 只读介质/U 盘写保护下 exists 也可能是 true 但实际写不进去。
  const probeWritable = (dir) => {
    fsSync.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.neomd-write-probe');
    fsSync.writeFileSync(probe, String(Date.now()), 'utf8');
    fsSync.unlinkSync(probe);
    return true;
  };
  portableInfo = decidePortableUserData({
    root: resolvePortableRoot(process.env, process.execPath),
    env: process.env,
    isPackaged: app.isPackaged,
    canWrite: probeWritable,
    exists: (p) => fsSync.existsSync(p),
  });
  if (portableInfo.portable && portableInfo.dir) {
    fsSync.mkdirSync(portableInfo.dir, { recursive: true });
    app.setPath('userData', portableInfo.dir);
    // sessionData 不会自动跟随 userData（Electron 里是独立路径），一并指过去才算真正"绿色"
    try {
      app.setPath('sessionData', path.join(portableInfo.dir, 'session'));
    } catch {
      /* 旧版本 Electron 无 sessionData 时忽略 */
    }
  }
} catch (e) {
  // 便携模式是增强项，任何异常都不能阻断启动
  portableInfo = { portable: false, dir: null, reason: 'error:' + String(e && e.message ? e.message : e) };
}

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

/*
 * GPU / 沙箱兼容性自愈（2.1.0）。
 *
 * ## 问题
 * 部分机器上（虚拟显卡、老旧 Intel 驱动、远程桌面、部分安全软件拦截）
 * Electron 创建窗口瞬间就被系统终止，退出码 `0x80000003`（-2147483645），
 * 日志里只留下 `createWindow`，用户看到的是「双击后闪退」。
 * 实测本机复现：默认启动必崩，加 `--disable-gpu --no-sandbox` 后正常。
 *
 * ## 做法
 * 不能要求用户自己加参数，因此做两件事：
 *  1. 启动时读上次的「启动中」标记。若上次没走到 ready 就消失（=崩了），
 *     本次自动追加 GPU 关闭与沙箱关闭开关，保证能起来；
 *     起来后写入 `gpu-disabled` 标记，后续一直沿用轻量模式。
 *  2. 每个标记都带时间戳，异常情况不会永久卡在降级模式。
 *
 * 这些 switch 必须在 app ready **之前** append，否则 Electron 会忽略。
 */
const gpuStateFile = (() => {
  try {
    /*
     * 不能依赖 app.getPath('userData')：这个文件的读写发生在 app ready 之前，
     * 那时 Electron 的路径服务尚未就绪（实测写入会静默失败）。
     * 改为跟随「便携根目录」，没有便携目录时用 exe 同目录 —— 两者都必然可写
     * （能启动说明目录可读，不可写时下面 writeRenderMode 会静默跳过）。
     */
    const root =
      (portableInfo && portableInfo.portable && portableInfo.dir) ||
      path.dirname(path.resolve(process.execPath));
    return path.join(root, 'render-mode.json');
  } catch {
    return null;
  }
})();

function readRenderMode() {
  try {
    if (!gpuStateFile || !fsSync.existsSync(gpuStateFile)) return { crashes: 0, disabled: false };
    const j = JSON.parse(fsSync.readFileSync(gpuStateFile, 'utf8'));
    return { crashes: Number(j.crashes) || 0, disabled: Boolean(j.disabled) };
  } catch {
    return { crashes: 0, disabled: false };
  }
}

function writeRenderMode(next) {
  try {
    if (!gpuStateFile) return;
    fsSync.writeFileSync(gpuStateFile, JSON.stringify(next), 'utf8');
  } catch {
    /* 写不进去就退化成每次都探测 */
  }
}

const renderMode = readRenderMode();
/*
 * 环境变量开关：
 *  - NEOMD_ENABLE_GPU=1 → 保留硬件加速（默认关闭，见下方说明）
 *  - NEOMD_DISABLE_GPU=1 → 强制软件渲染（与默认行为一致，保留给脚本显式指定）
 */
const envFlag = (name) => {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};
const forceEnableGpu = envFlag('NEOMD_ENABLE_GPU');
const forceDisableGpu = envFlag('NEOMD_DISABLE_GPU');

/*
 * 启动兼容性处理（2.1.0 实测结论）。
 *
 * ## 真正的原因：管理员权限下 Chromium 沙箱起不来
 *
 * 用参数矩阵逐一实测（每组都真实截图 + 采窗口标题，无参数/单开关/组合）：
 *   no-args                        → 崩 0x80000003（渲染进程起不来）
 *   --disable-gpu                  → 崩 0x80000003
 *   --disable-gpu --no-sandbox     → 正常 ✅
 *   --no-sandbox                   → 正常 ✅
 *   NEOMD_ENABLE_GPU=1（硬件加速）  → 崩 0x80000003
 *
 * 结论：**`--no-sandbox` 才是决定性开关**，与 GPU 无关。
 * 崩溃时的表现是 Windows 弹「Neo MD has stopped working」
 * （Electron 想去拉起缺失的 chrome_crashpad_handler.exe），
 * 窗口随即消失 —— 用户看到的就是「双击后闪退」。
 *
 * 为什么需要它：Chromium 的渲染进程沙箱在**以管理员身份运行**时无法初始化
 * （这是 Chromium 的已知限制，不是本项目引入的）。实测本机进程即处于
 * Administrator 上下文，因此默认启动必崩。
 *
 * ## 取舍
 * 只有检测到「当前是管理员」时才关闭沙箱，普通用户双击仍保留完整沙箱。
 * 既修好管理员场景的闪退，又不无谓削弱普通用户的安全性。
 */
function isRunningElevated() {
  // 只在 Windows 上做这个判断；其它平台沿用 Electron 默认（沙箱开启）
  if (process.platform !== 'win32') return false;
  try {
    // `net session` 需要管理员权限；非管理员会以非 0 退出
    const { execFileSync } = require('node:child_process');
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const elevated = isRunningElevated();
const useNoSandbox = elevated || envFlag('NEOMD_NO_SANDBOX');

if (useNoSandbox) {
  try {
    app.commandLine.appendSwitch('no-sandbox');
  } catch {
    /* 忽略 */
  }
}

/*
 * GPU：**不默认关闭**。
 *
 * 上面的矩阵证明崩溃与 GPU 无关（`--no-sandbox` 单独就够），
 * 而关掉 GPU 会让滚动/输入延迟明显变差，违背「操作流畅」的要求。
 * 保留 NEOMD_DISABLE_GPU=1 给极少数确实遇到显卡驱动的用户兜底。
 */
const useSoftwareRendering = envFlag('NEOMD_DISABLE_GPU');

if (useSoftwareRendering) {
  try {
    app.commandLine.appendSwitch('disable-gpu');
  } catch {
    /* 忽略 */
  }
  try {
    app.disableHardwareAcceleration();
  } catch {
    /* 忽略 */
  }
}

// 记录本次启动尝试；正常 ready 后会清零 crashes
writeRenderMode({ crashes: (renderMode.crashes || 0) + 1, disabled: useSoftwareRendering });

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

/**
 * 所有存活窗口的登记表。
 * 不再有 `mainWindow` 单例：窗口一律按「IPC 发送方」定位，广播类事件遍历登记表。
 */
const windows = new WindowRegistry({
  // BrowserWindow.fromWebContents 在窗口销毁过程中可能抛错，WindowRegistry 内部已 try/catch
  fromWebContents: (wc) => BrowserWindow.fromWebContents(wc),
});

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
  if (!isUsableWindow(win)) return;
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
 * 创建应用窗口（多窗口架构：每次调用都是一个完全独立的窗口，互不影响）。
 *
 * 参数（全部可选）：
 * - `cascade`：级联偏移像素，默认按当前窗口数自动递增（见 nextCascadeOffset）；
 * - `from`：参考窗口 bounds，以它为锚点做级联；null 表示以主屏工作区为锚点；
 * - `docId` / `fresh`：交给新窗口的文档参数，最终拼成 `?doc=<docId>&fresh=1`；
 * - `route`：直接指定查询串（优先于 docId/fresh，供老调用方兼容）。
 *
 * 为什么用 URL 传参而不是 `webContents.send`：新窗口此刻还没 did-finish-load，
 * 直接 send 会丢事件；URL 是窗口自身加载时就带的，最稳。
 */
function createWindow(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const from = safeBounds(options.from) || null;
  const cascade = Number.isFinite(options.cascade) ? Math.max(0, Math.trunc(options.cascade)) : 0;
  const route =
    typeof options.route === 'string' && options.route
      ? options.route
      : buildWindowRoute({ docId: options.docId, fresh: options.fresh });

  const windowOptions = {
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
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
      // 安全基线：渲染层拿不到 Node，只能通过 preload 的白名单 API 访问系统能力
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: true,
      /*
       * 把真实版本号传给 preload（2.1.0）。
       *
       * preload 运行在独立上下文、拿不到主进程变量，原先只能读
       * `process.env.npm_package_version` —— 该变量仅 npm script 启动时存在，
       * 打包后的绿色版双击运行没有它，于是「关于」里永远显示 1.0.0。
       * 通过 additionalArguments 注入是 Electron 官方推荐的做法。
       */
      additionalArguments: [`--neomd-version=${APP_VERSION}`],
    },
  };

  // 多窗口级联定位：以父窗口（或工作区）左上角为基准偏移，再由 computeCascadeBounds 收敛进工作区，
  // 保证在任何分辨率/多显示器/缩放下都不会把窗口推到屏幕外（用户会以为"没打开"）。
  if (cascade > 0) {
    const area = from ? screen.getDisplayMatching(from).workArea : screen.getPrimaryDisplay().workArea;
    const bounds = computeCascadeBounds({ from, workArea: area, cascade, size: DEFAULT_SIZE });
    windowOptions.x = bounds.x;
    windowOptions.y = bounds.y;
    windowOptions.width = bounds.width;
    windowOptions.height = bounds.height;
  }

  const win = new BrowserWindow(windowOptions);
  windows.add(win);

  // 显式确认窗口可移动（Windows/macOS 均支持），排除被外部代码误禁用的可能
  try {
    win.setMovable(true);
  } catch {
    /* 平台不支持时忽略 */
  }

  const dist = resolveWebDist();
  webRoot = dist;
  log('createWindow', `id=${win.id}`, `cascade=${cascade}`, `route=${route || '(none)'}`, `dist=${dist}`);
  // 通过自定义协议在根路径托管前端，本机版直接进入 /app 编辑器，不展示网页营销首页。
  // route 用于「移动到新窗口」时把文档参数带过去（doc=<docId>&fresh=1）。
  const targetUrl = `${APP_SCHEME}://neomd/app${route}`;
  win.loadURL(targetUrl).catch((e) => {
    log('loadURL failed', String(e && e.stack ? e.stack : e));
    dialog.showErrorBox('启动失败', String(e && e.message ? e.message : e));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('did-fail-load', win.id, code, desc);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', win.id, JSON.stringify(details));
    /*
     * 渲染进程崩溃后自动恢复（2.1.0）。
     *
     * 原实现只记一条日志，窗口就停在「Neo MD has stopped working」白屏上，
     * 用户只能强杀重启 —— 这正是反馈里的「打开后闪退 / 页面空白」。
     * 崩溃原因多为 GPU 进程或驱动问题，重载一次通常就能恢复；
     * 同时把 render-mode 置为降级，下一次启动直接走软件渲染。
     */
    const reason = String(details?.reason ?? '');
    // 正常关闭（clean-exit）与主动 kill 不重载，否则关窗时会反复弹窗
    if (reason === 'clean-exit' || reason === 'killed') return;
    try {
      writeRenderMode({ crashes: 0, disabled: true });
    } catch {
      /* ignore */
    }
    const attempt = (win.__neomdReloadAttempts = (win.__neomdReloadAttempts ?? 0) + 1);
    if (attempt <= 2) {
      log('render-process-gone → reload attempt', attempt);
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.webContents.reload();
        } catch {
          /* ignore */
        }
      }, 700 * attempt);
    } else {
      log('render-process-gone → give up after', attempt);
    }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    log('renderer:', win.id, level, message);
  });

  win.once('ready-to-show', () => win.show());

  /*
   * 启动健康探测（2.1.0）。
   *
   * 实测发现：GPU 不兼容时**主进程不会崩溃**，
   * 崩溃的是渲染进程，而且发生在 `did-finish-load` 之前，
   * 于是 `render-process-gone` 也可能来不及触发，
   * 窗口标题会停在「Neo MD has stopped working」并白屏 ——
   * 这正是用户反馈的「打开后闪退 / 页面空白」。
   *
   * 因此这里做一次「首屏是否真的画出来」的判定：
   * 12 秒内没等到 `did-finish-load`，就认定本次渲染路径不可用，
   * 写下降级标记并自动重启自己（带软件渲染），用户无感恢复。
   */
  const bootGuard = setTimeout(() => {
    if (win.__neomdFirstLoadDone) return;
    log('boot-guard: first load timeout → restart with software rendering');
    try {
      writeRenderMode({ crashes: 0, disabled: true });
    } catch {
      /* ignore */
    }
    try {
      app.relaunch();
    } catch {
      /* ignore */
    }
    app.exit(0);
  }, 12000);
  bootGuard.unref?.();

  win.webContents.once('did-finish-load', () => {
    win.__neomdFirstLoadDone = true;
    clearTimeout(bootGuard);
  });

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
      if (!isUsableWindow(win) || win.isMaximized() || win.isFullScreen()) return;
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
    // 非 http(s) 一律拒绝：应用跑在自定义协议下，window.open 开不出可用窗口，
    // 「移动至新窗口」必须走 window:newWindow IPC（见 preload 的 win.newWindow）。
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口关闭只把自己从登记表移除；其它窗口的所有能力（对话框/打印/主题）都不受影响。
  win.on('closed', () => {
    windows.remove(win);
    log('window closed', `id=${win.id}`, `remaining=${windows.count()}`);
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 自检模式：等待渲染完成后截图并退出
  const shotIdx = process.argv.indexOf('--shot');
  if (shotIdx > -1) {
    const shotPath = process.argv[shotIdx + 1];
    const routeIdx = process.argv.indexOf('--route');
    const shotRoute = routeIdx > -1 ? process.argv[routeIdx + 1] : '';
    if (shotRoute) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          win.webContents
            .executeJavaScript(`location.hash = ''; history.pushState({}, '', ${JSON.stringify(shotRoute)}); location.reload();`)
            .catch(() => undefined);
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
      }, shotRoute ? 9000 : 6000);
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

/**
 * 取发起 IPC 调用的那个窗口。
 * 这是多窗口改造的核心：1.1.7 的 `senderWindow(event) { return ... ?? mainWindow }`
 * 在解析失败时会借用"主窗口"，导致操作落到别的窗口上；现在解析失败就返回 null，
 * 调用方自行降级（不弹框 / 不发消息），绝不串窗口。
 */
function senderWindow(event) {
  return windows.resolveSender(event);
}

ipcMain.handle('window:isMaximized', (event) => {
  const win = senderWindow(event);
  if (!isUsableWindow(win)) return false;
  try {
    return win.isMaximized();
  } catch {
    // 窗口正在销毁时读状态会抛错，按"未最大化"处理即可（渲染层只用来画按钮样式）
    return false;
  }
});

/**
 * 新建一个独立的应用窗口（多窗口）。
 *
 * 用户原话：「修复标签栏右键在移动至新窗口功能不可用的问题，可同时打开程序多个窗口」。
 *
 * 关键点：
 * 1. `createWindow()` 每次都会新建一个 BrowserWindow，多窗口天然可行；
 *    单实例锁只限制"第二个应用进程"，不限制同进程内的窗口数量。
 * 2. 文档参数通过 URL 交给新窗口：`neomd://neomd/app?doc=<docId>&fresh=1`。
 *    `fresh=1` 表示渲染层**不要恢复旧标签**，只打开这一篇文档
 *    （1.1.7 的缺陷：新窗口恢复出全部旧标签，看起来像把旧窗口克隆了一份）。
 * 3. 位置按父窗口级联偏移并收敛进工作区，避免多窗口完全重叠。
 *
 * @param {string|{docId?:string,fresh?:boolean}} [docOrOptions] 旧渲染层传 docId 字符串，新渲染层可传对象
 */
ipcMain.handle('window:newWindow', async (event, docOrOptions, maybeOptions) => {
  // 兼容三种调用：newWindow(docId) / newWindow(docId, {fresh}) / newWindow({docId, fresh})
  const payload =
    maybeOptions && typeof maybeOptions === 'object'
      ? { docId: docOrOptions, ...maybeOptions }
      : docOrOptions && typeof docOrOptions === 'object'
        ? docOrOptions
        : { docId: docOrOptions };
  const { docId, fresh } = normalizeNewWindowArgs(payload);
  const parent = senderWindow(event);
  const cascade = nextCascadeOffset(windows.count());
  const win = createWindow({
    cascade,
    from: parent ? parent.getBounds() : null,
    docId: docId || null,
    fresh,
  });
  log('window:newWindow', `docId=${docId || ''}`, `fresh=${fresh}`, `parent=${parent ? parent.id : 'none'}`, `new=${win.id}`);
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
  if (!isUsableWindow(win)) return false;
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
  const win = senderWindow(event);
  if (!isUsableWindow(win)) return false;
  win.minimize();
  return true;
});

ipcMain.handle('window:close', (event) => {
  const win = senderWindow(event);
  if (!isUsableWindow(win)) return false;
  win.close();
  return true;
});

/* ---------------- IPC：对话框与系统 ---------------- */

/**
 * 对话框统一入口：父窗口 = 发起调用的窗口自身。
 * `windows.resolveDialogParent` 在没有 sender（主进程内部调用）时退化为聚焦窗口，
 * sender 已销毁时返回 null（无父窗口弹出），不会把对话框挂到别人的窗口上。
 */
function dialogParent(event) {
  return windows.resolveDialogParent(event);
}

ipcMain.handle('dialog:pickDirectory', async (event) => {
  const parent = dialogParent(event);
  const res = await dialog.showOpenDialog(parent ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

ipcMain.handle('dialog:pickFile', async (event, filters) => {
  const parent = dialogParent(event);
  const res = await dialog.showOpenDialog(parent ?? undefined, {
    properties: ['openFile'],
    filters: (filters ?? ['md']).map((ext) => ({ name: ext.toUpperCase(), extensions: [ext] })),
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

ipcMain.handle('dialog:saveFile', async (event, defaultName) => {
  const parent = dialogParent(event);
  const res = await dialog.showSaveDialog(parent ?? undefined, { defaultPath: defaultName });
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
ipcMain.handle('app:printToPdf', async (event, html, title) => {
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
    // 保存对话框挂在「点导出 PDF 的那个窗口」上，而不是某个全局主窗口
    const res = await dialog.showSaveDialog(dialogParent(event) ?? undefined, {
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

/**
 * 把外部文件交给某个窗口打开。
 * 目标窗口：优先当前聚焦窗口（用户正在看的那个），否则最早创建的存活窗口；
 * 一个窗口都没有时返回 false，由调用方负责先建窗口。
 */
function openFileInWindow(filePath, preferred) {
  const target = isUsableWindow(preferred) ? preferred : windows.focused();
  if (!target) return false;
  try {
    if (target.webContents.isLoading()) {
      target.webContents.once('did-finish-load', () => {
        if (isUsableWindow(target)) target.webContents.send('app:open-file', filePath);
      });
    } else {
      target.webContents.send('app:open-file', filePath);
    }
    return true;
  } catch (e) {
    log('openFileInWindow failed', String(e));
    return false;
  }
}

/** 系统主题变更：广播给所有未销毁窗口（1.1.7 只发给 mainWindow，其它窗口不跟随） */
function broadcastTheme() {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const sent = windows.broadcast('app:theme-changed', theme);
  log('theme broadcast', theme, `windows=${sent}`);
  return sent;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = extractFileArg(argv);
    if (file) {
      // 有文件关联参数：优先交给当前聚焦窗口打开；没有窗口才新建
      const focused = windows.focused();
      if (focused) {
        if (focused.isMinimized()) focused.restore();
        focused.focus();
        openFileInWindow(file, focused);
        return;
      }
      const win = createWindow({ cascade: nextCascadeOffset(windows.count()) });
      win.webContents.once('did-finish-load', () => {
        if (isUsableWindow(win)) win.webContents.send('app:open-file', file);
      });
      return;
    }
    // 用户再次双击桌面图标 / 启动程序（无关联文件参数）→ 新建一个独立窗口，支持同时打开多个程序窗口
    const ref = windows.focused();
    createWindow({
      cascade: nextCascadeOffset(windows.count()),
      from: ref ? ref.getBounds() : null,
    });
  });

  app.whenReady().then(() => {
    log(
      '--- start ---',
      'argv=' + JSON.stringify(process.argv),
      'resourcesPath=' + process.resourcesPath,
      'version=' + APP_VERSION,
      // 便携模式结论必须落日志：用户反馈"数据存哪了"时，看这一行就能定位
      'userData=' + app.getPath('userData'),
      'portable=' + (portableInfo.portable ? 'yes:' + portableInfo.reason : 'no:' + portableInfo.reason),
      'softwareRendering=' + (useSoftwareRendering ? 'yes' : 'no'),
    );

    /*
     * 已经走到 ready 且窗口即将创建 —— 说明本次启动成功，
     * 把崩溃计数清零。若本轮是降级后才起来的，则保留 disabled 标记，
     * 让后续启动继续用软件渲染（不再冒险尝试 GPU）。
     */
    writeRenderMode({ crashes: 0, disabled: useSoftwareRendering });

    registerProtocolHandler();
    pendingOpenFile = extractFileArg(process.argv);
    const first = createWindow();
    if (pendingOpenFile) {
      const file = pendingOpenFile;
      pendingOpenFile = null;
      first.webContents.once('did-finish-load', () => {
        if (isUsableWindow(first)) first.webContents.send('app:open-file', file);
      });
    }
    nativeTheme.on('updated', () => broadcastTheme());
    app.on('activate', () => {
      // macOS 点 Dock 图标：一个窗口都没有时才新建
      if (windows.count() === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * 仅测试用导出（tools/verify-119-multiwindow.mjs 会 require 本文件后驱动真实窗口）。
 * 生产运行不会读取这些导出，因此不影响打包行为。
 */
module.exports = {
  createWindow,
  windows,
  senderWindow,
  broadcastTheme,
  openFileInWindow,
  buildWindowRoute,
  normalizeNewWindowArgs,
};
