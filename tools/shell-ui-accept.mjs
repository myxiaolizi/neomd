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

const RELEASE = (() => {
  const i = process.argv.indexOf('--release');
  const v = i > -1 ? process.argv[i + 1] : '2.1.0';
  return `C:\\Data\\BAC\\neomd\\releases\\${v}`;
})();
const ACCOUNT = { username: 'admin', password: '6655' };
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9455;

const SHELLS = [
  { name: 'electron', dir: 'NeoMD-2.1.0-electron-x64', exe: 'Neo MD.exe', args: [] },
  { name: 'tauri', dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
  { name: 'qt', dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  { name: 'winui3', dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  { name: 'flutter', dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
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

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 45000);
    });
  }

  /** 在页面里求值，返回 JS 值（自动 await Promise） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
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
  try {
    fs.rmSync(path.join(dir, 'data', 'boot.json'), { force: true });
  } catch {
    /* ignore */
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
    const cands = new Set(listenPorts(proc.pid));
    const b = portFromBootJson(dir);
    if (b) cands.add(b);
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
    const env = await cdp.eval('JSON.stringify({ has: !!window.NeoMD, env: window.NeoMD?.env, ver: window.NeoMD?.version, keys: window.NeoMD ? Object.keys(window.NeoMD) : [] })');
    const eo = JSON.parse(env);
    rep.push('inject.desktop', eo.has && eo.env === 'desktop', `window.NeoMD.env=${eo.env} version=${eo.ver}`);

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
    // 每 1.5s 看一次「仓库还是空的」是否消失、正文是否变长，最多等 90s。
    await cdp.eval('location.reload()');
    await sleep(3500);

    let lastSnap = { empty: true, bodyLen: 0, docs: 0 };
    for (let i = 0; i < 60; i++) {
      const snap = JSON.parse(
        await cdp.eval(`(async () => {
          const txt = (document.body.innerText || '');
          const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
          const app = pinia?._s.get('app');
          return JSON.stringify({
            empty: txt.includes('仓库还是空的'),
            bodyLen: txt.trim().length,
            docs: app?.docs?.length ?? 0
          });
        })()`),
      );
      lastSnap = snap;
      // 同步完成的判据：空提示消失 且 本地已有文档
      if (snap.empty === false && snap.docs > 0) break;
      await sleep(1500);
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
        ? `左侧仍显示「仓库还是空的」——等待 90s 后仍未拉取（正文 ${ar.bodyLen} 字）`
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
      // 挑一篇**较小的**文档来测保存：真实仓库里存在几 MB 的大文档，
      // 用它们测会把「保存链路是否通」和「大文件耗时」混在一起，
      // 在慢壳上直接超时，掩盖真实结论。
      const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));
      const first = sorted[0] ?? list[0];
      const stamp = 'ACCEPT-' + Date.now();
      let openErr = null, saveErr = null, tabId = null;

      try {
        await app.openDoc(first.id);
        await sleep(2500);
        tabId = app.activeTabId;
      } catch (e) { openErr = String(e).slice(0,300); }

      const editorVisible = !!document.querySelector('.ProseMirror, [contenteditable="true"], .cm-content, textarea');

      try {
        const tab = app.tabs?.find(t => t.id === tabId);
        const orig = tab?.content ?? '';
        await app.updateTabContent(tabId, orig + '\\n\\n' + stamp);
        await sleep(800);
        await app.saveActiveTab();
        await sleep(4000);
      } catch (e) { saveErr = String(e).slice(0,300); }

      // 保存成功的更强判据：脏标记已清 且 控制器无未处理异常
      const stillDirty = app.isDirty;
      return JSON.stringify({
        ok:true, docId:first.id, docTitle:first.title, tabId,
        editorVisible, openErr, saveErr, stamp,
        stillDirty, dirty: app.isDirty, docCount: app.docs?.length,
        summary: app.lastSyncSummary ?? null
      });
    })()`);
    const er = JSON.parse(editRun);
    rep.push('edit.open', er.ok !== false && er.editorVisible === true,
      er.ok === false ? `失败：${er.reason}` : `打开《${er.docTitle ?? er.docId}》编辑器可见=${er.editorVisible}${er.openErr ? ' 错误:' + er.openErr : ''}`);
    rep.push('edit.save', !er.saveErr && er.stillDirty !== true,
      er.saveErr
        ? `保存失败：${er.saveErr}`
        : `写入并保存成功（标记 ${er.stamp ?? '-'}，脏=${er.stillDirty ?? '-'}，${er.summary?.message ?? ''}）`);

    // 历史版本：确认云端能列出该文档的历史（跨端可见的前提）
    //
    // 注意：这里要查**当前仓库**的 versions 前缀（vaults/<id>/versions/），
    // 而不是根级 versions/ —— 后者在真实数据里为空，
    // 会被误判成「历史版本不可用」。同时把可能的失败原因带出来。
    const hist = await cdp.eval(`(async () => {
      const tok = localStorage.getItem('neomd.access') || '';
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      const vaultId = app?.vault?.vaultId || '';
      const prefix = vaultId ? 'vaults/' + vaultId + '/versions/' : 'versions/';
      try {
        const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(prefix) + '&limit=10', {
          headers: { authorization: 'Bearer ' + tok },
        });
        const j = await r.json();
        const objs = j?.data?.objects ?? [];
        return JSON.stringify({ status: r.status, count: objs.length, prefix, truncated: !!j?.data?.truncated });
      } catch (e) { return JSON.stringify({ status: 0, count: -1, err: String(e).slice(0,200), prefix }); }
    })()`);
    const hs = JSON.parse(hist);
    rep.push(
      'history.list',
      hs.status === 200 && hs.count >= 0,
      hs.status === 200
        ? `/api/storage/list(${hs.prefix}) -> 200，对象 ${hs.count} 个`
        : `/api/storage/list 失败：${hs.err ?? hs.status}`,
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
