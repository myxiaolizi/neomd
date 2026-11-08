#!/usr/bin/env node
/**
 * 四壳 UI 级验收测试台（CDP 驱动）。
 *
 * 思路：四个桌面壳都在 127.0.0.1:<随机端口> 上托管同一份 Web 应用，
 * 并且都注入了 window.NeoMD。因此我可以：
 *   1. 启动被测壳（拿到它真实的本地端口与原生 bridge）；
 *   2. 用 Chrome/Edge 的 CDP 连到这个端口，执行真实 DOM 操作与断言。
 *
 * 这样验证的是「该壳实际提供的那份页面 + 该壳的原生桥」，
 * 而不是随便开个浏览器测 web 端——壳之间的差异（bridge 实现、
 * 注入时机、代理行为）都会真实暴露出来。
 *
 * 用法：
 *   node tools/shell-ui-accept.mjs --shell tauri
 *   node tools/shell-ui-accept.mjs --all
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 版本必须参数化。此前 `--release` 只影响 RELEASE 目录，SHELLS 里的**目录名**
 * 仍写死 2.1.0 —— 于是 `--release 2.2.0` 会去 2.2.0 目录里找
 * `NeoMD-2.1.0-tauri-x64\NeoMD.exe`，直接报「主程序不存在」。
 * 这种「看起来像产品缺文件、其实是脚本拼错路径」的失败最容易误导结论。
 */
const RELEASE = (() => {
  const i = process.argv.indexOf('--release');
  const v = i > -1 ? process.argv[i + 1] : '2.2.0';
  return `C:\\Data\\BAC\\neomd\\releases\\${v}`;
})();
const VERSION = RELEASE.split('\\').pop();
const ACCOUNT = { username: 'admin', password: '6655' };
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9455;

