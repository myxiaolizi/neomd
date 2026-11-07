/**
 * Diagnose why the vault-ranking probe picks a 2-doc vault.
 *
 * The store ranks candidate vaults by counting objects through the sync
 * engine's storage client. The main vault has ~899 objects while a test
 * leftover has 2, so the ranking MUST prefer the main one. If it does not,
 * either the probe returns 0 for everything (and we fall back to list order)
 * or the client is not reachable from that code path.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const NAME = process.argv[2] ?? 'flutter';
const SHELLS = {
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
};
const spec = SHELLS[NAME];
const DIR = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9601;
const CHROME_DIR = path.join(process.cwd(), '.tmp-probe-rank');
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description };
    }
    return r.result?.result?.value;
  }
}

(async () => {
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
  await sleep(4000);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(DIR, spec.exe), spec.args, { cwd: DIR, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 45; i++) {
    await sleep(700);
    try {
      const raw = fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8');
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(raw);
      if (m) {
        origin = m[1].replace(/\/$/, '');
        break;
      }
    } catch {}
  }
  console.log('origin =', origin);

  fs.rmSync(CHROME_DIR, { recursive: true, force: true });
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${CHROME_DIR}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) break;
    } catch {}
  }

  const t = await (
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(9000);

  // Log in through the app's own auth store so the sync engine has a token
  const login = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'rank-'+Date.now()})
    });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return 'ok';
    }
    return 'fail';
  })()`);
  console.log('login =', login);

  // Reload so the app boots with a token, then wait for the adoption logic
  await cdp.send('Page.reload');
  await sleep(12000);
  await cdp.send('Runtime.enable');

  // Probe the storage list endpoint exactly the way the store does
  const direct = await cdp.eval(`(async () => {
    const tok = localStorage.getItem('neomd.access') || '';
    const ids = ['vaultmvs9ey2vkpj8q5jy','vaultmw68k3w76zqy5d8b','vaultmw5yhbtwn22np26f'];
    const out = {};
    for (const v of ids) {
      try {
        const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/'+v+'/docs/') + '&maxKeys=100',
          { headers: { authorization: 'Bearer ' + tok } });
        const j = await r.json();
        const objs = j?.data?.objects ?? j?.objects ?? [];
        out[v] = { status: r.status, count: objs.length };
      } catch (e) { out[v] = { err: String(e).slice(0,80) }; }
    }
    return JSON.stringify(out);
  })()`);
  console.log('\n=== direct /api/storage/list per vault ===');
  console.log(direct);

  // Now inspect what the store actually chose
  const state = await cdp.eval(`(() => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    return JSON.stringify({
      vaultId: app?.vault?.vaultId ?? '',
      vaultName: app?.vault?.name ?? '',
      docs: (app?.docs||[]).length,
      syncState: app?.syncState ?? '',
    });
  })()`);
  console.log('\n=== store state after adoption ===');
  console.log(state);

  ws.close();
  try {
    execSync('taskkill /IM chrome.exe', { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
  process.exit(0);
})();
