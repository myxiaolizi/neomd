/**
 * Diagnose "logged in but vault stays empty" on a fixed-port shell.
 *
 * Uses the same origin across runs, so localStorage now PERSISTS.
 * We dump the store state, force a sync, and read lastSyncSummary / syncLogs
 * to see which branch the sync engine actually takes.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const NAME = process.argv[2] ?? 'qt';
const SHELLS = {
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'], cdp: 'env' },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [], cdp: 'flag' },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [], cdp: 'flag' },
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [], cdp: 'env' },
};
const spec = SHELLS[NAME];
const DIR = path.join(RELEASE, spec.dir);
const EXE = path.join(DIR, spec.exe);
const CDP = 9513;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kill = () => {
  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
};

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
    const ex = r.result?.exceptionDetails;
    if (ex) {
      return { __err: ex.text, desc: ex.exception?.description?.slice(0, 300) };
    }
    return r.result?.result?.value;
  }
}

const STORE = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

(async () => {
  kill();
  await sleep(3000);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...spec.args];
  if (spec.cdp === 'env') env.QTWEBENGINE_REMOTE_DEBUGGING = String(CDP);
  else args.push(`--remote-debugging-port=${CDP}`);

  spawn(EXE, args, { cwd: DIR, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      const b = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8'));
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(b.url || '');
      if (m) {
        origin = m[1].replace(/\/$/, '');
        break;
      }
    } catch {}
  }
  console.log('origin =', origin);

  let target = null;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!target) {
    console.log('NO TARGET');
    kill();
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await sleep(7000);

  const state = await cdp.eval(`(() => {
    const app = ${STORE};
    return JSON.stringify({
      docs: (app.docs||[]).length,
      vaultId: app.vault?.vaultId ?? '',
      vaultName: app.vault?.name ?? '',
      vaultLoc: app.vault?.location ?? '',
      syncState: app.syncState ?? '',
      summary: app.lastSyncSummary?.message ?? '',
      isLoggedIn: !!localStorage.getItem('neomd.access'),
      firstSyncFlags: Object.keys(localStorage).filter(k => k.includes('firstSyncDone'))
        .map(k => k + '=' + localStorage.getItem(k))
    });
  })()`);
  console.log('\n=== store state ===');
  console.log(typeof state === 'string' ? state : JSON.stringify(state));

  // Force a sync directly and capture the result message
  const forced = await cdp.eval(`(async () => {
    const app = ${STORE};
    const logs = [];
    const orig = console.error;
    try {
      await new Promise(r => setTimeout(r, 500));
      const before = (app.docs||[]).length;
      await app.syncNow({ silent: true });
      await new Promise(r => setTimeout(r, 3000));
      const after = (app.docs||[]).length;
      return JSON.stringify({
        ok: true, before, after,
        syncState: app.syncState,
        summary: app.lastSyncSummary?.message ?? '',
        logs: (app.syncLogs||[]).slice(-4).map(l => (l.message||'').slice(0,160))
      });
    } catch (e) {
      return JSON.stringify({ ok:false, err: String(e).slice(0,300),
        summary: app.lastSyncSummary?.message ?? '' });
    }
  })()`);
  console.log('\n=== forced syncNow ===');
  console.log(typeof forced === 'string' ? forced : JSON.stringify(forced));

  // Wait for a background pull to land
  for (let i = 0; i < 10; i++) {
    await sleep(5000);
    const n = await cdp.eval(`(() => {
      const app = ${STORE};
      return JSON.stringify({ docs:(app.docs||[]).length, syncState: app.syncState,
        summary: app.lastSyncSummary?.message ?? '' });
    })()`);
    console.log(`[+${(i + 1) * 5}s]`, typeof n === 'string' ? n : JSON.stringify(n));
    try {
      if (JSON.parse(n).docs > 0) break;
    } catch {}
  }

  ws.close();
  kill();
  process.exit(0);
})();
