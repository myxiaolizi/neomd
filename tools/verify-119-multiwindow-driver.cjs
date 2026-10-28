/**
 * 1.1.9 多窗口真实 GUI 冒烟驱动（由 tools/verify-119-multiwindow.mjs 用 Electron 启动）。
 *
 * 为什么需要这个文件：
 * 主进程 main.cjs 一旦 `require('electron')` 就只能跑在 Electron 运行时里，
 * 纯 Node 断言（见 verify 脚本的 unit 部分）覆盖不到「真实 IPC 的 event.sender 是谁」
 * 「关掉一个窗口后另一个窗口的对话框父窗口是谁」这类多窗口串味问题。
 * 所以这里作为 Electron 的入口脚本，require 真实 main.cjs，再用真实窗口 + 真实 preload 驱动。
 *
 * 运行方式（不要直接用 node 跑）：
 *   electron.exe tools/verify-119-multiwindow-driver.cjs --user-data-dir=<临时目录>
 *
 * 输出：最后打印一行 `##VERIFY_RESULT##<json>`，由 verify 脚本解析。
 */
const path = require('node:path');
const fs = require('node:fs');

const DESKTOP_DIR = path.resolve(__dirname, '..', 'apps', 'desktop');
const results = [];
const notes = [];

/**
 * 可选的文件日志：设置 NEOMD_VERIFY_LOG=<路径> 时，所有断言/节点都会同步写入该文件。
 * 为什么需要：冒烟过程中若主进程被卡住，stdout 管道里的内容可能来不及刷出，
 * 文件日志（appendFileSync）能保留"最后执行到哪一步"，是排查卡点的关键证据。
 */
const LOG_FILE = process.env.NEOMD_VERIFY_LOG || '';
function writeLog(line) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* 日志失败不影响验证 */
  }
}

function record(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
  const line = `[verify] ${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`;
  console.log(line);
  writeLog(line);
}
function note(msg) {
  notes.push(String(msg));
  console.log('[verify] note:', msg);
  writeLog('[verify] note: ' + msg);
}

const electron = require('electron');
const { app, BrowserWindow, dialog, screen } = electron;

/**
 * 在 require main.cjs **之前**打桩对话框。
 * main.cjs 用的是 `const { dialog } = require('electron')` 拿到同一个对象引用，
 * 调用时按属性查方法，因此这里的替换对它同样生效。
 * 只记录「父窗口是谁」，不真的弹窗（冒烟环境不应卡在模态框上）。
 */
const dialogCalls = [];
dialog.showOpenDialog = async (parent, options) => {
  dialogCalls.push({
    api: 'showOpenDialog',
    parentId: parent && Number.isInteger(parent.id) ? parent.id : null,
    parentUsable: Boolean(parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed()),
    properties: options && options.properties ? options.properties.slice() : [],
  });
  return { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async (parent, options) => {
  dialogCalls.push({
    api: 'showSaveDialog',
    parentId: parent && Number.isInteger(parent.id) ? parent.id : null,
    parentUsable: Boolean(parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed()),
    defaultPath: options && options.defaultPath ? String(options.defaultPath) : null,
  });
  return { canceled: true, filePath: '' };
};

/** 记录主框架导航 URL，用于断言新窗口 URL 确实带 doc/fresh 参数 */
const navigations = [];
app.on('web-contents-created', (_event, wc) => {
  wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) navigations.push(url);
  });
});

// 加载真实主进程（它会注册全部 IPC、创建首个窗口）
const mod = require(path.join(DESKTOP_DIR, 'main.cjs'));

// 心跳：用于判断主进程事件循环是否还活着。
// 若某一步日志之后心跳也停了，说明主进程被同步阻塞（而不是 await 挂住），
// 这两类问题的排查方向完全不同，必须区分开。
const HEARTBEAT = process.argv.includes('--no-heartbeat')
  ? null
  : setInterval(() => console.log('[verify] heartbeat', process.uptime().toFixed(1) + 's'), 4000);
