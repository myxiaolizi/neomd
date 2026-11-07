/**
 * Check what the per-vault probe actually does inside the page.
 *
 * Ranks candidates by counting storage objects. If every probe returns 0 the
 * ranking falls back to list order; if the probes are slow the adoption path
 * can exceed the acceptance timeout.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const DIR = path.join(RELEASE, 'NeoMD-2.1.0-flutter-x64');
const EXE = path.join(DIR, 'neomd_flutter.exe');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9611;
const CHROME_DIR = path.join(process.cwd(), '.tmp-probe-rank2');
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
    if (r.result?.exceptionDetails) {
      return {
        __err: r.result.exceptionDetails.text,
        d: r.result.exceptionDetails.exception?.description?.slice(0, 400),
      };
    }
    return r.result?.result?.value;
  }
}

(async () => {
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${path.basename(EXE)}" /T`, { stdio: 'ignore' });
  } catch {}
  await sleep(4000);

  spawn(EXE, [], { cwd: DIR, stdio: 'ignore' });

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

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'rank2-'+Date.now()})
    });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return 'ok';
    }
    return 'fail';
  })()`);

  await cdp.send('Page.reload');
  await sleep(14000);
  await cdp.send('Runtime.enable');

  // Count objects per vault using the SAME prefix the app uses
  const counts = await cdp.eval(`(async () => {
    const tok = localStorage.getItem('neomd.access') || '';
    const me = await (await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + tok } })).json().catch(()=>null);
    const uname = me?.data?.user?.username || me?.data?.username || 'admin';
    const vl = await (await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } })).json();
    const arr = vl?.data?.vaults ?? [];
    const out = [];
    for (const v of arr.slice(0, 8)) {
      const pfx = 'users/' + uname + '/vaults/' + v.vaultId + '/docs/';
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(pfx) + '&maxKeys=100',
        { headers: { authorization: 'Bearer ' + tok } });
      const j = await r.json();
      const objs = j?.data?.objects ?? j?.objects ?? [];
      out.push({ id: v.vaultId, name: v.name, docs: objs.length, status: r.status });
    }
    return JSON.stringify({ uname, out });
  })()`, 120000);
  console.log('\n=== per-vault object counts (app prefix) ===');
  console.log(counts);

  const state = await cdp.eval(`(() => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    return JSON.stringify({ vaultId: app?.vault?.vaultId ?? '', docs: (app?.docs||[]).length,
      syncState: app?.syncState ?? '', summary: app?.lastSyncSummary?.message ?? '' });
  })()`);
  console.log('\n=== store state ===');
  console.log(state);

  ws.close();
  try {
    execSync('taskkill /IM chrome.exe', { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${path.basename(EXE)}" /T`, { stdio: 'ignore' });
  } catch {}
  process.exit(0);
})();
