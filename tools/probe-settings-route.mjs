/**
 * Does /settings actually work in the built shell?
 *
 * A model-driven test reported "SPA client-side routing to /settings fails:
 * history.pushState leaves the page at /app". That claim needs checking before
 * it is treated as a product bug, because calling history.pushState directly
 * bypasses Vue Router entirely -- the router never sees the navigation, so
 * staying on /app is the *correct* behaviour for that (wrong) test method.
 *
 * This probe tests both ways:
 *   a) history.pushState -- the reported method
 *   b) the router's own API (router.push) -- what the UI actually uses
 *   c) clicking the real settings entry point in the UI
 *
 * If (b)/(c) reach /settings, the report was a false positive.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;

const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'] },
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
    this.ws = ws;
    this.id = 0;
    this.wait = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) {
        this.wait.get(m.id)(m);
        this.wait.delete(m.id);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.wait.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeoutMs = 90000) {
    const p = this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
    }
    return r.result?.result?.value;
  }
}

async function connect(target) {
  const ws = new WebSocket(target);
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

  // Prefer the shell's own DevTools endpoint; fall back to external Chrome.
  let cdp = null;
  let ws = null;
  const dbg = { qt: 9642 }[SHELL];
  if (dbg) {
    for (let i = 0; i < 30; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { ({ ws, cdp } = await connect(page.webSocketDebuggerUrl)); break; }
      } catch {}
      await sleep(700);
    }
  }
  if (!cdp) {
    const cd = path.join(process.cwd(), `.tmp-settings-${SHELL}`);
    fs.rmSync(cd, { recursive: true, force: true });
    spawn(CHROME, ['--remote-debugging-port=9645', `--user-data-dir=${cd}`, '--headless=new',
      '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9645/json/version'); if (r.ok) break; } catch {} }
    const t = await (await fetch(`http://127.0.0.1:9645/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
    ({ ws, cdp } = await connect(t.webSocketDebuggerUrl));
    await cdp.send('Page.navigate', { url: origin + '/' });
  }
  await sleep(8000);
  await cdp.send('Runtime.enable');

  // Log in so the app shell (not the login page) is mounted.
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'settings-'+Date.now()}) });
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

  console.log('\n=== (a) history.pushState -- the method the report used ===');
  const a = await cdp.eval(`(async () => {
    const before = location.pathname;
    history.pushState({}, '', '/settings');
    await new Promise(function (r) { setTimeout(r, 2500); });
    return JSON.stringify({ before: before, after: location.pathname,
      bodyLen: document.body.innerText.length,
      hasSettingsUI: !!document.querySelector('.settings, [class*="settings"]') });
  })()`, 60000);
  console.log(a);

  console.log('\n=== (b) router.push -- what the UI really uses ===');
  const b = await cdp.eval(`(async () => {
    const app = document.querySelector('#app');
    const vue = app && app.__vue_app__;
    const router = vue && vue.config.globalProperties.$router;
    if (!router) return JSON.stringify({ err:'no router on app' });
    const before = location.pathname;
    let err = '';
    try { await router.push('/settings'); } catch(e) { err = String(e).slice(0,200); }
    await new Promise(function (r) { setTimeout(r, 2500); });
    return JSON.stringify({ before: before, after: location.pathname, err: err,
      routePath: router.currentRoute && router.currentRoute.value && router.currentRoute.value.path,
      bodyLen: document.body.innerText.length,
      textHead: document.body.innerText.slice(0, 160) });
  })()`, 60000);
  console.log(b);

  console.log('\n=== (c) click the real settings entry in the UI ===');
  const c = await cdp.eval(`(async () => {
    // go back to the editor first
    const app = document.querySelector('#app');
    const router = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router;
    if (router) { try { await router.push('/app'); } catch(e) {} }
    await new Promise(function (r) { setTimeout(r, 2000); });

    // find a clickable element whose text mentions settings
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], .nav__item, .side__item'));
    const hit = nodes.find(function (n) {
      const t = (n.innerText || '').trim();
      return /设置|Settings/i.test(t);
    });
    if (!hit) return JSON.stringify({ found:false, candidates: nodes.slice(0,12).map(function(n){return (n.innerText||'').trim().slice(0,20);}) });
    hit.click();
    await new Promise(function (r) { setTimeout(r, 3000); });
    return JSON.stringify({ found: true, label: (hit.innerText||'').trim().slice(0,30),
      after: location.pathname, bodyLen: document.body.innerText.length,
      textHead: document.body.innerText.slice(0, 200) });
  })()`, 90000);
  console.log(c);

  console.log('\n=== (d) direct load of /settings (fresh navigation) ===');
  const d = await cdp.eval(`(async () => {
    return JSON.stringify({ hint: 'see next line via Page.navigate' });
  })()`, 30000);
  await cdp.send('Page.navigate', { url: origin + '/settings' });
  await sleep(7000);
  await cdp.send('Runtime.enable');
  const d2 = await cdp.eval(`(() => JSON.stringify({
    path: location.pathname, bodyLen: document.body.innerText.length,
    textHead: document.body.innerText.slice(0, 200)
  }))()`, 30000);
  console.log(d2);

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
