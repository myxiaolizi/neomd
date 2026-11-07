/**
 * Electron shows 702 docs in the store but only 294 chars of text on screen.
 *
 * The acceptance run reports:
 *   render.nonblank  正文 294 字，本地文档 702 篇
 *   sync.render      本地 store / 正文：{"docs":702, ...}
 *
 * Both read the same store, so the data is there. What is missing is the DOM:
 * the sidebar list should show hundreds of titles. 294 chars is roughly the
 * empty-state shell ("全部文件 / 仓库还是空的 / AI 助手 ...").
 *
 * So either
 *   a) the list really renders empty despite docs being present (a UI defect), or
 *   b) our text probe runs against a different frame/window than the visible UI.
 *
 * This probe dumps what is actually on screen: counts of rendered list items,
 * the sidebar's innerText, and the route — then decides which it is.
 *
 * Run: node tools/probe-electron-render.mjs 2.2.0
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const DIR = path.join(RELEASE, `NeoMD-${VERSION}-electron-x64`);
const EXE = path.join(DIR, 'Neo MD.exe');
const CDP = 9499;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0,400) });
    return r.result?.result?.value;
  }
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { ws, cdp };
}

(async () => {
  try { execFileSync('taskkill', ['/F', '/IM', 'Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(EXE, [`--remote-debugging-port=${CDP}`], { cwd: DIR, env, stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 50; i++) {
    await sleep(700);
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      wsUrl = v.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
  }
  if (!wsUrl) { console.log('CDP not ready'); process.exit(1); }
  console.log(`electron ${VERSION} CDP ${CDP} ready`);

  // list every page target so we can see if there are several frames
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  console.log('\n=== targets ===');
  for (const t of targets.filter((x) => x.type === 'page')) {
    console.log(`  ${t.url}  ws=${t.webSocketDebuggerUrl ? 'yes' : 'no'}`);
  }

  const pageTarget = targets.find((t) => t.type === 'page' && /neomd:\/\//i.test(t.url)) || targets.find((t) => t.type === 'page');
  const { ws, cdp } = await connect(pageTarget.webSocketDebuggerUrl);

  // log in
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tok = localStorage.getItem('neomd.access');
    if (tok) return 'already';
    const r = await fetch('https://md.zhengl.vip/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'probe-render-'+Date.now()}) });
    const j = await r.json().catch(()=>({}));
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'login:' + (j?.data?.accessToken ? 'ok' : 'fail');
  })()`, 60000);

  await cdp.send('Page.reload');
  await sleep(15000);
  await cdp.send('Runtime.enable');

  console.log('\n=== what is on screen (sampled as it loads) ===');
  for (let round = 0; round < 8; round++) {
    const snap = await cdp.eval(`(async () => {
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      const txt = (document.body.innerText || '');
      const listItems = document.querySelectorAll('.doclist__item, .doc-item, [class*="doclist"] > *, .filetree__item, .tree__item');
      const sidebar = document.querySelector('[class*="sidebar"], [class*="side__"], aside');
      return JSON.stringify({
        round: ${round},
        path: location.pathname,
        bodyLen: txt.trim().length,
        docs: (app?.docs || []).length,
        syncState: app?.syncState,
        emptyHint: txt.includes('仓库还是空的'),
        listItemCount: listItems.length,
        sidebarText: sidebar ? (sidebar.innerText || '').slice(0, 200) : null,
        bodyHead: txt.slice(0, 240).replace(/\\n+/g, ' | '),
      });
    })()`, 90000);
    console.log(snap);
    const o = JSON.parse(snap);
    if (o.bodyLen > 2000) break;
    await sleep(6000);
  }

  console.log('\n=== final DOM census ===');
  const census = await cdp.eval(`(() => {
    const tags = {};
    document.querySelectorAll('*').forEach(el => {
      const c = (el.className && typeof el.className === 'string') ? el.className.split(/\\s+/)[0] : '';
      if (c) tags[c] = (tags[c] || 0) + 1;
    });
    const top = Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0, 25);
    return JSON.stringify({ totalEls: document.querySelectorAll('*').length, top });
  })()`, 60000);
  console.log(census);

  ws.close();
  try { execFileSync('taskkill', ['/F', '/IM', 'Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