HEARTBEAT?.unref?.();

/* ---------------- 工具函数 ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function usableWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

/** 等到窗口自身 URL 加载完成（did-finish-load），超时抛错 */
async function waitLoaded(win, timeoutMs = 45000) {
  if (!win || win.isDestroyed()) throw new Error('窗口已销毁，无法等待加载');
  if (!win.webContents.isLoading() && win.webContents.getURL()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待窗口加载超时: ' + win.webContents.getURL()));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e, code, desc) => {
      cleanup();
      reject(new Error(`窗口加载失败 ${code} ${desc}`));
    };
    function cleanup() {
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onDone);
      win.webContents.removeListener('did-fail-load', onFail);
    }
    win.webContents.once('did-finish-load', onDone);
    win.webContents.once('did-fail-load', onFail);
  });
}

/** 在指定窗口里执行 JS（真实 webContents，真实 preload 环境） */
async function evalIn(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

/**
 * 带超时的 eval：渲染进程若被销毁/卡死，executeJavaScript 会永远不 resolve，
 * 没有超时的话整个冒烟只能干等到外层杀掉，拿不到任何诊断信息。
 */
async function evalInTimeout(win, code, timeoutMs = 20000) {
  const result = await Promise.race([
    evalIn(win, code).then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: String(e && e.message ? e.message : e) }),
    ),
    new Promise((res) => setTimeout(() => res({ ok: false, timeout: true }), timeoutMs)),
  ]);
  if (result.timeout) throw new Error('executeJavaScript 超时（' + timeoutMs + 'ms），渲染进程可能已卡死');
  if (!result.ok) throw new Error('executeJavaScript 失败：' + result.error);
  return result.value;
}

/**
 * 由渲染层真实发起一次 IPC。
 * 注意 API 路径是 `window.NeoMD.bridge.*`（preload 把 bridge 整体挂在 NeoMD 下），
 * 不是 `window.NeoMD.win.*`。
 */
async function callBridge(win, expr) {
  try {
    return await evalInTimeout(
      win,
      `(async () => { try { return await (${expr}); } catch (e) { return { __error: String(e && e.message ? e.message : e) }; } })()`,
    );
  } catch (e) {
    return { __driverError: String(e && e.message ? e.message : e) };
  }
}

function urlsOf(wc) {
  try {
    return wc.getURL();
  } catch {
    return '';
  }
}

function hasQueryParam(url, key, value) {
  try {
    const u = new URL(url);
    const got = u.searchParams.get(key);
    return value === undefined ? got !== null : got === value;
  } catch {
    return false;
  }
}

/** 等待某个条件成立（轮询），超时返回 false */
async function waitFor(fn, timeoutMs = 15000, interval = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* 继续等 */
    }
    await sleep(interval);
  }
  return false;
}

