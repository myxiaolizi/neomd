/**
 * Why does Qt report "仓库还是空的" while data/vault holds 706 docs?
 *
 * Observed on Qt 2.2.0: sync.render failed after 90s with an empty vault, and
 * every downstream edit/history check collapsed because app.docs was empty.
 * On disk the vault is healthy: .neomd/index.json has 706 entries and
 * vault.json points at the right cloud vault id.
 *
 * So the failure is in the load path, not in the data. This probe reads the
 * live store and reports exactly where it diverges:
 *   - vault.vaultId vs the id on disk
 *   - vault.files size vs app.docs length
 *   - auth state and detected vault list
 *   - any error surfaced during restore
 *
 * Run: node tools/probe-qt-empty-vault.mjs 2.2.0 <port>
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9647 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9648;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (!m.id) this.events.push(m);
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
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
    return r.result?.result?.value;
  }
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  return { ws, cdp };
}

(async () => {
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_ENABLE_LOGGING = '1';
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
    const cd = path.join(process.cwd(), `.tmp-emptyvault-${SHELL}`);
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

  // Snapshot before touching anything: what did the persisted session restore?
  const pre = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no store' });
    const auth = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('auth');
    return JSON.stringify({
      ok:true,
      isLoggedIn: auth?.isLoggedIn ?? null,
      username: auth?.user?.username ?? null,
      vaultId: app.vault?.vaultId ?? null,
      vaultName: app.vault?.name ?? null,
      filesSize: app.vault?.files?.size ?? null,
      docsLen: (app.docs || []).length,
      vaultsLen: (app.vaults || []).length,
      vaults: (app.vaults || []).slice(0, 8).map(v => ({ id:v.id, name:v.name, docCount:v.docCount })),
      syncState: app.syncState,
      lsAccess: (localStorage.getItem('neomd.access') || '').length,
      lsVault: localStorage.getItem('neomd.lastVaultId') || null,
    });
  })()`, 60000);
  console.log('\n=== pre-login state ===');
  console.log(pre);

  // Now log in properly and watch whether the vault gets adopted.
  const post = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'empty-vault-'+Date.now()}) });
    const j = await r.json();
    if (!j?.data?.accessToken) return JSON.stringify({ ok:false, why:'login failed', body: JSON.stringify(j).slice(0,300) });
    localStorage.setItem('neomd.access', j.data.accessToken);
    if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    return JSON.stringify({ ok:true, tokenLen: j.data.accessToken.length });
  })()`, 60000);
  console.log('\n=== login ===');
  console.log(post);

  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const after = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const auth = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('auth');
    // give sync a chance, sampling as it goes so we can see it stall
    const samples = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ t: i * 3, docs: (app.docs||[]).length, files: app.vault?.files?.size ?? null,
        state: app.syncState, vaultId: app.vault?.vaultId ?? null });
      await sleep(3000);
    }
    return JSON.stringify({
      isLoggedIn: auth?.isLoggedIn ?? null,
      vaultId: app.vault?.vaultId ?? null,
      vaultName: app.vault?.name ?? null,
      docsLen: (app.docs||[]).length,
      vaultsLen: (app.vaults||[]).length,
      vaults: (app.vaults||[]).slice(0,8).map(v => ({ id:v.id, name:v.name, docCount:v.docCount })),
      samples: samples,
      bodyLen: document.body.innerText.length,
      bodyHead: document.body.innerText.slice(0, 200),
    });
  })()`, 120000);
  console.log('\n=== after login + reload ===');
  console.log(after);

  const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  console.log('\n=== uncaught exceptions: ' + errs.length + ' ===');
  for (const e of errs.slice(0, 5)) {
    console.log('  ' + (e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text || '').slice(0, 300));
  }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