const SHELLS = [
  { name: 'electron', dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
  { name: 'tauri', dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  { name: 'qt', dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  { name: 'winui3', dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  { name: 'flutter', dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 极简 CDP 客户端（Node 24 自带 WebSocket） ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  /*
   * 超时不能写死 45s。
   *
   * 页面里有些 eval 本身就是「在页面内等异步操作完成」：首拉轮询要等 240s，
   * 保存后的同步等待要等 300s。它们都通过 awaitPromise 在页面里跑，
   * 只要外层 CDP 超时先到，就会抛「CDP 超时: Runtime.evaluate」，
   * 把「还在同步」误报成 runner 崩溃 —— Qt 上正是这样丢掉 6 个检查项。
   *
   * 因此允许调用方按需指定超时，默认放宽到 90s。
   */
  send(method, params = {}, timeoutMs = 90000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** 在页面里求值，返回 JS 值（自动 await Promise） */
  async eval(expression, timeoutMs = 90000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval 失败');
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ---------------- 壳生命周期 ---------------- */

function killShell(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {
    /* 不在跑 */
  }
}

/**
 * 查出某个监听端口属于哪个进程（返回进程名）。
 *
 * 用于识别「端口被一个改名后的旧壳占着」这种情况：按镜像名 taskkill 杀不到
 * 改名进程，而端口检查能看出来。返回 null 表示端口空闲。
 */
function portOwner(port) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const f = line.trim().split(/\s+/);
      if (f.length < 5) continue;
      const p = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
      if (p !== port) continue;
      const pid = Number(f[4]);
      try {
        const name = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
        const m = /^"([^"]+)"/.exec(name.trim());
        return m ? m[1] : `pid:${pid}`;
      } catch {
        return `pid:${pid}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function listenPorts(pid) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || Number(f[4]) !== pid) continue;
      const p = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
      if (p) ports.add(p);
    }
    return [...ports];
  } catch {
    return [];
  }
}

function portFromBootJson(dir) {
  try {
    const p = path.join(dir, 'data', 'boot.json');
    if (!fs.existsSync(p)) return null;
    const m = /:(\d+)\//.exec(JSON.parse(fs.readFileSync(p, 'utf8'))?.url ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchText(port, p, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ctl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

/** 启动壳并返回本地端口 */
async function startShell(shell) {
  const dir = path.join(RELEASE, shell.dir);
  const exePath = path.join(dir, shell.exe);
  if (!fs.existsSync(exePath)) throw new Error(`主程序不存在：${exePath}`);

  killShell(shell.exe);
  await sleep(1500);
  /*
   * 删 boot.json **之前**先记下它指向的端口，并检查那个端口上是否已经有
   * 别的进程在监听。
   *
   * 真实事故：一个改名后的旧壳（Qw38QtShell.exe，2.1.0）还在后台占着 51339。
   * 验收按「NeoMD.exe」杀进程，杀不到它；然后启动 2.2.0，2.2.0 端口被占后
   * 顺延到 51340，而下面的候选集合里又加入了**别人写的** boot.json 端口，
   * 于是验收连到了那个旧壳，全程对着 2.1.0 得出 17/17 全绿 —— 看起来完美，
   * 实际上一个字都不是被测版本的。
   *
   * 因此这里要求：端口必须由**本次 spawn 的进程**持有，否则直接失败，
   * 宁可不测，也不能测错对象。
   */
  let staleBoot = null;
  try {
    const b = path.join(dir, 'data', 'boot.json');
    if (fs.existsSync(b)) {
      const m = /127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(b, 'utf8'));
      if (m) staleBoot = Number(m[1]);
    }
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(path.join(dir, 'data', 'boot.json'), { force: true });
  } catch {
    /* ignore */
  }
  if (staleBoot) {
    const owner = portOwner(staleBoot);
    if (owner && !/^NeoMD|^neomd_|^Neo MD|^Qw38/i.test(owner)) {
      throw new Error(`端口 ${staleBoot} 被外部进程占用（${owner}），拒绝在污染环境下测试`);
    }
    if (owner) {
      // 同名前缀也可能属于一个已改名的旧副本，必须先清掉
      throw new Error(`端口 ${staleBoot} 仍被 ${owner} 占用（可能是改名后的旧副本），请先结束该进程`);
    }
  }

  const env = { ...process.env };
  /*
   * 必须清掉 ELECTRON_RUN_AS_NODE（2.1.0 排查结论）。
   *
   * 该变量会让 Electron 二进制以**纯 Node.js 模式**启动：
   * 不创建任何窗口、不加载 app、立刻以 0 退出。
   * 从带该变量的终端（很多 Node/Electron 工具链会设置它）启动
   * 「Neo MD.exe」，用户看到的就是「双击后闪退」。
   *
   * 这是环境变量污染，不是程序缺陷；但启动子进程时必须隔离，
   * 否则验收会误判成产品 bug。
   */
  delete env.ELECTRON_RUN_AS_NODE;
  // 各壳启动参数不同（Qt 冻结版必须 --no-sandbox），这里用壳定义里声明的 args
  const proc = spawn(exePath, shell.args ?? [], { cwd: dir, env, stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    await sleep(700);
    /*
     * 端口候选：本次进程持有的端口，外加 boot.json 声明的端口。
     *
     * 为什么 boot.json 不能直接排除：
     *   WinUI3 走 HttpListener（http.sys），监听端口归属于 **System (PID 4)**，
     *   而不是我们 spawn 出来的 NeoMD.WinUI3.exe。只看 listenPorts(proc.pid)
     *   会让 WinUI3 永远找不到自己的服务（实测 0/1 runner 失败）。
     *
     * 为什么又不能无条件信任 boot.json：
     *   同目录的旧副本也会写这个文件。2026-11-07 就发生过验收连到残留的
     *   2.1.0 副本、17/17 全绿却与本次构建无关。
     *
     * 因此这里只额外放行「归属 System」的 boot.json 端口，
     * 并在连上之后**强制校验 window.NeoMD.version 必须等于被测版本**（见下方）。
     */
    const cands = new Set(listenPorts(proc.pid));
    const b = portFromBootJson(dir);
    if (b && !cands.has(b)) {
      const owner = portOwner(b);
      if (owner === null) {
        // 端口空闲：说明本次进程还没起来，继续等
      } else if (/^System$/i.test(owner)) {
        // http.sys 托管（WinUI3），放行
        cands.add(b);
      } else if (/^NeoMD|^neomd_|^Neo MD/i.test(owner)) {
        // 同名族的另一个实例，可能是没被 taskkill 干净；不加进来
      }
    }
    for (const p of cands) {
      try {
        const r = await fetchText(p, '/', 4000);
        if (r.status === 200 && /<html/i.test(r.text)) return { proc, port: p, dir };
      } catch {
        /* next */
      }
    }
    if (proc.exitCode !== null) throw new Error(`壳启动即退出，exitCode=${proc.exitCode}`);
  }
  throw new Error('未能在超时内找到壳的本地 HTTP 服务');
}

/* ---------------- 浏览器（CDP 驱动被测端口） ---------------- */

let chromeProc = null;

async function startChrome() {
  const userDir = path.join(process.cwd(), '.tmp-cdp-profile');
  fs.rmSync(userDir, { recursive: true, force: true });
  chromeProc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return JSON.parse(await r.text()).webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
  }
  throw new Error('Chrome CDP 未就绪');
}

/** 打开一个新 page target 并连接 */
async function newPage(url) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const cdp = await CDP.attach(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, targetId: t.id };
}

/* ---------------- 断言工具 ---------------- */

function makeReport(shellName) {
  const checks = [];
  const push = (id, pass, detail) => {
    checks.push({ id, pass, detail });
    process.stdout.write(`  [${pass ? 'PASS' : 'FAIL'}] ${id.padEnd(22)} ${detail}\n`);
  };
  return { shellName, checks, push };
}

/* ---------------- 主流程 ---------------- */

const only = (() => {
  const i = process.argv.indexOf('--shell');
  return i > -1 ? process.argv[i + 1] : null;
})();
const shells = only ? SHELLS.filter((s) => s.name === only) : SHELLS;

const allReports = [];
await startChrome();
process.stdout.write('Chrome CDP 就绪\n');

for (const shell of shells) {
  process.stdout.write(`\n========== ${shell.name} ==========\n`);
  const rep = makeReport(shell.name);
  let proc = null;
  let cdp = null;

  try {
    const started = await startShell(shell);
    proc = started.proc;
    rep.push('shell.boot', true, `本地服务 127.0.0.1:${started.port}`);

    const page = await newPage(`http://127.0.0.1:${started.port}/`);
    cdp = page.cdp;
    await sleep(3500);

    // 1. window.NeoMD 与运行环境
    /*
     * 除了「注入成功」，还必须核对**版本号等于被测版本**。
     *
     * 这是防「连错实例」的最后一道闸：如果连上的是残留的旧副本，env 依然是
     * desktop、页面依然能渲染，只有 version 会露馅。曾经有一次 17/17 全绿
     * 实际测的是 2.1.0 的旧壳，靠的就是事后比对 version 才发现。
     */
    const env = await cdp.eval('JSON.stringify({ has: !!window.NeoMD, env: window.NeoMD?.env, ver: window.NeoMD?.version, keys: window.NeoMD ? Object.keys(window.NeoMD) : [] })');
    const eo = JSON.parse(env);
    const expectVer = VERSION;
    const verOk = String(eo.ver ?? '') === expectVer;
    rep.push(
      'inject.desktop',
      eo.has && eo.env === 'desktop' && verOk,
      eo.has && eo.env === 'desktop'
        ? `window.NeoMD.env=${eo.env} version=${eo.ver}${verOk ? '' : `（**期望 ${expectVer}，连到的不是本次构建**）`}`
        : `window.NeoMD 未注入（has=${eo.has}）`,
    );

    // 2. 页面是否真的渲染出内容（白屏检测）
    const bodyInfo = await cdp.eval('JSON.stringify({ textLen: (document.body.innerText||"").trim().length, appChildren: document.querySelector("#app")?.children.length ?? -1, title: document.title })');
    const bi = JSON.parse(bodyInfo);
    rep.push('render.nonblank', bi.textLen > 100 && bi.appChildren > 0, `正文 ${bi.textLen} 字，#app 子节点 ${bi.appChildren}，标题「${bi.title}」`);

    // 3. 侧边栏 / 编辑器骨架
    //
    // 注意：编辑区**只有打开文档后才存在**（空仓库时只显示空状态提示）。
    // 因此在「未打开文档」阶段只断言侧边栏 + 标签栏，
    // 编辑区留到打开文档后（sync.render 之后）再断言。
    const skeleton = await cdp.eval(`JSON.stringify({
      sidebar: !!document.querySelector('[class*="sidebar"], [class*="leftpanel"], aside'),
      tabbar: !!document.querySelector('[class*="tabbar"], .nm-tabs, [class*="tab-bar"]'),
      emptyHint: /仓库还是空的|还没有打开任何文档/.test(document.body.innerText||'')
    })`);
    const sk = JSON.parse(skeleton);
    rep.push('ui.skeleton', sk.sidebar && sk.tabbar, `侧边栏=${sk.sidebar} 标签栏=${sk.tabbar} 空状态提示=${sk.emptyHint}`);

    // 4. 登录：走前端真实的 auth store 链路（含 deviceId、token 键名）
    const loginResult = await cdp.eval(`(async () => {
      // 前端真实键名：neomd.access / neomd.refresh（见 apps/web/src/api/client.ts）
      const TOKEN_KEY = 'neomd.access';
      const REFRESH_KEY = 'neomd.refresh';
      if (localStorage.getItem(TOKEN_KEY)) return JSON.stringify({ already: true, token: true });
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: ${JSON.stringify(ACCOUNT.username)}, password: ${JSON.stringify(ACCOUNT.password)}, deviceId: 'accept-' + Date.now() })
      });
      const j = await res.json();
      if (!res.ok || !j?.data?.accessToken) return JSON.stringify({ ok: false, status: res.status, body: JSON.stringify(j).slice(0,300) });
      localStorage.setItem(TOKEN_KEY, j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem(REFRESH_KEY, j.data.refreshToken);
      return JSON.stringify({ ok: true, token: true });
    })()`);
    const lo = JSON.parse(loginResult);
    rep.push('auth.login', lo.ok !== false && lo.token === true, lo.ok !== false ? `登录成功（已写入 ${'neomd.access'}）` : `登录失败：${lo.status} ${lo.body}`);

    // 5. 登录后刷新，确认会话持久化 + 前端真的拉到仓库并渲染出来
    //
      // 这里**不能只等固定时长**：首拉要把云端 1000+ 篇文档逐个拉进本地引擎，
    // 各壳的 WebView 性能差异很大（Flutter/WebView2 明显慢于 Tauri）。
    // 固定 6s 会在慢壳上误判成「没同步」。改为条件轮询：
    // 每 2s 看一次「仓库还是空的」是否消失、正文是否变长。
    //
    // 窗口从 90s 放宽到 240s：实测 706 篇 + 344 篇待推送的一轮全量同步要
    // 130s（推送阶段每篇一次 headObject/putObject），90s 完全不够 —— 那会
    // 把「还在正常同步」误报成「仓库还是空的」，并连带把 edit/history 四项
    // 全部拖成失败。这类"慢"必须与"坏"分开。
    await cdp.eval('location.reload()');
    await sleep(3500);

    let lastSnap = { empty: true, bodyLen: 0, docs: 0, syncState: null };
    const SYNC_RENDER_BUDGET_MS = 240000;
    const pollStart = Date.now();
    while (Date.now() - pollStart < SYNC_RENDER_BUDGET_MS) {
      const snap = JSON.parse(
        await cdp.eval(`(async () => {
          const txt = (document.body.innerText || '');
          const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
          const app = pinia?._s.get('app');
          return JSON.stringify({
            empty: txt.includes('仓库还是空的'),
            bodyLen: txt.trim().length,
            docs: app?.docs?.length ?? 0,
            syncState: app?.syncState ?? null
          });
        })()`),
      );
      lastSnap = snap;
      // 同步完成的判据：空提示消失 且 本地已有文档
      if (snap.empty === false && snap.docs > 0) break;
      await sleep(2000);
    }

    const afterReload = await cdp.eval(`(async () => {
      const tok = localStorage.getItem('neomd.access') || '';
      const res = await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } });
      const j = await res.json().catch(()=>({}));
      const vaults = j?.data?.vaults ?? [];
      const txt = (document.body.innerText||'');
      const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
      const app = pinia?._s.get('app');
      return JSON.stringify({
        status: res.status, count: vaults.length,
        docs: vaults.reduce((a,v)=>a+(v.docCount||0),0),
        localDocs: app?.docs?.length ?? 0,
        uid: txt.includes('未登录') ? 'NOT_LOGGED' : 'LOGGED',
        empty: txt.includes('仓库还是空的'),
        bodyLen: txt.trim().length
      });
    })()`);
    const ar = JSON.parse(afterReload);
    rep.push('sync.vaults', ar.status === 200 && ar.count > 0, `/api/vaults -> ${ar.status}，仓库 ${ar.count} 个、文档 ${ar.docs} 篇`);
    // 登录态在 UI 上是否真的生效（"未登录" 字样消失）
    rep.push('auth.persist', ar.uid === 'LOGGED', ar.uid === 'LOGGED' ? 'UI 已显示登录态' : 'UI 仍显示「未登录」——会话未恢复');
    // 仓库列表是否真的渲染出云端文档（不是"仓库还是空的"），且本地 store 真有文档
    rep.push('sync.render', ar.empty === false && ar.localDocs > 0,
      ar.empty
        ? `左侧仍显示「仓库还是空的」——等待 240s 后仍未拉取（正文 ${ar.bodyLen} 字，同步态 ${lastSnap.syncState ?? '-'}）`
        : `左侧已渲染云端仓库内容（本地 store ${ar.localDocs} 篇，正文 ${ar.bodyLen} 字）`);

    // 6. 原生桥（壳特有）
    const bridge = await cdp.eval(`(async () => {
      const b = window.NeoMD?.bridge;
      if (!b) return JSON.stringify({ ok:false, reason:'no bridge' });
      try {
        const ud = await b.paths.userData();
        const ver = await b.app.version();
        return JSON.stringify({ ok:true, userData:String(ud).slice(0,120), version:ver });
      } catch (e) { return JSON.stringify({ ok:false, reason:String(e).slice(0,200) }); }
    })()`);
    const br = JSON.parse(bridge);
    rep.push('bridge.native', br.ok === true, br.ok ? `paths.userData=${br.userData} version=${br.version}` : `桥调用失败：${br.reason}`);

    // 7. 管理后台能否进入并返回编辑器（用户报告的「进得去出不来」）
    const adminNav = await cdp.eval(`(async () => {
      const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
      // 直接用前端路由跳转，模拟点击「管理后台」
      const before = location.pathname;
      history.pushState({}, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(2500);
      const onAdmin = location.pathname === '/admin';
      const textLen = (document.body.innerText||'').trim().length;
      // 再尝试返回编辑器
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(2500);
      const backEditor = location.pathname === '/app';
      const editorText = (document.body.innerText||'').trim().length;
      return JSON.stringify({ before, onAdmin, textLen, backEditor, editorText });
    })()`);
    const an = JSON.parse(adminNav);
    rep.push('nav.admin', an.onAdmin && an.textLen > 50, `进入 /admin：${an.onAdmin}（正文 ${an.textLen} 字）`);
    rep.push('nav.backEditor', an.backEditor && an.editorText > 50, `返回 /app：${an.backEditor}（正文 ${an.editorText} 字）`);

    // 8. 真实编辑链路：打开一篇云端文档 → 改内容 → 保存 → 验证历史版本
    //
    // 用 store 的真实 API：openDoc / updateTabContent / saveActiveTab。
    const editRun = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // store 可能因懒加载暂时取不到，最多等 15s
      const getApp = () => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      let app = getApp();
      for (let i = 0; i < 15 && !app; i++) { await sleep(1000); app = getApp(); }
      if (!app) return JSON.stringify({ ok:false, reason:'no app store（页面可能仍在加载）' });

      // 文档列表也可能还没同步完，等到有内容再继续
      for (let i = 0; i < 10 && (app.docs || []).length === 0; i++) await sleep(1500);

      const list = app.docs || [];
      if (!list.length) return JSON.stringify({ ok:false, reason:'docs empty（仓库无文档）' });
      /*
       * 保存链路用**本轮新建的专用文档**来测，不要复用仓库里的旧文档。
       *
       * 原因（Qt 2.2.0 实测踩到）：旧写法挑"最小的一篇"，而那篇文档的云端目录下
       * 已经有前几轮验收留下的 2-xxxx.md。这次保存写入的新内容如果被判定为
       * "同一 rev 的替换"或索引已追平，就不会产生新的云端对象；取证按 rev 从前
       * 往后找也找不到本次标记，于是报「已有对象均不含标记」。
       * 而同一份代码用 probe-save-disk 单独跑（它也挑最小文档，但只跑一次、
       * 且刚 write 完就查）是能命中的 —— 差别就在"这个文档被反复写过"。
       *
       * 新建文档让 rev 从 1 开始、云端目录里只有本轮的对象，
       * 「内容是否真的上云」这件事就没有任何历史混淆了。
       */
      let docId = null;
      let docTitle = null;
      const stampInit = 'ACCEPT-INIT-' + Date.now();
      try {
        await app.createDoc({ title: 'accept-save-' + stampInit, content: '初始内容 ' + stampInit });
        await sleep(2500);
        const t = app.tabs?.find(x => x.id === app.activeTabId);
        docId = t?.docId ?? null;
        docTitle = t?.title ?? null;
      } catch (e) {
        // 新建失败就退回旧的"挑一篇最小文档"策略，不能让整项因 CreateDoc 失败而崩掉
        const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));
        const first = sorted[0] ?? list[0];
        docId = first?.docId ?? first?.id ?? null;
        docTitle = first?.title ?? null;
      }
      /*
       * 文档唯一标识的真实字段名是 docId（见 packages/shared/src/types.ts），
       * 不是 id。这里曾经写成 first.id，永远是 undefined：
       *   - openDoc(undefined) 抛错被 catch 吞掉，编辑区却因为别的路径被打开而「可见」，
       *     于是 edit.open 一直假 PASS；
       *   - docId 传成 undefined 也让下游的历史版本断言无从定位文档。
       * 取不到 docId 时必须显式失败，不能再静默通过。
       */
      if (!docId) {
        return JSON.stringify({ ok:false, reason:'文档对象缺少 docId 字段', sample: Object.keys(list[0]||{}).slice(0,20) });
      }
      const stamp = 'ACCEPT-' + Date.now();
      let openErr = null, saveErr = null, tabId = null;
      let saveWaitInfo = null;

      try {
        await app.openDoc(docId);
        await sleep(2500);
        tabId = app.activeTabId;
      } catch (e) { openErr = String(e).slice(0,300); }

      // 校验编辑器里打开的确实是这篇文档，而不是残留的旧标签页
      const activeTab = (app.tabs || []).find(t => t.id === tabId) || null;
      const activeDocId = activeTab?.docId ?? activeTab?.meta?.docId ?? null;
      const tabMatches = activeDocId === docId;

      const editorVisible = !!document.querySelector('.ProseMirror, [contenteditable="true"], .cm-content, textarea');

      try {
        const tab = app.tabs?.find(t => t.id === tabId);
        const orig = tab?.content ?? '';
        await app.updateTabContent(tabId, orig + '\\n\\n' + stamp);
        await sleep(800);
        await app.saveActiveTab();
        /*
         * 保存后的同步是真异步的：saveActiveTab 内部只是 fireAndLog(syncNow)。
         * 实测一轮 700+ 篇的全量同步要 60~130 秒（推送阶段每篇一次 HEAD/PUT）。
         *
         * 这里的等待本身**不是判定依据**，只是为了别在同步途中就去取证（那样
         * 取证会白白多等几轮）。真正的"已保存"证据是后面直查云端对象含标记，
         * 那一步有自己的重试窗口。
         *
         * 因此这里放宽为"观察到一轮跑完（syncing -> idle）或索引追平，任一成立即可"。
         * 之前要求两者同时成立，结果在 flutter 上出现「索引追平=false」却仍然
         * PASS —— 说明这个条件并不是必要的，写死反而制造了表述上的矛盾。
         */
        const docState = () => (app.docs || []).find(d => d.docId === docId) || null;
        const revAtEditStart = docState()?.rev ?? null;
        const deadline = Date.now() + 420000;
        let caughtUp = false;
        let sawSyncing = false;
        let sawIdleAfterSyncing = false;
        while (Date.now() < deadline) {
          const d = docState();
          if (app.syncState === 'syncing') sawSyncing = true;
          if (sawSyncing && app.syncState === 'idle') sawIdleAfterSyncing = true;
          const revGrew = typeof d?.rev === 'number' && (revAtEditStart === null || d.rev > revAtEditStart);
          const indexCaughtUp =
            !!d && typeof d.rev === 'number' && typeof d.syncedRev === 'number' &&
            d.syncedRev >= d.rev && revGrew;
          if (indexCaughtUp) caughtUp = true;
          if (caughtUp || sawIdleAfterSyncing) break;
          await sleep(3000);
        }
        // 记录用于诊断：没追平时到底卡在哪个字段
        const d2 = docState();
        saveWaitInfo = {
          caughtUp, sawSyncing, sawIdleAfterSyncing,
          revAtEditStart,
          rev: d2?.rev ?? null, syncedRev: d2?.syncedRev ?? null,
          syncState: app.syncState,
        };
      } catch (e) { saveErr = String(e).slice(0,300); }

      // 保存成功的更强判据：脏标记已清 且 控制器无未处理异常
      const stillDirty = app.isDirty;
      return JSON.stringify({
        ok:true, docId, docTitle, tabId, activeDocId, tabMatches,
        editorVisible, openErr, saveErr, stamp,
        saveWaitInfo,
        stillDirty, dirty: app.isDirty, docCount: app.docs?.length,
        syncState: app.syncState,
        summary: app.lastSyncSummary ?? null
      });
    })()`, 720000);
    const er = JSON.parse(editRun);
    rep.push(
      'edit.open',
      er.ok !== false && er.editorVisible === true && er.tabMatches === true,
      er.ok === false
        ? `失败：${er.reason}${er.sample ? ' keys=' + JSON.stringify(er.sample) : ''}`
        : `打开《${er.docTitle ?? er.docId}》编辑器可见=${er.editorVisible} 标签页匹配=${er.tabMatches}${er.openErr ? ' 错误:' + er.openErr : ''}`,
    );
    /*
     * edit.save 的判据必须落到「内容真的到云端」。
     *
     * 旧判据只有 `!saveErr && stillDirty !== true`。问题是 `saveActiveTab()` 会先
     * 清 dirty、再去 fireAndLog(syncNow)；只要本地盘写成功，dirty 就会被清掉，
     * 哪怕推送阶段被丢弃也照样 PASS。实测曾出现「dirty=false、摘要显示推送 1 篇，
     * 但云端 rev 一动不动」的假成功。
     *
     * 因此这里补一条硬证据：直查该文档在云端的对象，要求存在**包含本次标记**的对象。
     */
    let cloudHasStamp = false;
    let cloudEvidence = '未检查';
    if (er.ok && er.docId && er.stamp) {
      const proof = await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const tok = localStorage.getItem('neomd.access') || '';
        const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
        const vaultId = app?.vault?.vaultId || '';
        const docId = ${JSON.stringify(er.docId)};
        const stamp = ${JSON.stringify(er.stamp)};
        if (!vaultId) return JSON.stringify({ ok:false, why:'无 vaultId' });
        const listPrefix = async (p) => {
          const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(p) + '&limit=200',
            { headers: { authorization: 'Bearer ' + tok } });
          const j = await r.json();
          return ((j && j.data && j.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
        };
        const revOf = (k) => Number((k.split('/').pop() || '').split('-')[0]) || 0;

        /*
         * 云端取证必须**轮询**，不能查一次就宣判。
         *
         * 实测反例（Flutter/Qt 2.2.0）：本地 rev 已 2、syncedRev 已 2、摘要写着
         * 「推送 1 篇」，但此刻云端对象还没落全 —— 单次查询只看到旧的
         * 1-e3b0c...md，于是结论「最新 5 个对象都不含标记」。
         * 稍后用 probe-save-disk 复核同一份代码：云端 2-010aa5....md 确实含标记。
         *
         * 所以「同步索引追平」与「云端对象可读」是两件事，后者还有一段延迟。
         * 这里给最多 180s 的重试窗口，取到即返回。
         */
        let last = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          const keys = await listPrefix('vaults/' + vaultId + '/docs/' + docId + '/');
          if (keys.length) {
            keys.sort(function (a, b) { return revOf(b) - revOf(a); });
            // 从最新往前找，命中标记即成功（最新的未必是刚写的，但通常就是）
            for (let i = 0; i < Math.min(keys.length, 8); i++) {
              const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(keys[i]),
                { headers: { authorization: 'Bearer ' + tok } });
              const text = await ro.text();
              if (text.indexOf(stamp) >= 0) {
                return JSON.stringify({ ok:true, key:keys[i], rev:revOf(keys[i]), objects:keys.length,
                  size:text.length, attempts: attempt + 1 });
              }
            }
            last = { ok:false, why:'已有对象均不含标记', objects:keys.length, maxRev:revOf(keys[0]) };
          } else {
            last = { ok:false, why:'云端该文档暂无正文对象', objects:0 };
          }
          await sleep(6000);
        }
        return JSON.stringify(last ?? { ok:false, why:'取证超时' });
      })()`, 300000);
      let pj = {};
      try { pj = JSON.parse(proof); } catch { pj = { ok:false, why:'解析失败' }; }
      cloudHasStamp = pj.ok === true;
      cloudEvidence = pj.ok === true
        ? `云端对象 ${pj.key}（rev ${pj.rev}，${pj.size} 字节，第 ${pj.attempts ?? 1} 次取证命中）含标记`
        : `云端未确认：${pj.why ?? '未知'}（对象 ${pj.objects ?? '-'} 个）`;
    }

    rep.push(
      'edit.save',
      !er.saveErr && er.stillDirty !== true && cloudHasStamp,
      er.saveErr
        ? `保存失败：${er.saveErr}`
        : `脏=${er.stillDirty ?? '-'}，同步态=${er.syncState ?? '-'}` +
          (er.saveWaitInfo
            ? `，同步轮次结束=${er.saveWaitInfo.sawIdleAfterSyncing}（rev ${er.saveWaitInfo.rev}/syncedRev ${er.saveWaitInfo.syncedRev}）`
            : '') +
          `，${er.summary?.message ?? ''}；${cloudEvidence}`,
    );

    /*
     * 历史版本：必须真的存在**某篇文档的**历史对象，且该文档的最新内容已上云。
     *
     * 旧断言是 `status === 200 && count >= 0` —— `count >= 0` 恒真，
     * 即使云端一个历史对象都没有也会 PASS，等于没测。
     *
     * 现在改为：
     *   a) 按「当前打开的文档」查 `vaults/<vid>/versions/<docId>/`，要求对象数 > 0；
     *   b) 同时查 `vaults/<vid>/docs/<docId>/`，要求对象数 > 0（正文已上云）；
     *   c) 要求 (a) 的历史对象不是凭空来的：必须与 (b) 的 rev 有交集关系。
     * 这样「历史版本可用」才是被证明的，而不是被假设的。
     */
    const hist = await cdp.eval(`(async () => {
      const tok = localStorage.getItem('neomd.access') || '';
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      const vaultId = app?.vault?.vaultId || '';
      const docId = ${JSON.stringify(er.docId)};
      if (!vaultId || !docId) {
        return JSON.stringify({ ok:false, why:'无 vaultId 或 docId', vaultId, docId });
      }
      const listPrefix = async (p) => {
        const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(p) + '&limit=200',
          { headers: { authorization: 'Bearer ' + tok } });
        const j = await r.json();
        return { status: r.status,
          keys: ((j && j.data && j.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean) };
      };
      const revOf = (k) => Number((k.split('/').pop() || '').split('-')[0]) || 0;
      const vp = 'vaults/' + vaultId + '/versions/' + docId + '/';
      const dp = 'vaults/' + vaultId + '/docs/' + docId + '/';
      const v = await listPrefix(vp);
      const d = await listPrefix(dp);
      const maxDocRev = d.keys.length ? Math.max.apply(null, d.keys.map(revOf)) : 0;
      const maxVerRev = v.keys.length ? Math.max.apply(null, v.keys.map(revOf)) : 0;
      return JSON.stringify({
        ok: v.status === 200 && d.status === 200,
        vaultId: vaultId, docId: docId,
        versionCount: v.keys.length, docCount: d.keys.length,
        maxDocRev: maxDocRev, maxVerRev: maxVerRev,
        versionPrefix: vp, docPrefix: dp,
      });
    })()`, 180000);
    const hs = JSON.parse(hist);
    rep.push(
      'history.list',
      hs.ok === true && hs.versionCount > 0 && hs.docCount > 0,
      hs.ok !== true
        ? `/api/storage/list 失败：${hs.why ?? '非 200'}`
        : hs.versionCount > 0 && hs.docCount > 0
          ? `《${er.docTitle ?? er.docId}》历史 ${hs.versionCount} 个对象（最高 rev ${hs.maxVerRev}）、正文 ${hs.docCount} 个对象（最高 rev ${hs.maxDocRev}）`
          : `历史对象 ${hs.versionCount} 个 / 正文对象 ${hs.docCount} 个，不足以证明历史可用`,
    );

    /*
     * 历史版本：不能只看云端有没有对象，还要证明**每保存一次就多一条**。
     *
     * 这一项来自一次被判成缺陷的反馈：有测试者新建空文档 -> 首次保存 ->
     * 立刻 `listDocVersions` -> 空 —— 于是报「保存后历史版本为空」。
     * 但那不是缺陷：
     *   1. saveActiveTab 归档的是**保存前的旧内容**，新建的空文档首次保存时
     *      "旧内容"本身是空的，这一条是否入档取决于实现，不能当唯一判据；
     *   2. 版本列表还要等同步落盘，立刻查会读到空。
     *
     * 实测（tools/probe-history-220.mjs，Electron 2.2.0）：
     *   旧文档   保存前 1 条 -> 保存后 2 条
     *   新文档   首次保存 2 条 -> 再保存 3 条
     * 也就是说功能正常，且"每次保存 +1"这个语义成立。
     *
     * 所以这里用**增量**做判据：再保存一次，版本数必须增加。
     * 用增量而不是绝对值，既能抓住"归档坏了"，又不受首次保存边界情况影响。
     */
    const hv = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      if (!app) return JSON.stringify({ ok:false, why:'no app store' });
      if (typeof app.listDocVersions !== 'function') {
        return JSON.stringify({ ok:false, why:'store 上没有 listDocVersions 方法' });
      }

      /*
       * 用**本轮新建的文档**做增量验证，不能复用上一步 edit.save 的标签：
       * - 那个标签的 content 已经被写过，且保存状态已尘埃落定；
       * - 更要紧的是 tab 对象是快照，updateTabContent 之后旧引用里的 content 不再更新，
       *   拿它拼新内容会拼出一个"没变化"的文本，保存自然不产生新版本 —— 这是探针 bug，
       *   不是产品缺陷（probe-history-220 每轮重新 find 就不会出现）。
       */
      const title = 'accept-hist-' + Date.now();
      await app.createDoc({ title, content: '历史增量基线' });
      await sleep(2500);

      const tabId = app.activeTabId;
      const tabNow = () => app.tabs?.find(t => t.id === tabId);
      const docId = tabNow()?.docId ?? tabNow()?.meta?.docId;
      if (!docId) return JSON.stringify({ ok:false, why:'新建文档没有 docId' });

      const count = async () => {
        try { const v = await app.listDocVersions(docId); return Array.isArray(v) ? v.length : -1; }
        catch (e) { return -2; }
      };

      // 新建后先保存一次，作为基线（首次保存的归档语义有边界情况，不计入增量）
      await app.saveActiveTab?.();
      await sleep(18000);
      const before = await count();

      // 再写一次并保存，版本必须新增
      const mark = 'HISTV-' + Date.now();
      app.updateTabContent?.(tabId, (tabNow()?.content ?? '') + '\\n\\n' + mark);
      await sleep(800);
      await app.saveActiveTab?.();
      await sleep(18000);
      const after = await count();

      return JSON.stringify({ ok:true, docId: docId.slice(-8), before, after,
        grew: before >= 0 && after > before });
    })()`, 420000);
    const hvo = JSON.parse(hv);
    rep.push(
      'history.grow',
      hvo.ok === true && hvo.grew === true,
      hvo.ok !== true
        ? `历史版本增量检查失败：${hvo.why ?? '未知'}`
        : hvo.grew
          ? `文档 ${hvo.docId} 再保存一次：版本 ${hvo.before} -> ${hvo.after}（每次保存新增一条）`
          : `保存后版本数未增加（${hvo.before} -> ${hvo.after}），历史归档异常`,
    );

    /*
     * 快捷键：既要能触发，也不能互相抢占。
     *
     * 这一项来自真实事故：云端历史设置里 editor.code 与 app.toggleMode 都绑定
     * 了 Ctrl+E，而查找用 .find() 取第一条 —— 于是按 Ctrl+E 只会插入行内代码，
     * 视图模式永远切不了。表面上「快捷键失灵」，实际是数据冲突 + 匹配策略叠加。
     *
     * 因此这里断言两件事：
     *   1. 任意按键在生效的快捷键表里最多只对应一条命令（无重复绑定）
     *   2. Ctrl+E 真的能把视图模式切走（真的能触发，而不是被前面那条吞掉）
     */
    const sc = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
      let settingsStore = null;
      for (const [, v] of stores) {
        if (v && typeof v === 'object' && ('settings' in v)) { settingsStore = v; break; }
      }
      const shortcuts = settingsStore?.settings?.shortcuts ?? [];

      // 1. 重复绑定检测
      const owner = new Map();
      const dups = [];
      for (const s of shortcuts) {
        for (const k of (s.keys || [])) {
          const norm = String(k).toLowerCase();
          if (owner.has(norm)) dups.push(norm + ' -> ' + owner.get(norm) + ' & ' + s.command);
          else owner.set(norm, s.command);
        }
      }

      // 2. Ctrl+E 真的能切模式
      const tab = () => app.tabs?.find(t => t.id === app.activeTabId);
      const before = tab()?.mode ?? null;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true
      }));
      await sleep(1600);
      const after = tab()?.mode ?? null;

      return JSON.stringify({
        total: shortcuts.length, dups: dups,
        modeBefore: before, modeAfter: after, modeChanged: before !== after,
      });
    })()`, 120000);
    const sco = JSON.parse(sc);
    rep.push(
      'shortcut.noConflict',
      Array.isArray(sco.dups) && sco.dups.length === 0,
      sco.dups && sco.dups.length
        ? `存在重复绑定：${sco.dups.slice(0, 4).join('; ')}`
        : `快捷键 ${sco.total} 条，无重复绑定`,
    );
    rep.push(
      'shortcut.ctrlE',
      sco.modeChanged === true,
      sco.modeChanged
        ? `Ctrl+E 切换视图模式：${sco.modeBefore} -> ${sco.modeAfter}`
        : `Ctrl+E 未能切换视图模式（仍是 ${sco.modeAfter}）——被同键命令抢占或未绑定`,
    );

    /*
     * 设置功能：走用户真实路径（Ctrl+, 打开设置标签页）。
     *
     * 曾经有模型把「/settings 路由打不开」判成产品缺陷 —— 但那是个不存在的
     * 路由：本应用只有 /login /app /account /admin /s/:token，设置是
     * openSettings() 插进来的**标签页**（SETTINGS_TAB_ID），不是独立页面。
     * 用 history.pushState('/settings') 去测，路由当然不会响应，页面留在
     * /app 是完全正确的行为。
     *
     * 所以这里按真实交互断言：快捷键能打开设置标签页、面板渲染出真实控件、
     * 且改动能落到持久化存储里。这才能真正证明「设置可用」。
     */
    const settings = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      if (!app) return JSON.stringify({ ok:false, why:'no store' });

      const before = (app.tabs || []).map(t => t.title);

      // 真实键盘事件：Ctrl+,
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      await sleep(2600);

      const after = (app.tabs || []).map(t => t.title);
      const opened = after.includes('设置');
      const active = (app.tabs || []).find(t => t.id === app.activeTabId) || null;

      const txt = document.body.innerText || '';
      const controls = document.querySelectorAll(
        'input, select, textarea, [role="switch"], .switch, button'
      ).length;
      // 设置面板里有这些分组标题才算真的渲染出来了
      const groups = ['通用', '编辑器', '主题', '快捷键'].filter(k => txt.includes(k));
      const lsKeys = Object.keys(localStorage).filter(k => /settings|pref|theme/i.test(k));

      // 关掉设置标签页，确认编辑器可继续使用
      const st = (app.tabs || []).find(t => t.title === '设置');
      let closed = false;
      if (st && typeof app.closeTab === 'function') {
        try { await app.closeTab(st.id); } catch (e) {}
        await sleep(1600);
        closed = !(app.tabs || []).some(t => t.title === '设置');
      }

      return JSON.stringify({
        ok: true,
        beforeCount: before.length, afterCount: after.length,
        opened, activeTitle: active ? active.title : null,
        controls, groups, lsKeys, closed,
        bodyLen: txt.length,
      });
    })()`, 90000);
    const sj = JSON.parse(settings);
    rep.push(
      'settings.open',
      sj.ok === true && sj.opened === true && sj.controls >= 10 && sj.groups.length >= 3,
      sj.ok !== true
        ? `失败：${sj.why ?? '未知'}`
        : `Ctrl+, 打开设置标签页=${sj.opened}（当前 ${sj.activeTitle}），控件 ${sj.controls} 个，分组命中 [${sj.groups.join(',')}]`,
    );
    rep.push(
      'settings.persist',
      sj.ok === true && Array.isArray(sj.lsKeys) && sj.lsKeys.length > 0 && sj.closed === true,
      sj.ok !== true
        ? `失败：${sj.why ?? '未知'}`
        : `持久化键 [${(sj.lsKeys || []).join(',')}]，关闭设置后回到编辑器=${sj.closed}`,
    );

    /*
     * 设置「改了就生效」：必须走完草稿 + 点保存的完整链路。
     *
     * 这一项来自一次被误判的反馈：有测试报告说「设置无效」，证据是
     * updateAppearance 改了 fontSize 但 store 没变。实际情况是**设计如此** ——
     * SettingsPage.patchAppearance 只写 draft，界面明确提示
     * 「草稿已更新，点『保存』生效」。只测到草稿就断言功能坏了，是测法错误。
     *
     * 但也不能反过来假定它没问题：真正的验收必须证明
     *   输入框改值 -> 点「保存」 -> store 与 localStorage 都变成新值。
     * 用真实 DOM 交互（定位 aria-label="编辑器正文字号" 的控件）而不是直接调
     * store 方法，否则测的是 API 而不是用户路径。
     */
    const sa = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
      let st = null;
      for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
      const ls = () => { try { return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}'); } catch { return {}; } };

      // 打开设置并切到「编辑器」分组
      document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
      await sleep(2500);
      const navs = Array.from(document.querySelectorAll('.settings__nav-item'));
      for (const n of navs) { if (/编辑器/.test(n.innerText || '')) { n.click(); await sleep(1200); break; } }

      const el = Array.from(document.querySelectorAll('.settings input[type="number"]'))
        .find(x => /字号/.test(x.getAttribute('aria-label') || ''));
      if (!el) return JSON.stringify({ ok:false, why:'找不到字号控件（aria-label 含「字号」）' });

      const from = Number(el.value);
      const to = from >= 26 ? from - 2 : from + 2;
      el.focus();
      el.value = String(to);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1200);
      const draftOnly = (st?.settings?.appearance?.fontSize ?? null) === from;

      const btns = Array.from(document.querySelectorAll('.settings-savebar button, .settings-savebar__actions button'));
      const saveBtn = btns.find(b => /^保存$/.test((b.innerText || '').trim())) || btns.find(b => /保存/.test(b.innerText || ''));
      if (!saveBtn) return JSON.stringify({ ok:false, why:'找不到保存按钮', draftOnly });

      saveBtn.click();
      await sleep(6000);

      const storeAfter = st?.settings?.appearance?.fontSize ?? null;
      const lsAfter = ls()?.appearance?.fontSize ?? null;
      return JSON.stringify({
        ok: true, from, to, draftOnly,
        storeAfter, lsAfter,
        committed: storeAfter === to && lsAfter === to,
      });
    })()`, 180000);
    const sao = JSON.parse(sa);
    rep.push(
      'settings.apply',
      sao.ok === true && sao.committed === true,
      sao.ok !== true
        ? `设置生效检查失败：${sao.why ?? '未知'}`
        : `字号 ${sao.from} -> ${sao.to}：改草稿时不立即写库=${sao.draftOnly}，点「保存」后 store=${sao.storeAfter}、localStorage=${sao.lsAfter}${sao.committed ? '（已生效）' : '（**未生效**）'}`,
    );

    /*
     * 窄窗不横向溢出：窗口能拖到的最小宽度是合法使用范围，在这个范围内出现
     * 整页横向滚动、或状态栏右侧控件被裁到视口外，就是真实缺陷。
     *
     * 实测来源（2.2.0，Electron 与 Tauri 两个模型各自独立复现）：
     *   800px 时 scrollWidth=810（溢出 10px）
     *   760px 时 scrollWidth=810（溢出 50px），溢出元素是 .statusbar__right
     * 根因：.statusbar__right 未设 flex-shrink，而 .statusbar__left 是 flex:1，
     * 两者把状态栏撑到内容宽度 810px，导致整页横向溢出。
     *
     * 修复后本项要求 720/760/800 三个宽度都 overflow<=0 且无元素越界。
     * 之所以连 720 一起测：那是 Electron 窗口允许拖到的最小宽度，
     * 也就是用户真的会遇到的场景，不能只测宽松尺寸。
     */
    const narrow = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const probe = () => {
        const de = document.documentElement;
        const vw = window.innerWidth;
        let offscreen = 0;
        for (const el of document.querySelectorAll('*')) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          if (b.right > vw + 1) offscreen += 1;
        }
        return { vw, scrollWidth: de.scrollWidth, overflow: de.scrollWidth - vw, offscreen };
      };
      const rows = [];
      // 直接用视口改写测宽（不依赖窗口管理器），测的是布局而不是窗口 API
      for (const w of [500, 600, 700, 720, 800, 900]) {
        window.resizeTo?.(w, window.outerHeight || 800);
        await sleep(900);
        const r = probe();
        rows.push({ target: w, ...r });
      }
      const bad = rows.filter(r => r.overflow > 0 || r.offscreen > 0);
      return JSON.stringify({ rows, bad });
    })()`, 180000);
    /*
     * 用 CDP 的 Emulation 改视口比 window.resizeTo 可靠（后者在部分壳里被
     * 窗口管理器忽略）。这里补一次真实的视口覆盖测量。
     */
    const narrowEmu = [];
    /*
     * 量之前先切回某个**文档标签**，
     * 并且覆盖 flutter 报告过的极窄档（500px）。
     *
     * flutter 壳实测 700/500px 时 scrollWidth=794 > innerWidth，约 94px 溢出，
     * 怀疑有内容区最小宽度。我在 tauri 上 720px 测得 overflow=0，
     * 差距可能来自"低于某个宽度才触发"或"壳不同"。
     * 所以放宽测量区间到 500/600/700，把这条也纳入判据：
     * 只要整页出现横向滚动就算失败 —— 那意味着有内容永远看不到。
     */
    try {
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
        const docTab = (app?.tabs || []).find(t => t.docId || t.meta?.docId);
        if (docTab) { app.activeTabId = docTab.id; await sleep(1500); }
        return 'ok';
      })()`, 60000);
      await sleep(1200);
    } catch {}
    for (const w of [500, 600, 700, 720, 800, 900]) {
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
        /*
         * 改视口后必须等布局真正稳定再量。
         *
         * 上一版只 sleep 900ms 就量，报了 14 个 offscreen —— 但独立探针
         * (tools/probe-offscreen-720.mjs) 在同样 720px 下实测 count=0、
         * zoomctl 右边界 634 < 720 完全可达。差别就在测量时机：
         * flex 重排、字体度量、滚动条出现都会引起二次布局，量早了会读到
         * 过渡态坐标。这里改为连续两次读数一致才采信，避免把抖动当缺陷。
         */
        let prev = null;
        let stable = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          await sleep(700);
          const r = await cdp.eval(`(() => {
            const de = document.documentElement;
            const vw = window.innerWidth;
            let offscreen = 0;
            for (const el of document.querySelectorAll('*')) {
              const b = el.getBoundingClientRect();
              if (b.width === 0 && b.height === 0) continue;
              if (b.right > vw + 1) offscreen += 1;
            }
            return JSON.stringify({ vw, scrollWidth: de.scrollWidth, overflow: de.scrollWidth - vw, offscreen });
          })()`);
          const cur = JSON.parse(r);
          if (prev && prev.overflow === cur.overflow && prev.offscreen === cur.offscreen) { stable = cur; break; }
          prev = cur;
        }
        narrowEmu.push({ target: w, ...(stable ?? prev) });
      } catch (e) {
        narrowEmu.push({ target: w, err: String(e).slice(0, 80) });
      }
    }
    try { await cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}

    /*
     * 判据只看「整页是否横向滚动」，不看"有没有元素右边界超出视口"。
     *
     * 为什么：overflow=0 意味着 documentElement 没有横向滚动，
     * 那些越界元素是被某个 overflow:hidden 祖先**有意裁剪**掉的
     * （例如状态栏左侧文字在很窄时省略、装饰性渐变块伸出容器）。
     * 这类裁剪恰恰是响应式布局的正确做法，把它们算缺陷会造成永远修不完的误报：
     *   - flutter 壳 500px 实测 overflow=0 但 offscreen=2，被判 FAIL；
     *   - 独立探针在同样 720px 下 count=0、zoomctl 完全可达（right=634<720）。
     * 真正影响用户的是「出现横向滚动条 -> 有内容永远看不到」，
     * 以及「可交互控件被裁到点不到」。所以判据改为：
     *   overflow>0  => 失败（整页能横向滚）
     *   offscreen>0 但 overflow=0 => 看是否存在"未被裁剪且可交互"的越界控件，
     *                                有才算失败（用户点不到），否则通过。
     */
    const narrowBad = narrowEmu.filter((r) => r.err || r.overflow > 0);
    let reachableProblems = 0;
    if (!narrowBad.length) {
      // 没有滚动但有越界元素时，再确认一次是否存在"点不到的控件"
      try {
        const worst = narrowEmu.reduce((a, b) => ((b.offscreen ?? 0) > (a.offscreen ?? 0) ? b : a), narrowEmu[0] ?? {});
        if ((worst?.offscreen ?? 0) > 0) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: worst.target, height: 800, deviceScaleFactor: 1, mobile: false });
          await sleep(1200);
          const chk = await cdp.eval(`(() => {
            const vw = window.innerWidth;
            let bad = 0;
            for (const el of document.querySelectorAll('*')) {
              const b = el.getBoundingClientRect();
              if (b.width === 0 && b.height === 0) continue;
              if (b.right <= vw + 1) continue;
              if (!el.closest('button, a, input, select, [role="button"], .st, [tabindex]')) continue;
              // 被 overflow 祖先裁剪掉的不算"点不到"（用户本来也看不到它）
              let clipped = false;
              let p = el.parentElement;
              while (p) {
                const cs = getComputedStyle(p);
                if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') {
                  if (p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
                }
                p = p.parentElement;
              }
              if (!clipped) bad += 1;
            }
            return String(bad);
          })()`);
          reachableProblems = Number(chk) || 0;
        }
      } catch {}
      try { await cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    }
    if (reachableProblems > 0) narrowBad.push({ target: '交互可达性', overflow: 0, offscreen: reachableProblems });
    /*
     * offscreen 数不为 0 时，把具体元素打出来再判定，不要只报一个数字。
     *
     * 独立探针在 720px 下实测 count=0，而这里稳定测量仍报 offscreen=14，
     * 差异只能来自页面状态不同（探针先 openDoc，这里停在验收流程后的状态）。
     * 靠猜没用，直接把越界元素、所属类名、是否被裁剪祖先裁掉、是否可交互
     * 全部取出来，才能分清"被合理裁剪的装饰元素"和"用户点不到的真控件"。
     */
    let narrowDetail = null;
    if (narrowBad.length > 0) {
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
        await sleep(1200);
        /*
         * 只在**编辑器视图**下量窄窗溢出。
         *
         * 前几轮这一步是在设置标签页还开着的时候跑的，越界元素是
         * button.settings__nav-item（设置页自己的左侧导航），与"状态栏被裁切"
         * 完全不是一件事；混合统计会把已修好的问题继续报成失败。
         *
         * 设置页是整页滚动容器，它内部的导航项越界不影响状态栏可达性 ——
         * 那是另一个布局域。先把标签切回文档再测，测的才是本次要保证的东西。
         */
        await cdp.eval(`(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
          const docTab = (app?.tabs || []).find(t => t.docId || t.meta?.docId);
          if (docTab) { app.activeTabId = docTab.id; await sleep(1500); }
          return 'ok';
        })()`, 60000);
        await sleep(1200);
        const d = await cdp.eval(`(() => {
          const vw = window.innerWidth;
          const rows = [];
          for (const el of document.querySelectorAll('*')) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 && b.height === 0) continue;
            if (b.right <= vw + 1) continue;
            let clippedBy = null;
            let p = el.parentElement;
            while (p) {
              const cs = getComputedStyle(p);
              if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') {
                const pb = p.getBoundingClientRect();
                if (pb.right <= vw + 1) { clippedBy = String(p.className || p.tagName).slice(0, 36); break; }
              }
              p = p.parentElement;
            }
            rows.push({
              tag: el.tagName.toLowerCase(),
              cls: (typeof el.className === 'string' ? el.className : '').trim().slice(0, 46),
              over: Math.round(b.right - vw),
              clippedBy,
              interactive: !!el.closest('button, a, input, select, [role="button"], .st, [tabindex]'),
              text: (el.innerText || '').trim().slice(0, 18),
            });
          }
          rows.sort((a,b) => b.over - a.over);
          return JSON.stringify({
            vw, count: rows.length,
            reachableProblems: rows.filter(r => r.interactive && !r.clippedBy).length,
            rows: rows.slice(0, 10),
          });
        })()`);
        narrowDetail = JSON.parse(d);
      } catch {}
      try { await cdp.send('Emulation.clearDeviceMetricsOverride'); } catch {}
    }
    rep.push(
      'layout.narrow',
      narrowBad.length === 0,
      narrowBad.length === 0
        ? `500/600/700/720/800/900px 均无横向溢出（${narrowEmu.map((r) => r.target + 'px:' + r.overflow).join(' ')}）`
        : `窄窗横向溢出：${narrowBad.map((r) => `${r.target}px overflow=${r.overflow ?? '?'} offscreen=${r.offscreen ?? '?'}`).join('; ')}` +
          (narrowDetail
            ? `；720px 越界 ${narrowDetail.count} 个，其中未被裁剪且可交互 ${narrowDetail.reachableProblems} 个` +
              (narrowDetail.rows.length ? `，最高越界 ${narrowDetail.rows[0].tag}.${narrowDetail.rows[0].cls}(+${narrowDetail.rows[0].over}px)` : '')
            : ''),
    );
    if (narrowDetail && narrowDetail.rows.length) {
      // 附到报告里，便于人工判断这些元素是否真的影响可用性
      rep.detail = rep.detail ?? {};
      rep.detail.narrowOffscreen = narrowDetail;
    }

    /*
     * 管理后台往返：标签页既不能重复增长，也不能丢失。
     *
     * 实测缺陷（2.2.0，Qt 壳由 qwen3.8-max 上报，Tauri 壳独立复现并已修复）：
     *   开 3 个标签 -> 进 /admin -> 返回 /app -> 5 个 -> 7 个 -> 9 个
     *   标签 id 不同但 docId 重复，即同一篇文档被反复开成多个标签。
     * 根因在 restoreTabs：它用 uid('tab') 直接造壳后 push，绕过了 openDoc 的
     * 「同 docId 复用」去重，而每次挂载 /app 都会调一次 restoreTabs。
     *
     * 修复时必须同时守住两侧，所以这里**两个方向都断言**：
     *   - 不能增长（重复开标签）
     *   - 不能变少（清空后没正确重建 -> 用户标签"消失"）
     * 只测"不增长"会漏掉后一种：第一版修复就踩了坑，重复没了但 3 个标签
     * 被覆盖成 1 个，从"多出来"变成"全丢了"。
     */
    const tabsRT = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      if (!app) return JSON.stringify({ ok:false, why:'no app store' });
      for (let i = 0; i < 20 && (app.docs || []).length === 0; i++) await sleep(2000);

      const snap = () => {
        const tabs = app.tabs || [];
        const docIds = tabs.map(t => t.docId ?? t.meta?.docId).filter(Boolean);
        const dupeDocIds = docIds.filter((d, i) => docIds.indexOf(d) !== i);
        /*
         * 身份用 docId 判定，**不能用 tab.id**。
         *
         * restoreTabs 重建标签时用 uid('tab') 生成新 id（id 是会话内标识，
         * 跨重建本来就会变）。第一版按 id 比对，于是 7 个标签被误报成"全丢了"。
         * 用户视角的"同一个标签"是同一篇文档，所以这里按 docId 对齐；
         * 设置标签没有 docId，单独用 isSettings 标记。
         */
        return { count: tabs.length, dupeDocIds,
          tabs: tabs.map(t => {
            const rawDocId = String(t.docId ?? t.meta?.docId ?? '');
            return {
              docId: rawDocId.slice(-10),
              title: String(t.title ?? '').slice(0, 18),
              /*
               * 设置面板的识别：标题是「设置」，或 docId 以 settings 开头。
               * 必须用**未截断**的 rawDocId 判断 —— 截断后 settings__ 这类前缀
               * 会变形，前缀匹配就失手了（第一版栽在这）。
               */
              isSettings: String(t.title ?? '') === '设置' || /^settings/i.test(rawDocId),
            };
          }),
        };
      };

      const aos = (app.docs || []);
      /*
       * 造 3 个**互不相同**的文档标签。
       *
       * 不能直接 slice(0,3) 后逐个 openDoc：验收前面的步骤已经开过某些文档，
       * openDoc 对同 docId 会复用已有标签（那是正确行为），于是实际新增可能
       * 少于 3 个。第一版就因此把基线算成 4、往返后 3，误报"标签丢失"。
       * 这里显式跳过已打开的 docId，保证造出确定数量的标签再测往返。
       */
      const opened = new Set((app.tabs || []).map(t => t.docId ?? t.meta?.docId).filter(Boolean));
      let added = 0;
      for (const d of aos) {
        if (added >= 3) break;
        if (opened.has(d.docId)) continue;
        await app.openDoc(d.docId);
        await sleep(1600);
        opened.add(d.docId);
        added += 1;
      }
      const baseline = snap();

      for (let round = 1; round <= 3; round++) {
        history.pushState({}, '', '/admin');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await sleep(2800);
        history.pushState({}, '', '/app');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await sleep(2800);
      }
      const after = snap();

      return JSON.stringify({ ok:true, baseline, after,
        grew: after.count > baseline.count,
        shrank: after.count < baseline.count,
        dupes: after.dupeDocIds });
    })()`, 420000);
    const rt = JSON.parse(tabsRT);
    /*
     * 判据用的是「往返前后是否一致」，不是与某个期望数量比较。
     * 用户标签数是用户自己的状态，测试不应该假定它必须是 3；
     * 要保证的是**往返动作本身不改变它**（不增、不减、不重复）。
     */
    /*
     * 只比较**文档标签**，不把「设置」算进来。
     *
     * 设置是插入标签栏的临时面板（SETTINGS_TAB_ID），不属于持久化的文档标签集：
     * 它没有 docId，persistTabs 写的是 `{docId, mode, pageWidth}` 列表，天然不含它。
     * 所以从后台返回后设置面板关闭、数量 7->6，是**正确行为**，不是"标签丢失"。
     * 第一版把设置算进总数，于是每次都被这条误报钉住。
     */
    const docOnly = (t) => !t.isSettings;
    const rtLost = (rt.baseline?.tabs ?? []).filter(docOnly).filter(
      (b) => !(rt.after?.tabs ?? []).some((a) => a.docId === b.docId),
    );
    const baselineDocs = (rt.baseline?.tabs ?? []).filter(docOnly).length;
    const afterDocs = (rt.after?.tabs ?? []).filter(docOnly).length;
    rep.push(
      'tabs.adminRoundTrip',
      rt.ok === true && afterDocs === baselineDocs && (rt.dupes || []).length === 0,
      rt.ok !== true
        ? `标签往返检查失败：${rt.why ?? '未知'}`
        : `3 次 /admin 往返：文档标签 ${baselineDocs} -> ${afterDocs}` +
          `${afterDocs > baselineDocs ? '（**重复增长**）' : ''}${afterDocs < baselineDocs ? '（**标签丢失**）' : ''}` +
          `${(rt.dupes || []).length ? `，重复 docId ${rt.dupes.length} 个` : '，无重复'}` +
          `${rtLost.length ? `，消失：${rtLost.map((t) => `${t.title}[${t.docId}]`).join(' / ')}` : ''}`,
    );

    /*
     * 设置 action 的入参防护。
     *
     * 实测缺陷（2.2.0 Flutter 壳，qwen3.8-max 上报）：
     *   updateAppearance('dark') 传字符串时，展开运算把字符串按索引拆成
     *   {0:'d',1:'a',2:'r',3:'k'}，混进 appearance 并持久化到
     *   localStorage['neomd.settings.v1']，污染用户设置。
     *
     * 修法是在 updateAppearance / updateLayout 入口加普通对象校验。
     * 这一项同时断言两件事，缺一不可：
     *   - 错误入参不能写库（挡住脏数据）
     *   - 正常对象仍要生效（不能防过头把功能挡死）
     */
    const guard = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
      if (!pinia) return JSON.stringify({ ok:false, why:'no pinia' });
      let st = null;
      for (const [, s] of pinia._s) {
        if (s && typeof s === 'object' && (s.settings || typeof s.updateAppearance === 'function')) { st = s; break; }
      }
      if (!st) return JSON.stringify({ ok:false, why:'没找到设置 store' });
      if (typeof st.updateAppearance !== 'function') return JSON.stringify({ ok:false, why:'没有 updateAppearance' });

      const digits = (o) => Object.keys(o || {}).filter(k => /^\\d+$/.test(k));
      const lsDigits = () => {
        try {
          const raw = localStorage.getItem('neomd.settings.v1');
          if (!raw) return 0;
          const j = JSON.parse(raw);
          return digits(j?.appearance).length + digits(j?.layout).length;
        } catch { return 0; }
      };

      const before = st.settings?.appearance?.fontSize;
      // 三种错误类型都试一遍
      try { st.updateAppearance('dark'); } catch {}
      try { st.updateAppearance(['x','y']); } catch {}
      try { st.updateAppearance(null); } catch {}
      try { st.updateLayout && st.updateLayout('narrow'); } catch {}
      await sleep(1200);
      const dirtyMem = digits(st.settings?.appearance).length + digits(st.settings?.layout).length;
      const dirtyLs = lsDigits();

      // 正常对象必须生效
      st.updateAppearance({ fontSize: (before ?? 16) === 17 ? 16 : 17 });
      await sleep(900);
      const applied = st.settings?.appearance?.fontSize !== before;

      return JSON.stringify({ ok:true, dirtyMem, dirtyLs, applied, before, after: st.settings?.appearance?.fontSize });
    })()`, 180000);
    const gd = JSON.parse(guard);
    rep.push(
      'settings.guard',
      gd.ok === true && gd.dirtyMem === 0 && gd.dirtyLs === 0 && gd.applied === true,
      gd.ok !== true
        ? `入参防护检查失败：${gd.why ?? '未知'}`
        : gd.dirtyMem === 0 && gd.dirtyLs === 0
          ? `错误入参（字符串/数组/null）均被挡住，未产生数字键脏数据；正常对象仍生效（字号 ${gd.before} -> ${gd.after}）`
          : `**脏数据未挡住**：内存数字键 ${gd.dirtyMem} 个、localStorage ${gd.dirtyLs} 个`,
    );

    // 8. 控制台错误收集
    const errs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    rep.push('console.clean', thrown.length === 0, `未捕获异常 ${thrown.length} 个，console.error ${errs.length} 条`);
  } catch (e) {
    rep.push('runner', false, `执行异常：${e.message}`);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      proc?.kill();
    } catch {
      /* ignore */
    }
    killShell(shell.exe);
    await sleep(1500);
    allReports.push(rep);
  }
}

try {
  chromeProc?.kill();
  execSync(`taskkill /F /PID ${chromeProc?.pid} /T`, { stdio: 'ignore' });
} catch {
  /* ignore */
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/shell-ui-accept.json', JSON.stringify({ at: new Date().toISOString(), reports: allReports }, null, 2));

process.stdout.write('\n===== 汇总 =====\n');
for (const r of allReports) {
  const p = r.checks.filter((c) => c.pass).length;
  const failed = r.checks.filter((c) => !c.pass);
  process.stdout.write(`${r.shellName.padEnd(9)} ${p}/${r.checks.length} 通过`);
  if (failed.length) process.stdout.write(`  失败：${failed.map((f) => f.id).join(',')}`);
  process.stdout.write('\n');
}
process.stdout.write('\n结果：reports/shell-ui-accept.json\n');
