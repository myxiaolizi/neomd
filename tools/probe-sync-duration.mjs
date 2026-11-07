/**
 * How long does one sync round actually take on this 706-doc vault?
 *
 * Qt 2.2.0 showed syncState stuck at 'syncing' for 27s+ straight after login,
 * which made the acceptance run report "仓库还是空的" and collapsed four
 * downstream checks. Before treating that as a hang, measure it: a full round
 * over 706 docs with per-object HEAD requests is genuinely slow, and the
 * acceptance script's 90s window may simply be too short.
 *
 * This probe instruments the round itself and reports where the time goes:
 *   - total wall time of engine.sync()
 *   - pulled/pushed/skipped counts and error list
 *   - whether a second round (the drain loop) starts immediately after
 *
 * Run: node tools/probe-sync-duration.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9651 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9652;
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
  async eval(expr, timeoutMs = 300000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT after ' + timeoutMs + 'ms' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 400) });
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
    const cd = path.join(process.cwd(), `.tmp-syncdur-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'syncdur-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(15000);
  await cdp.send('Runtime.enable');

  // Let any startup sync settle first, then time one explicit round.
  await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 60; i++) {
      if (app?.syncState === 'idle') break;
      await new Promise(r => setTimeout(r, 2000));
    }
    return 'settled';
  })()`, 180000);

  console.log('\n=== timing one explicit syncNow() round ===');
  const res = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no store' });
    const t0 = Date.now();
    let statePeak = [];
    const watcher = setInterval(() => { statePeak.push(app.syncState); }, 1000);
    try {
      await app.syncNow({ silent: true });
    } catch (e) {
      clearInterval(watcher);
      return JSON.stringify({ ok:false, err:String(e).slice(0,300), ms: Date.now()-t0 });
    }
    clearInterval(watcher);
    const ms = Date.now() - t0;
    return JSON.stringify({
      ok: true, ms: ms,
      statesSeen: Array.from(new Set(statePeak)),
      summary: app.lastSyncSummary ?? null,
      docsLen: (app.docs||[]).length,
      logsTail: (app.syncLogs||[]).slice(0,4).map(l => ({ level:l.level, msg:(l.message||'').slice(0,120) })),
    });
  })()`, 300000);
  console.log(res);

  console.log('\n=== is a queued second round running right now? ===');
  const again = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const samples = [];
    for (let i = 0; i < 6; i++) { samples.push(app.syncState); await new Promise(r => setTimeout(r, 2000)); }
    return JSON.stringify({ samples, final: app.syncState });
  })()`, 60000);
  console.log(again);

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
