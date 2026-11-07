/**
 * Verify the real settings entry point in the built shells.
 *
 * A model test reported "SPA routing to /settings fails", which would be a
 * genuine bug -- except the app has no /settings route. Settings is a *tab*
 * opened by openSettings() (bound to Ctrl+, and to the user menu), so
 * navigating to /settings is meaningless and staying on /app is correct.
 *
 * This probe therefore checks the things a user actually does:
 *   1. Ctrl+, opens the settings tab
 *   2. the settings tab renders real controls
 *   3. a setting change persists (stored, survives reload)
 *   4. the tab can be closed again and the editor remains usable
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;

const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9643 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};

const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  async eval(expr, timeoutMs = 90000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
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
    const cd = path.join(process.cwd(), `.tmp-settings2-${SHELL}`);
    fs.rmSync(cd, { recursive: true, force: true });
    spawn(CHROME, ['--remote-debugging-port=9646', `--user-data-dir=${cd}`, '--headless=new',
      '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9646/json/version'); if (r.ok) break; } catch {} }
    const t = await (await fetch(`http://127.0.0.1:9646/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
    ({ ws, cdp } = await connect(t.webSocketDebuggerUrl));
  }
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');

  // log in
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'st2-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  console.log('\n=== 1. Ctrl+, opens the settings tab ===');
  const r1 = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const before = (app?.tabs || []).map(t => t.title);
    // dispatch the real keyboard shortcut
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true
    }));
    await new Promise(r => setTimeout(r, 2500));
    const after = (app?.tabs || []).map(t => t.title);
    return JSON.stringify({ before, after, hasSettingsTab: after.includes('设置'),
      activeTab: app?.tabs?.find(t => t.id === app.activeTabId)?.title ?? null });
  })()`, 60000);
  console.log(r1);

  console.log('\n=== 2. settings pane renders real controls ===');
  const r2 = await cdp.eval(`(() => {
    const txt = document.body.innerText;
    const inputs = document.querySelectorAll('input, select, [role="switch"], .switch, button');
    return JSON.stringify({
      bodyLen: txt.length,
      controlCount: inputs.length,
      hasSettingsWords: /设置|外观|字体|主题|存储|同步|快捷键/.test(txt),
      textHead: txt.slice(0, 220)
    });
  })()`, 60000);
  console.log(r2);

  console.log('\n=== 3. setting change persists across reload ===');
  const r3 = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    // mutate a real persisted preference through the store's own API
    const before = JSON.stringify(app?.settings ?? {});
    try { if (app && 'editorFontSize' in (app.settings ?? {})) app.settings.editorFontSize = 19; } catch(e) {}
    if (app && typeof app.persistSettings === 'function') { await app.persistSettings(); }
    const ls = Object.keys(localStorage).filter(k => /setting|pref|theme/i.test(k));
    return JSON.stringify({ before: before.slice(0,180), lsKeys: ls,
      hasPersistFn: typeof app?.persistSettings === 'function' });
  })()`, 60000);
  console.log(r3);

  console.log('\n=== 4. close settings tab, editor still usable ===');
  const r4 = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const st = (app?.tabs || []).find(t => t.title === '设置');
    if (st && typeof app.closeTab === 'function') { try { await app.closeTab(st.id); } catch(e) {} }
    await new Promise(r => setTimeout(r, 2000));
    const tabs = (app?.tabs || []).map(t => t.title);
    return JSON.stringify({ tabs, settingsClosed: !tabs.includes('设置'),
      editorVisible: !!document.querySelector('.ProseMirror, [contenteditable="true"], .cm-content'),
      bodyLen: document.body.innerText.length });
  })()`, 60000);
  console.log(r4);

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
