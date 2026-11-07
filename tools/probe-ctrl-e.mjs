/**
 * Why doesn't Ctrl+E cycle the editor mode?
 *
 * Measured: pressing Ctrl+E four times leaves tab.mode at 'wysiwyg' every time.
 * The handler table in EditorPage.vue clearly maps 'Ctrl+E' -> app.cycleMode(),
 * and cycleMode() itself is a correct rotation, so the key event is being lost
 * before it reaches that table.
 *
 * Candidates, in the order the code checks them:
 *   a) the custom-shortcut matcher intercepts Ctrl+E and runs some other command
 *   b) keyCombo() produces something other than the literal 'Ctrl+E'
 *   c) the handler is not mounted / another listener swallows it first
 *   d) cycleMode() runs but MODE_ORDER has a single entry (nothing to cycle to)
 *
 * This probe distinguishes them with data instead of guesswork.
 *
 * Run: node tools/probe-ctrl-e.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9655 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9656;
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
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0,300) });
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
  console.log(`shell=${SHELL} origin=${origin}`);

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
    const cd = path.join(process.cwd(), `.tmp-ctrle-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'ctrle-'+Date.now()}) });
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

  // open a doc
  const opened = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 60; i++) { if ((app?.docs||[]).length) break; await sleep(2000); }
    const first = (app.docs||[])[0];
    if (!first) return JSON.stringify({ ok:false });
    await app.openDoc(first.docId ?? first.id);
    await sleep(3000);
    const tab = app.tabs?.find(t => t.id === app.activeTabId);
    return JSON.stringify({ ok:true, mode: tab?.mode, title: first.title });
  })()`, 300000);
  console.log('\n=== opened ===');
  console.log(opened);

  console.log('\n=== (a) what does the custom-shortcut matcher see? ===');
  const a = await cdp.eval(`(() => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let settings = null;
    for (const [k, v] of stores) {
      if (v && typeof v === 'object' && ('settings' in v)) { settings = v; break; }
    }
    const shortcuts = settings?.settings?.shortcuts ?? null;
    const hitting = (shortcuts || []).filter(s => (s.keys||[]).some(k => String(k).toLowerCase() === 'ctrl+e'));
    return JSON.stringify({
      hasSettingsStore: !!settings,
      shortcutCount: (shortcuts||[]).length,
      ctrlE: hitting.map(s => ({ command: s.command, keys: s.keys })),
      sample: (shortcuts||[]).slice(0,6).map(s => ({ command:s.command, keys:s.keys })),
    });
  })()`, 60000);
  console.log(a);

  console.log('\n=== (b) does the keydown listener run at all? (probe with Ctrl+P too) ===');
  const b = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const tab = () => app.tabs?.find(t => t.id === app.activeTabId);

    const seen = [];
    const spy = (e) => { if (e.ctrlKey) seen.push({ key: e.key, code: e.code, defaultPrevented: e.defaultPrevented }); };
    document.addEventListener('keydown', spy, true);

    // dispatch Ctrl+E and watch defaultPrevented
    const ev = new KeyboardEvent('keydown', { key:'e', code:'KeyE', ctrlKey:true, bubbles:true, cancelable:true });
    document.dispatchEvent(ev);
    await sleep(1500);
    const afterE = { mode: tab()?.mode, prevented: ev.defaultPrevented };

    // Ctrl+, as a control (it is known to work)
    const ev2 = new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true });
    document.dispatchEvent(ev2);
    await sleep(1800);
    const settingsOpened = (app.tabs||[]).some(t => t.title === '设置');
    const afterComma = { prevented: ev2.defaultPrevented, settingsOpened };

    document.removeEventListener('keydown', spy, true);
    return JSON.stringify({ seen, afterE, afterComma });
  })()`, 90000);
  console.log(b);

  console.log('\n=== (c) call cycleMode directly: is MODE_ORDER long enough? ===');
  const c = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const tab = () => app.tabs?.find(t => t.id === app.activeTabId);
    const before = tab()?.mode;
    const modes = [];
    for (let i = 0; i < 4; i++) {
      try { app.cycleMode(); } catch (e) { return JSON.stringify({ err: String(e).slice(0,200) }); }
      await sleep(400);
      modes.push(tab()?.mode);
    }
    return JSON.stringify({ before, modes, distinct: Array.from(new Set(modes)).length });
  })()`, 60000);
  console.log(c);

  console.log('\n=== (d) what does the editor area listeners look like (ProseMirror may swallow) ===');
  const d = await cdp.eval(`(() => {
    const active = document.activeElement;
    return JSON.stringify({
      activeTag: active?.tagName ?? null,
      activeClass: (active?.className ?? '').toString().slice(0,120),
      inProseMirror: !!(active && active.closest && active.closest('.ProseMirror')),
      inCmEditor: !!(active && active.closest && active.closest('.cm-editor')),
      mode: document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app')?.tabs?.find(t => t.id === document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app')?.activeTabId)?.mode ?? null,
    });
  })()`, 60000);
  console.log(d);

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
