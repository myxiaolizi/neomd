/**
 * Does changing a setting in the UI actually take effect and persist?
 *
 * A subagent's phase-E run reported `settings` failed:
 *   updateAppearance({fontSize: 25}) -> storeAfterFontSize: 21, ls: 21
 * i.e. the store never changed. If真, that is a real "settings don't apply" defect.
 *
 * But the same run also showed the settings panel opening correctly and the
 * shortcut Ctrl+, changing state, so the store was reachable. Two possibilities:
 *   a) updateAppearance is not the API that the settings UI actually calls
 *      (so the probe exercised a method with different semantics), or
 *   b) fontSize genuinely does not propagate.
 *
 * This probe drives the REAL UI control (the font-size input in the settings
 * tab), not a store method, and then checks three places: store, localStorage,
 * and the rendered CSS. That is the only way to settle "does it take effect".
 *
 * Run: node tools/probe-settings-apply.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9663 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9664;
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
    const cd = path.join(process.cwd(), `.tmp-setapply-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'setapply-'+Date.now()}) });
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

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let st = null; for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
    out.hasStore = !!st;
    out.beforeFontSize = st?.settings?.appearance?.fontSize ?? null;

    // open settings via the real shortcut
    document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(2500);
    out.settingsOpen = (st ? true : false) && !!document.querySelector('.settings-page, .settings');

    // find the font size control in the DOM
    const inputs = Array.from(document.querySelectorAll('.settings input[type="number"], .settings input[type="range"], .settings-page input'));
    out.inputCount = inputs.length;
    out.inputs = inputs.slice(0, 12).map(i => ({
      type: i.type, cls: i.className, value: i.value,
      min: i.min, max: i.max, label: (i.closest('label, .settings__row')?.innerText || '').slice(0, 40),
    }));

    const fsInput = inputs.find(i => /字号|字体大小|font.*size/i.test(i.closest('label, .settings__row')?.innerText || ''))
      || inputs.find(i => i.type === 'number' && Number(i.min) > 10 && Number(i.max) < 40);
    if (!fsInput) return JSON.stringify({ ok:false, why:'找不到字号控件', ...out });

    // drive it like a user: set value + fire input/change
    const target = Number(fsInput.value) + 3;
    fsInput.value = String(target);
    fsInput.dispatchEvent(new Event('input', { bubbles: true }));
    fsInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2500);

    out.target = target;
    out.storeAfter = st?.settings?.appearance?.fontSize ?? null;
    out.lsFontSize = (() => { try { return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}')?.appearance?.fontSize ?? null; } catch { return null; } })();
    out.domFontSize = getComputedStyle(document.querySelector('.ProseMirror, .cm-content, .shell__content') || document.body).fontSize;
    out.storeChanged = out.storeAfter !== out.beforeFontSize;
    out.ok = true;
    return JSON.stringify(out);
  })()`, 300000);

  console.log('\n=== settings apply trace ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
