/**
 * Verify the keyboard shortcuts that users actually press.
 *
 * Two conflicting claims were reported:
 *   - another model said Ctrl+E "is bound to two commands and mode never cycles"
 *   - the code says Ctrl+E -> app.cycleMode() only, while FormatToolbar's tooltip
 *     *claimed* "行内代码 Ctrl+E" (a binding that never existed)
 *
 * So there is a real defect, but it is a misleading tooltip, not a duplicate
 * binding. This probe pins the behaviour so the claim can be settled with data:
 *   1. Ctrl+E cycles the editor mode (and by exactly one step each time)
 *   2. the tooltip no longer advertises Ctrl+E for inline code
 *   3. the shortcuts the UI does advertise (Ctrl+S / Ctrl+, / Ctrl+P) fire
 *
 * Run: node tools/probe-shortcuts.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9653 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9654;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
    });
  }
  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.id;
    return new Promise((res) => { this.wait.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, timeoutMs = 120000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text });
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
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args, { cwd: dir, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    try {
      const b = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(b)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(b, 'utf8'));
        if (m) { origin = m[1].replace(/\/$/, ''); break; }
      }
    } catch {}
  }
  console.log(`shell=${SHELL} version=${VERSION} origin=${origin}`);

  let cdp = null, ws = null;
  if (spec.dbg) {
    for (let i = 0; i < 30; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${spec.dbg}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { ({ ws, cdp } = await connect(page.webSocketDebuggerUrl)); break; }
      } catch {}
      await sleep(700);
    }
  }
  if (!cdp) {
    const cd = path.join(process.cwd(), `.tmp-short-${SHELL}`);
    fs.rmSync(cd, { recursive: true, force: true });
    spawn(CHROME, ['--remote-debugging-port=' + CDP_PORT, `--user-data-dir=${cd}`, '--headless=new',
      '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {} }
    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
    ({ ws, cdp } = await connect(t.webSocketDebuggerUrl));
  }
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'short-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(18000);
  await cdp.send('Runtime.enable');

  // open a document so the editor has an active tab with a mode
  const opened = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 60; i++) { if ((app?.docs||[]).length) break; await sleep(2000); }
    const first = (app.docs||[])[0];
    if (!first) return JSON.stringify({ ok:false, why:'no docs', docs:(app.docs||[]).length });
    await app.openDoc(first.docId ?? first.id);
    await sleep(3000);
    const tab = app.tabs?.find(t => t.id === app.activeTabId);
    return JSON.stringify({ ok:true, docId:first.docId, title:first.title, mode: tab?.mode ?? null });
  })()`, 300000);
  console.log('\n=== opened doc ===');
  console.log(opened);

  console.log('\n=== 1. Ctrl+E cycles mode, one step per press ===');
  const cyc = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const tab = () => app.tabs?.find(t => t.id === app.activeTabId);
    const modes = [];
    modes.push(tab()?.mode ?? null);
    for (let i = 0; i < 4; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true
      }));
      await sleep(900);
      modes.push(tab()?.mode ?? null);
    }
    const uniq = Array.from(new Set(modes));
    return JSON.stringify({ modes, distinct: uniq.length, uniq });
  })()`, 90000);
  console.log(cyc);

  console.log('\n=== 2. tooltips: does any still advertise Ctrl+E for inline code? ===');
  const tips = await cdp.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('[title]'));
    const ctrlE = nodes.map(n => n.getAttribute('title')).filter(t => t && /Ctrl\\+E/.test(t));
    const codeTip = nodes.map(n => n.getAttribute('title')).filter(t => t && /行内代码/.test(t));
    return JSON.stringify({ ctrlE: ctrlE, codeTips: codeTip, totalTitled: nodes.length });
  })()`, 60000);
  console.log(tips);

  console.log('\n=== 3. advertised shortcuts actually fire ===');
  const fire = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const out = {};

    // Ctrl+, -> settings tab
    document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(2200);
    out.settingsTab = (app.tabs||[]).some(t => t.title === '设置');
    const st = (app.tabs||[]).find(t => t.title === '设置');
    if (st && app.closeTab) { try { await app.closeTab(st.id); } catch(e){} }
    await sleep(800);

    // Ctrl+P -> command palette
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'p', code:'KeyP', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(1600);
    out.paletteOpen = !!document.querySelector('.palette, .cmdpalette, [class*="palette"]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true, cancelable:true }));
    await sleep(600);

    // Ctrl+S -> save (should not throw, dirty cleared)
    const tab = app.tabs?.find(t => t.id === app.activeTabId);
    if (tab) { await app.updateTabContent(tab.id, (tab.content ?? '') + '\\n\\nSHORTCUT-PROBE'); await sleep(600); }
    const dirtyBefore = app.tabs?.find(t => t.id === app.activeTabId)?.dirty ?? null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'s', code:'KeyS', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(4000);
    out.dirtyBeforeSave = dirtyBefore;
    out.dirtyAfterSave = app.tabs?.find(t => t.id === app.activeTabId)?.dirty ?? null;

    return JSON.stringify(out);
  })()`, 120000);
  console.log(fire);

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