async function main() {
  // main.cjs 的 whenReady 回调先执行（它注册得更早），此时首个窗口已创建
  const initial = usableWindows();
  record('初始窗口已创建（单实例单进程内）', initial.length === 1, { count: initial.length });
  if (!initial.length) {
    record('无法取得初始窗口', false);
    return;
  }
  const win1 = initial[0];
  await waitLoaded(win1);
  const win1Url = urlsOf(win1.webContents);
  record('初始窗口加载 neomd:// 渲染层', /^neomd:\/\/neomd\/app/.test(win1Url), { url: win1Url });

  // 安全基线不回退
  const prefs = win1.webContents.getLastWebPreferences ? win1.webContents.getLastWebPreferences() : {};
  record(
    '安全性：contextIsolation 开启、nodeIntegration 关闭',
    prefs.contextIsolation === true && prefs.nodeIntegration !== true,
    { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration },
  );
  const preloadState = await evalIn(
    win1,
    `({
      hasBridge: typeof window.NeoMD === 'object' && window.NeoMD !== null,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
      apiKeys: window.NeoMD && window.NeoMD.bridge ? Object.keys(window.NeoMD.bridge).sort() : [],
    })`,
  );
  record(
    'preload 只暴露白名单 API（渲染层拿不到 require/process）',
    preloadState.hasBridge === true && preloadState.nodeRequire === 'undefined' && preloadState.nodeProcess === 'undefined',
    preloadState,
  );

  /* ---------- a) 能创建第二个窗口，两窗口独立 ---------- */
  const r1 = await callBridge(win1, 'window.NeoMD.bridge.win.newWindow("doc-alpha")');
  const newId = typeof r1 === 'number' ? r1 : null;
  const okCreated = newId !== null && (await waitFor(() => Boolean(BrowserWindow.fromId(newId)), 10000));
  record('a) 通过 IPC 创建第二个窗口（返回窗口 id）', okCreated, { requestedId: r1 });
  if (!okCreated) {
    record('a) 第二个窗口不存在，后续断言跳过', false);
    return;
  }
  const win2 = BrowserWindow.fromId(newId);
  await waitLoaded(win2);

  const allIds = usableWindows().map((w) => w.id);
  record('a) 两个窗口同时存在', allIds.length === 2 && allIds.includes(win1.id) && allIds.includes(win2.id), { ids: allIds });
  record(
    'a) 两窗口是不同的 BrowserWindow / webContents',
    win1.id !== win2.id && win1.webContents.id !== win2.webContents.id,
    { win1: win1.id, win2: win2.id, wc1: win1.webContents.id, wc2: win2.webContents.id },
  );

  // 渲染层状态隔离：在 win1 打标记，win2 里不应看到
  await evalIn(win1, 'window.__nmIsolationMarker = "only-in-win1"; true');
  const iso = await evalIn(win2, 'typeof window.__nmIsolationMarker');
  record('a) 两窗口 JS 上下文互相独立（标签互不克隆的基础）', iso === 'undefined', { win2MarkerType: iso });

  /* ---------- d) 新窗口 URL 带 doc 与 fresh=1 ---------- */
  const win2Url = urlsOf(win2.webContents);
  record(
    'd) 新窗口 URL 带 doc=doc-alpha 且 fresh=1',
    hasQueryParam(win2Url, 'doc', 'doc-alpha') && hasQueryParam(win2Url, 'fresh', '1'),
    { url: win2Url },
  );
  record(
    'd) 主框架导航记录里出现带参数的 neomd URL',
    navigations.some(
      (u) => /^neomd:\/\/neomd\/app\?/.test(u) && hasQueryParam(u, 'doc', 'doc-alpha') && hasQueryParam(u, 'fresh', '1'),
    ),
    { lastNavigations: navigations.slice(-4) },
  );

  // 没有 docId 的普通新窗口不应带 fresh（避免误伤"新建空窗口"语义）
  const r2 = await callBridge(win1, 'window.NeoMD.bridge.win.newWindow()');
  const plainWin = typeof r2 === 'number' ? BrowserWindow.fromId(r2) : null;
  if (plainWin) {
    await waitLoaded(plainWin);
    const plainUrl = urlsOf(plainWin.webContents);
    record(
      'd) 不带 docId 的新窗口 URL 不含 doc/fresh 参数',
      !hasQueryParam(plainUrl, 'doc') && !hasQueryParam(plainUrl, 'fresh'),
      { url: plainUrl },
    );
    plainWin.close();
    await waitFor(() => plainWin.isDestroyed(), 8000);
  } else {
    record('d) 不带 docId 的新窗口创建失败', false, { requestedId: r2 });
  }

  /* ---------- c) 主题变更广播到所有窗口 ---------- */
  const themeInit = await evalIn(
    win1,
    `(() => { window.__nmThemeEvents = []; if (window.NeoMD && window.NeoMD.bridge && window.NeoMD.bridge.app) { window.NeoMD.bridge.app.onThemeChanged((t) => window.__nmThemeEvents.push(t)); return 'subscribed'; } return 'no-bridge'; })()`,
  );
  const themeInit2 = await evalIn(
    win2,
    `(() => { window.__nmThemeEvents = []; if (window.NeoMD && window.NeoMD.bridge && window.NeoMD.bridge.app) { window.NeoMD.bridge.app.onThemeChanged((t) => window.__nmThemeEvents.push(t)); return 'subscribed'; } return 'no-bridge'; })()`,
  );
  record('c) 两个窗口都订阅上了主题事件', themeInit === 'subscribed' && themeInit2 === 'subscribed', { themeInit, themeInit2 });
  const broadcastCount = mod.broadcastTheme();
  await sleep(400);
  const ev1 = await evalIn(win1, 'window.__nmThemeEvents.slice()');
  const ev2 = await evalIn(win2, 'window.__nmThemeEvents.slice()');
  record(
    'c) 主题变更广播到所有存活窗口',
    broadcastCount === 2 && ev1.length === 1 && ev2.length === 1 && ev1[0] === ev2[0],
    { broadcastCount, ev1, ev2 },
  );

  /* ---------- b) 关掉一个窗口后，另一个窗口的对话框仍可用且父窗口取自身 ---------- */
  // b-1：关掉 win2，再从 win1 打开「选择文件夹」
  win2.close();
  const win2Closed = await waitFor(() => win2.isDestroyed(), 10000);
  record('b) 第二个窗口已关闭', win2Closed, { remaining: usableWindows().map((w) => w.id) });
  await sleep(300);

  let mark = dialogCalls.length;
  const pick1 = await callBridge(win1, 'window.NeoMD.bridge.dialog.pickDirectory()');
  const calls1 = dialogCalls.slice(mark);
  record('b) 关掉另一窗口后，主窗口「选择文件夹」仍能正常走完 IPC', !pick1 || !pick1.__error, { result: pick1 });
  record(
    'b) 主窗口对话框的父窗口就是它自己（不是已关闭的窗口、不是 null）',
    calls1.length === 1 && calls1[0].parentId === win1.id && calls1[0].parentUsable === true,
    { calls: calls1, expectedParent: win1.id },
  );

  // b-2：反过来 —— 新建 win3，关掉原始 win1，再从 win3 打开「选择文件夹」
  // 这正是 1.1.8 的致命路径：旧实现里关掉"主窗口"后 mainWindow=null，其余窗口的对话框会挂空。
  const r3 = await callBridge(win1, 'window.NeoMD.bridge.win.newWindow("doc-beta")');
  const win3 = typeof r3 === 'number' ? BrowserWindow.fromId(r3) : null;
  if (!win3) {
    record('b) 第三个窗口创建失败', false, { requestedId: r3 });
    return;
  }
  await waitLoaded(win3);
  win1.close();
  const win1Closed = await waitFor(() => win1.isDestroyed(), 10000);
  record('b) 原始窗口已关闭，第三窗口仍存活', win1Closed && !win3.isDestroyed(), {
    remaining: usableWindows().map((w) => w.id),
  });
  await sleep(300);
  mark = dialogCalls.length;
  const pick3 = await callBridge(win3, 'window.NeoMD.bridge.dialog.pickDirectory()');
  const calls3 = dialogCalls.slice(mark);
  record('b) 关掉「第一个窗口」后，剩余窗口的对话框仍正常工作', !pick3 || !pick3.__error, { result: pick3 });
  record(
    'b) 剩余窗口的对话框父窗口是它自己（旧实现此处为 null 或错窗口）',
    calls3.length === 1 && calls3[0].parentId === win3.id && calls3[0].parentUsable === true,
    { calls: calls3, expectedParent: win3.id },
  );

  /* ---------- 级联定位不越屏 ---------- */
  const many = [];
  for (let i = 0; i < 5; i += 1) {
    const rid = await callBridge(win3, 'window.NeoMD.bridge.win.newWindow("doc-cascade-' + i + '")');
    const w = typeof rid === 'number' ? BrowserWindow.fromId(rid) : null;
    if (w) many.push(w);
  }
  record('级联：连续创建 5 个窗口', many.length === 5, { created: many.length });
  // 必须等它们把首帧加载完再销毁：在 did-finish-load 之前 destroy 会把 Chromium 的
  // browser 进程卡死（实测：随后任何 executeJavaScript / 定时器都不再响应）。
  // 真实用户不会在窗口首帧还没出来时关掉它，这是自动化冒烟特有的竞态。
  await Promise.all(many.map((w) => waitLoaded(w, 60000)));
  const offscreen = [];
  for (const w of [win3, ...many]) {
    if (w.isDestroyed()) continue;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const inside = b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
    if (!inside) offscreen.push({ id: w.id, bounds: b, workArea: area });
  }
  record('级联：所有窗口 bounds 均落在所在显示器工作区内（不越屏）', offscreen.length === 0, { offscreen });

  // 顺序关掉剩余窗口，验证登记表同步回收。
  // 这里用 destroy() 而不是 close()：close() 会走渲染层的 beforeunload，
  // 若渲染层在 beforeunload 里同步调用主进程 IPC（例如自动保存），
  // 主进程正在等待 close 完成 → 双方互等，整个冒烟进程会死锁（实测卡死 200s 无输出）。
  // 本项验证的是"登记表能随窗口销毁回收"，用 destroy 同样成立且不会卡住。
  note('开始销毁 ' + many.length + ' 个级联窗口');
  for (const w of many) {
    if (w.isDestroyed()) continue;
    try {
      w.destroy();
    } catch (e) {
      note('destroy 失败：' + String(e && e.message));
    }
  }
  const closedAll = await waitFor(() => many.every((w) => w.isDestroyed()), 20000);
  note('级联窗口全部销毁=' + closedAll + '，剩余窗口=' + usableWindows().length);
  record('级联：关闭多余窗口后仅剩 1 个，其余窗口不受影响', closedAll && usableWindows().length === 1, {
    remaining: usableWindows().map((w) => w.id),
  });
  note('即将验证最后存活窗口的对话框（win3 id=' + win3.id + ' destroyed=' + win3.isDestroyed() + '）');
  writeLog('[verify] before-final-pick');
  const stillWorks = await callBridge(win3, 'window.NeoMD.bridge.dialog.pickDirectory()');
  writeLog('[verify] after-final-pick ' + JSON.stringify(stillWorks));
  note('最后一次 pickDirectory 返回：' + JSON.stringify(stillWorks));
  record('级联：批量关闭窗口后，最后存活窗口的对话框仍然可用', !stillWorks || !stillWorks.__error, { result: stillWorks });
}

