/**
 * 验证「标题栏与编辑器顶部标签栏合并」是否真的生效。
 *
 * 目标原文要求：修复所有版本标题栏与编辑器顶部标签栏合并问题。
 * 代码上的实现方式（packages/ui/src/index.css + TabBar.vue:400）：
 *   - 各壳都是无边框窗口（tauri `"decorations": false`、Qt FramelessWindowHint、
 *     Electron frame:false、Flutter 无边框），系统标题栏不占空间；
 *   - 标签栏元素本身带 `titlebar nm-drag` 两个 class，即**标签栏就是拖动区**；
 *   - 全局 `html[data-runtime='desktop'] .nm-drag { -webkit-app-region: drag }`
 *     让它在桌面端可拖窗；其内部 button/[role=tab]/input 等自动变 no-drag。
 *
 * 只读代码不能证明"没合并"或"合并了但高度错位"。本探针在真实壳里量：
 *   1. 是否存在两个独立横条（系统标题栏区域 + 标签栏）→ 看顶部是否有双倍留白
 *   2. 标签栏顶部到视口顶部的距离（合并成功应 ≈ 0）
 *   3. 标签栏的可拖动区是否真的覆盖了标题栏高度（--titlebar-h = 40px）
 *   4. 标签栏内按钮是否 no-drag（否则点不动）
 *   5. 是否存在「标题栏和标签栏各画一次」导致的高度重复（tabbar 上边界 > 0）
 *
 * Run: node tools/probe-titlebar-merge.mjs <shell> [version]
 *   shell ∈ tauri | qt | flutter | winui3
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SHELL = process.argv[2] ?? 'tauri';
const VERSION = process.argv[3] ?? '2.3.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CFG = {
  tauri: { exe: 'NeoMD.exe', cdp: 9781, env: {} },
  qt: { exe: 'NeoMD.exe', cdp: 9782, env: { QTWEBENGINE_REMOTE_DEBUGGING: '9782' }, args: ['--no-sandbox'] },
  flutter: { exe: 'neomd_flutter.exe', cdp: 9783, env: {} },
  winui3: { exe: 'NeoMD.WinUI3.exe', cdp: 9784, env: {} },
};
const c = CFG[SHELL];
if (!c) { console.error('shell 必须是 tauri/qt/flutter/winui3'); process.exit(2); }

const SRC = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}\\NeoMD-${VERSION}-${SHELL}-x64`;
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\tb-${SHELL}-${VERSION}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.wait.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, timeoutMs = 180000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text });
    return r.result?.result?.value;
  }
}

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && !/devtools/.test(t.url));
      if (page) return page;
    } catch {}
  }
  return null;
}

(async () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
  try { execFileSync('robocopy', [SRC, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' }); }
  catch (e) { if (typeof e.status !== 'number' || e.status > 7) throw e; }
  // 清会话态但**保留 data/vault 目录结构**，避免回落用户真实仓库
  for (const sub of ['boot.json', 'server-port.txt', 'webengine', 'webview2', 'userData', 'logs', 'chrome-cdp-tmp']) {
    try { fs.rmSync(path.join(dir, 'data', sub), { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch {}
  }

  const env = { ...process.env, ...c.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(c.args ?? [])];
  spawn(path.join(dir, c.exe), args, { cwd: dir, env, stdio: 'ignore' });
  await sleep(6000);

  // 壳自带的 CDP（qt/flutter/winui3 常不可用）→ 回落到 HTTP + 外部 Chrome
  let target = await connect(c.cdp);
  let browser = null;
  if (!target) {
    let url = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      try {
        const b = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'boot.json'), 'utf8'));
        if (b && b.url) { url = b.url; break; }
      } catch {}
    }
    if (!url) { console.log('既无 CDP 也无 boot.json.url'); process.exit(1); }
    const chromeDir = path.join(dir, 'chrome-cdp-tmp');
    browser = spawn(CHROME, [
      `--remote-debugging-port=${c.cdp}`,
      `--user-data-dir=${chromeDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--window-size=1440,900', url,
    ], { stdio: 'ignore' });
    target = await connect(c.cdp);
  }
  if (!target) { console.log('无法连接 CDP'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const wsc = new Cdp(ws);
  await wsc.send('Runtime.enable');
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const r = await wsc.eval(`!!document.querySelector('#app')?.__vue_app__`);
    if (r === true) break;
  }

  const res = await wsc.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    out.runtime = document.documentElement.dataset.runtime ?? '(未设置)';
    out.innerWidth = window.innerWidth;
    out.innerHeight = window.innerHeight;

    // 1) 标签栏几何
    const tb = document.querySelector('.titlebar') || document.querySelector('[class*="tabbar"]');
    if (tb) {
      const r = tb.getBoundingClientRect();
      const cs = getComputedStyle(tb);
      out.tabbar = {
        found: true,
        top: Math.round(r.top), left: Math.round(r.left),
        height: Math.round(r.height), bottom: Math.round(r.bottom),
        classes: tb.className,
        isDrag: tb.classList.contains('nm-drag'),
        webkitAppRegion: cs.webkitAppRegion ?? cs.getPropertyValue('-webkit-app-region') ?? '(n/a)',
      };
    } else {
      out.tabbar = { found: false };
    }

    // 2) --titlebar-h 实际值
    out.titlebarH = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim();

    // 3) 是否双倍留白：视口顶部到标签栏顶部之间的距离
    //    合并成功应 ≈ 0；若有系统标题栏残留会 > 0
    out.gapAboveTabbar = out.tabbar.found ? out.tabbar.top : null;

    // 4) 页面第一个可见元素是不是标签栏（合并后应如此）
    const first = document.body.firstElementChild;
    out.bodyFirstChild = first ? first.className || first.tagName : null;

    // 5) 标签栏内按钮是否 no-drag（能点）
    const btns = Array.from(document.querySelectorAll('.titlebar button, .titlebar [role="tab"], .titlebar [role="button"]'));
    out.tabbarInteractive = btns.slice(0, 8).map((b) => {
      const s = getComputedStyle(b);
      return {
        tag: b.tagName.toLowerCase(),
        cls: String(b.className || '').slice(0, 40),
        appRegion: s.webkitAppRegion ?? s.getPropertyValue('-webkit-app-region') ?? '(n/a)',
      };
    });
    out.tabbarBtnCount = btns.length;

    // 6) 标题栏与标签栏是否**重复**：找到所有候选横条，看是否有两个都贴顶
    const bars = Array.from(document.querySelectorAll('*')).filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.top <= 2 && r.width > window.innerWidth * 0.6 && r.height > 16 && r.height < 120;
    }).map((el) => ({
      cls: String(el.className || '').slice(0, 50), tag: el.tagName.toLowerCase(),
      top: Math.round(el.getBoundingClientRect().top),
      h: Math.round(el.getBoundingClientRect().height),
    }));
    out.topBars = bars.slice(0, 6);

    // 7) 进编辑器（登录后），量编辑态下标签栏位置
    try {
      const r = await fetch('https://md.zhengl.vip/api/auth/login', { method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({account:'admin',password:'6655',deviceId:'tb-'+Date.now()}) });
      const j = await r.json();
      if (j?.data?.accessToken) {
        localStorage.setItem('neomd.access', j.data.accessToken);
        if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
        out.loggedIn = true;
      }
    } catch (e) { out.loginErr = String(e).slice(0,120); }
    return JSON.stringify(out);
  })()`, 180000);

  console.log(`\n=== ${SHELL} 标题栏/标签栏合并探针 ===`);
  let o = {};
  try { o = JSON.parse(res); console.log(JSON.stringify(o, null, 2)); } catch { console.log(res); }

  // 登录后重载，进编辑态再量一次
  const reload = await wsc.eval(`location.reload(), 'reloading'`, 20000).catch(() => 'x');
  await sleep(15000);
  await wsc.send('Runtime.enable');
  const res2 = await wsc.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no store' });
    for (let i = 0; i < 40 && (app.docs||[]).length === 0; i++) await sleep(2500);
    const d = (app.docs||[])[0];
    if (d) await app.openDoc(d.docId);
    await sleep(3000);
    const out = { inEditor: !!document.querySelector('.shell__work, .editor, .cm-editor, .ProseMirror') };
    const tb = document.querySelector('.titlebar');
    if (tb) {
      const r = tb.getBoundingClientRect();
      out.tabbarInEditor = { top: Math.round(r.top), height: Math.round(r.height), classes: tb.className,
        isDrag: tb.classList.contains('nm-drag') };
    }
    out.titlebarH = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim();
    // 编辑态下 shell 顶部内容是否被标签栏遮挡
    const work = document.querySelector('.shell__work');
    if (work) {
      const wr = work.getBoundingClientRect();
      out.workTop = Math.round(wr.top);
      out.overlapWithTabbar = tb ? Math.round(tb.getBoundingClientRect().bottom - wr.top) : null;
    }
    return JSON.stringify(out);
  })()`, 240000);
  console.log(`\n=== ${SHELL} 编辑态复测 ===`);
  try { console.log(JSON.stringify(JSON.parse(res2), null, 2)); } catch { console.log(res2); }

  ws.close();
  try { execFileSync('taskkill', ['/F', '/IM', c.exe, '/T'], { stdio: 'ignore' }); } catch {}
  if (browser) { try { browser.kill(); } catch {} }
  try { execFileSync('taskkill', ['/F', '/FI', 'WINDOWTITLE eq *Neo MD*', '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
