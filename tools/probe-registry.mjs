#!/usr/bin/env node
/**
 * 定向诊断：runFirstSyncIfNeeded 为什么没能切到云端仓库。
 *
 * 已知：
 *   - isEmptyUnregisteredLocalVault 应为 true（本地 vault 不在云端清单、docs=0）
 *   - remoteIds.size > 0 应为 true
 *   - 但手动调用 runFirstSyncIfNeeded 后 vaultId 没变
 * 因此问题一定落在「选哪个仓库」这一步：
 *   vaultRegistry.listSorted().find(e => remoteIds.has(e.vaultId) && e.status === 'active')
 * 把 registry 的每个条目、状态、以及 syncState 的错误信息全部打出来。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9481;
const REL = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const SHELL = process.argv[2] || 'qt';
const MAP = {
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
};
const cfg = MAP[SHELL];
const DIR = path.join(REL, cfg.dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  for (const n of ['NeoMD.exe', 'NeoMD.WinUI3.exe', 'neomd_flutter.exe', 'chrome.exe']) {
    try {
      execSync(`taskkill /F /IM "${n}" /T`, { stdio: 'ignore' });
    } catch {}
  }
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) return JSON.stringify({ __exception: ex.text + ' ' + (ex.exception?.description || '') });
    return r.result?.result?.value;
  }
}

killAll();
await sleep(2000);
fs.rmSync(path.join(DIR, 'data', 'boot.json'), { force: true });
spawn(path.join(DIR, cfg.exe), cfg.args, { cwd: DIR, stdio: 'ignore' });
let port = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  try {
    const b = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8'));
    port = Number(/:(\d+)\//.exec(b.url)[1]);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) break;
  } catch {}
}
if (!port) throw new Error('壳未就绪');
console.log(`[${SHELL}] 端口 ${port}`);

spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(process.env.TEMP || '.', `cdp-${SHELL}-reg`),
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
    wsUrl = v.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {}
}
const t = await (
  await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, {
    method: 'PUT',
  })
).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(6000);

// 登录
await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({account:'admin',password:'6655',deviceId:'probe-reg-'+Date.now()}) });
  const j = await res.json();
  if (j?.data?.accessToken) {
    localStorage.setItem('neomd.access', j.data.accessToken);
    if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  }
  return 'ok';
})()`);
await cdp.eval('location.reload()');
await sleep(8000);

// 打印 registry 全貌 + 云端清单 + 判定条件
const dump = await cdp.eval(`(async () => {
  const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
  const app = pinia?._s.get('app');
  const auth = pinia?._s.get('auth');
  if (!app) return JSON.stringify({err:'no app'});
  const tok = localStorage.getItem('neomd.access') || '';

  // 云端清单（页面内真实请求）
  let remote = [];
  let remoteErr = null;
  try {
    const r = await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json();
    remote = j?.data?.vaults ?? [];
  } catch (e) { remoteErr = String(e).slice(0,200); }

  // registry 全量条目
  const entries = (app.vaults || []).map(v => ({
    vaultId: v.vaultId, name: v.name, location: v.location, status: v.status,
    available: v.available, orphan: v.orphan, docCount: v.docCount
  }));

  const remoteIds = new Set(remote.map(v => v.vaultId).filter(Boolean));
  const curId = app.vault?.vaultId;
  const docs = app.docs?.length ?? -1;

  // 复算 shouldAdoptRemoteVault 的每个子条件
  const isEmptyUnregisteredLocalVault = !remoteIds.has(curId) && docs === 0;
  const activeWithRemote = (app.vaults || []).filter(e => remoteIds.has(e.vaultId) && e.status === 'active');

  return JSON.stringify({
    curId, docs, remoteCount: remote.length, remoteErr,
    remoteIds: [...remoteIds],
    entries,
    isEmptyUnregisteredLocalVault,
    activeWithRemoteCount: activeWithRemote.length,
    activeWithRemote: activeWithRemote.map(e=>e.vaultId),
    syncState: app.syncState,
    lastSyncSummary: app.lastSyncSummary ?? null,
    syncLogs: (app.syncLogs||[]).slice(-4),
    firstSyncDoneKeys: Object.keys(localStorage).filter(k=>k.startsWith('neomd.firstSyncDone'))
  }, null, 1);
})()`);
console.log('=== registry / conditions ===');
try {
  console.log(JSON.stringify(JSON.parse(dump), null, 1));
} catch {
  console.log(dump);
}

ws.close();
killAll();
process.exit(0);