/**
 * 看门狗：无论断言逻辑卡在哪一步，都必须把结果标记打出来并退出，
 * 否则外层 verify 脚本只能等到超时、拿不到任何断言明细（排查成本极高）。
 */
const WATCHDOG_MS = 120_000;
const watchdog = setTimeout(() => {
  record('冒烟看门狗：执行超时（>120s）', false, { timeoutMs: WATCHDOG_MS });
  console.log(
    '##VERIFY_RESULT##' +
      JSON.stringify({
        results,
        failed: results.filter((r) => !r.pass).length,
        notes,
        failure: 'watchdog-timeout',
      }),
  );
  setTimeout(() => app.exit(1), 150);
}, WATCHDOG_MS);
watchdog.unref?.();

app.whenReady().then(async () => {
  let failure = null;
  try {
    await main();
  } catch (e) {
    failure = e;
    record('驱动执行异常', false, { message: String(e && e.stack ? e.stack : e) });
  }
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.pass);
  console.log(
    '##VERIFY_RESULT##' +
      JSON.stringify({ results, failed: failed.length, notes, failure: failure ? String(failure.message) : null }),
  );
  // 稍等让 stdout flush，再干净退出
  setTimeout(() => app.exit(failed.length === 0 ? 0 : 1), 150);
});

// 冒烟期间不允许因为窗口全关就退出（由脚本自己决定退出时机）
app.on('window-all-closed', () => {
  /* noop */
});
