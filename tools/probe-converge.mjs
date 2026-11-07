/**
 * Observe a fresh install for a few minutes and report how the doc count grows.
 *
 * The goal is to distinguish two very different situations:
 *   a) sync is working and simply streaming in documents over time (count climbs
 *      towards the full vault), or
 *   b) sync adopted a small leftover vault and stalls (count flat at a low value).
 *
 * Only (a) is acceptable: the user's complaint was "logged in but the vault never
 * syncs", so a flat low number is still a bug.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const NAME = process.argv[2] ?? 'qt';
const SHELLS = {
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
};
const spec = SHELLS[NAME];
const DIR = path.join(RELEASE, spec.dir);
const EXE = path.join(DIR, spec.exe);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9641;
const CHROME_DIR = path.join(process.cwd(), '.tmp-converge');
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
  async eval(expr, timeoutMs = 60000) {
    const p = this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

(async () => {
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
  await sleep(4000);

  // wipe session state
  const dataDir = path.join(DIR, 'data');
  const KEEP = new Set(['app.so', 'icudtl.dat', 'fonts', 'packages', 'shaders',
    'AssetManifest.bin', 'FontManifest.json', 'NativeAssetsManifest.json', 'NOTICES.Z']);
  if (fs.existsSync(dataDir)) {
    for (const e of fs.readdirSync(dataDir)) {
      if (NAME === 'flutter' && KEEP.has(e)) continue;
      fs.rmSync(path.join(dataDir, e), { recursive: true, force: true });
    }
  }

  spawn(EXE, spec.args, { cwd: DIR, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 45; i++) {
    await sleep(700);
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'boot.json'), 'utf8');
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
  await sleep(8000);

  // Log in through the real UI path so the app's own store triggers adoption
  const loginRes = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'conv-'+Date.now()})
    });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return 'ok';
    }
    return 'fail';
  })()`);
  console.log('login =', loginRes);

  await cdp.send('Page.reload');
  await sleep(6000);
  await cdp.send('Runtime.enable');

  console.log('\n  t     docs  vaultId(-8)   syncState  summary');
  for (let i = 1; i <= 18; i++) {
    await sleep(10000);
    const s = await cdp.eval(`(() => {
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({
        d: (app?.docs||[]).length,
        v: (app?.vault?.vaultId||'').slice(-8),
        st: app?.syncState ?? '',
        m: (app?.lastSyncSummary?.message ?? '').slice(0, 34)
      });
    })()`);
    try {
      const o = JSON.parse(s);
      console.log(`  ${String(i * 10).padStart(3)}s  ${String(o.d).padStart(5)}  ${o.v.padEnd(11)}  ${o.st.padEnd(9)}  ${o.m}`);
      if (i >= 6 && o.d >= 400) break;
    } catch {
      console.log(`  ${String(i * 10).padStart(3)}s  ${s}`);
    }
  }

  ws.close();
  try {
    execSync('taskkill /IM chrome.exe', { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
  process.exit(0);
})();
