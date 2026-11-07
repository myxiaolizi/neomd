/**
 * Verify that the login state survives a restart (fixed-port shells).
 *
 * Approach: do NOT try to open a DevTools endpoint inside the shell.
 * Only QtWebEngine exposes one (via QTWEBENGINE_REMOTE_DEBUGGING), while
 * wry/WebView2 shells ignore both the Chromium flag and
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
 *
 * Instead drive an external headless Chrome to the SAME origin the shell
 * serves. localStorage is keyed by origin, so Chrome and the shell share the
 * exact same store as long as the port is stable -- which is precisely the
 * property under test.
 *
 *   round 1: open origin, log in, stamp a probe key, close Chrome GRACEFULLY
 *   restart : kill the shell, start it again (port must be unchanged)
 *   round 2: open origin again in a fresh Chrome, read token + probe back
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
const CDP_PORT = 9541;
// Chrome gets its own throwaway profile; the SHELL's store is what we measure.
const CHROME_DIR = path.join(process.cwd(), '.tmp-persist-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const killShell = () => {
  try {
    execSync(`taskkill /IM "${spec.exe}"`, { stdio: 'ignore' });
  } catch {}
};
const killShellHard = () => {
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
};
function waitGone(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${spec.exe}" /NH`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!out.includes(spec.exe)) return true;
    } catch {}
    try {
      execSync('ping -n 1 -w 400 127.0.0.1', { stdio: 'ignore' });
    } catch {}
  }
  return false;
}

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
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

/** Start the shell and wait until it advertises its origin via data/boot.json */
async function startShell() {
  killShell();
  if (!waitGone(15000)) killShellHard();
  await sleep(4000);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(EXE, spec.args, { cwd: DIR, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 45; i++) {
    await sleep(700);
    try {
      const raw = fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8');
      const m = /"url"\s*:\s*"(http:\/\/127\.0\.0\.1:(\d+)\/?)"/.exec(raw);
      if (m) {
        origin = m[1].replace(/\/$/, '');
        break;
      }
    } catch {}
  }
  if (!origin) {
    // Fall back to the socket the shell listens on (http.sys shells may differ)
    origin = null;
  }
  return origin;
}

let chromeProc = null;
async function startChrome() {
  fs.rmSync(CHROME_DIR, { recursive: true, force: true });
  chromeProc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_DIR}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return JSON.parse(await r.text()).webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error('Chrome CDP not ready');
}

async function openOrigin(origin) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(origin + '/')}`, {
    method: 'PUT',
  });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  // A brand-new target starts at about:blank where localStorage is unavailable;
  // navigate explicitly and give the SPA time to boot.
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(9000);
  return { cdp, ws };
}

function stopChrome() {
  // Graceful close so leveldb flushes
  try {
    execSync('taskkill /IM chrome.exe', { stdio: 'ignore' });
  } catch {}
}

(async () => {
  console.log(`\n########## ${NAME} ##########`);

  // ---------- round 1 ----------
  const o1 = await startShell();
  if (!o1) {
    console.log('round1: shell did not advertise an origin');
    killShellHard();
    process.exit(1);
  }
  console.log('round1 origin =', o1);

  await startChrome();
  const p1 = await openOrigin(o1);

  const login = await p1.cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'persist-'+Date.now()})
    });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      localStorage.setItem('neomd.persistenceProbe', 'STAMP-${Date.now()}');
      return JSON.stringify({ ok:true });
    }
    return JSON.stringify({ ok:false, body: JSON.stringify(j).slice(0,150) });
  })()`);
  console.log('round1 login =', typeof login === 'string' ? login : JSON.stringify(login));

  const saved = await p1.cdp.eval(`JSON.stringify({
    token: (localStorage.getItem('neomd.access')||'').slice(-12),
    probe: localStorage.getItem('neomd.persistenceProbe') || '',
    origin: location.origin
  })`);
  console.log('round1 saved =', saved);

  // Let leveldb flush, then close cleanly
  await sleep(2500);
  p1.ws.close();
  stopChrome();
  await sleep(4000);

  // ---------- restart shell (port must not change) ----------
  killShell();
  if (!waitGone(20000)) killShellHard();
  await sleep(5000);
  const o2 = await startShell();
  console.log('round2 origin =', o2);
  if (!o2) {
    console.log('round2: shell did not advertise an origin');
    killShellHard();
    process.exit(1);
  }

  // ---------- round 2 ----------
  await startChrome();
  const p2 = await openOrigin(o2);

  const restored = await p2.cdp.eval(`JSON.stringify({
    token: (localStorage.getItem('neomd.access')||'').slice(-12),
    probe: localStorage.getItem('neomd.persistenceProbe') || '',
    origin: location.origin
  })`);
  console.log('round2 restored =', restored);

  let ok = false;
  try {
    const a = JSON.parse(saved);
    const b = JSON.parse(restored);
    ok = !!b.token && b.token === a.token && b.probe === a.probe && b.origin === a.origin;
    console.log(
      `\n  origin same  : ${a.origin === b.origin}  (${a.origin} vs ${b.origin})\n` +
        `  token same   : ${!!a.token && a.token === b.token}\n` +
        `  setting same : ${!!a.probe && a.probe === b.probe}`,
    );
  } catch (e) {
    console.log('compare failed', e);
  }

  console.log(`\nVERDICT ${NAME}: ${ok ? 'PERSISTENT' : 'LOST ON RESTART'}`);
  p2.ws.close();
  stopChrome();
  killShell();
  await sleep(1500);
  process.exit(ok ? 0 : 1);
})();
