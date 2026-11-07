#!/usr/bin/env node
/**
 * 定向诊断：为什么 Qt / Flutter 版登录后 store 里 docs 仍为 0。
 *
 * 四个壳托管的是同一份 web 产物，Tauri/WinUI3 能同步、Qt/Flutter 不能，
 * 差异只可能来自「运行时状态」（localStorage / 首拉时序 / 仓库登记）。
 * 本脚本把 store 的仓库、registry、首拉标记全部打出来，
 * 并手动触发一次 runFirstSyncIfNeeded 观察返回值。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9479;
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
    if (ex) return { __exception: ex.text + ' ' + (ex.exception?.description || '') };
    return r.result?.result?.value;
  }
}

killAll();
await sleep(2000);

fs.rmSync(path.join(DIR, 'data', 'boot.json'), { force: true });
const shell = spawn(path.join(DIR, cfg.exe), cfg.args, { cwd: DIR, stdio: 'ignore' });
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

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(process.env.TEMP || '.', `cdp-${SHELL}-probe`),
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

const helpers = `
  const getApp = () => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
  const getAuth = () => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('auth');
`;

// 登录并 reload
const login = await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({account:'admin',password:'6655',deviceId:'probe-'+Date.now()})
  });
  const j = await res.json();
  if (!j?.data?.accessToken) return JSON.stringify({ok:false,status:res.status});
  localStorage.setItem('neomd.access', j.data.accessToken);
  if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  return JSON.stringify({ok:true});
})()`);
console.log('login:', login);

await cdp.eval('location.reload()');
await sleep(6000);

// 观察 60s，每 5s 打一次关键状态
for (let i = 0; i < 13; i++) {
  const snap = await cdp.eval(`(async () => { ${helpers}
    const app = getApp();
    const auth = getAuth();
    const txt = (document.body.innerText||'');
    const ls = {};
    for (let k=0;k<localStorage.length;k++){const key=localStorage.key(k); if(key && key.startsWith('neomd.')) ls[key]=String(localStorage.getItem(key)).slice(0,40);}
    return JSON.stringify({
      t: ${i}*5,
      hasApp: !!app,
      docs: app?.docs?.length ?? -1,
      vaults: app?.vaults?.length ?? -1,
      vaultId: app?.vault?.vaultId ?? null,
      vaultName: app?.vaultName ?? null,
      vaultLocation: app?.vaultLocation ?? null,
      loggedIn: auth?.isLoggedIn ?? null,
      userName: auth?.user?.username ?? null,
      syncState: app?.syncState ?? null,
      bodyLen: txt.trim().length,
      emptyHint: txt.includes('仓库还是空的'),
      lsKeys: Object.keys(ls)
    });
  })()`);
  console.log(`${String(i * 5).padStart(3)}s`, typeof snap === 'string' ? snap : JSON.stringify(snap));
  await sleep(5000);
}

// 手动触发首拉并观察
const manual = await cdp.eval(`(async () => { ${helpers}
  const app = getApp();
  if (!app) return JSON.stringify({err:'no app'});
  const out = { before: app.docs?.length ?? -1, vaultId: app.vault?.vaultId };
  try {
    out.ran = await app.runFirstSyncIfNeeded();
  } catch (e) { out.err = String(e).slice(0,300); }
  out.after = app.docs?.length ?? -1;
  out.vaultIdAfter = app.vault?.vaultId;
  return JSON.stringify(out);
})()`);
console.log('manual runFirstSyncIfNeeded:', manual);

await sleep(8000);
const final = await cdp.eval(`(async () => { ${helpers}
  const app = getApp();
  return JSON.stringify({ docs: app?.docs?.length ?? -1, vaultId: app?.vault?.vaultId, empty: (document.body.innerText||'').includes('仓库还是空的') });
})()`);
console.log('final:', final);

ws.close();
killAll();
process.exit(0);
