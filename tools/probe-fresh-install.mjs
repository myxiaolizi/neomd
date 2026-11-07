#!/usr/bin/env node
/**
 * 诊断：全新桌面实例里那 1 篇「文档」到底是什么。
 *
 * 目的是判断 isEmptyShellVault 的阈值该用 0 还是「少量」：
 * 若这 1 篇是程序自动生成的欢迎页/占位文档，则它不该阻止采纳云端仓库。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9483;
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
const killAll = () => {
  for (const n of ['NeoMD.exe', 'NeoMD.WinUI3.exe', 'neomd_flutter.exe', 'chrome.exe']) {
    try {
      execSync(`taskkill /F /IM "${n}" /T`, { stdio: 'ignore' });
    } catch {}
  }
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) return JSON.stringify({ __exception: ex.text });
    return r.result?.result?.value;
  }
}

killAll();
await sleep(2000);
// 完全重置数据目录，模拟真实首次安装
fs.rmSync(path.join(DIR, 'data'), { recursive: true, force: true });
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
console.log(`[${SHELL}] 全新实例端口 ${port}`);

spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(process.env.TEMP || '.', `cdp-${SHELL}-welcome`),
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

const before = await cdp.eval(`(async () => {
  const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
  return JSON.stringify({
    docs: (app?.docs||[]).map(d=>({id:d.id,title:d.title,size:d.size})),
    vaultId: app?.vault?.vaultId,
    vaultName: app?.vaultName,
    vaultLocation: app?.vaultLocation
  });
})()`);
console.log('登录前:', before);

await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({account:'admin',password:'6655',deviceId:'fresh-'+Date.now()}) });
  const j = await res.json();
  if (j?.data?.accessToken) {
    localStorage.setItem('neomd.access', j.data.accessToken);
    if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  }
  return 'ok';
})()`);
await cdp.eval('location.reload()');

for (let i = 0; i < 14; i++) {
  await sleep(5000);
  const s = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    return JSON.stringify({
      docs: (app?.docs||[]).length,
      titles: (app?.docs||[]).slice(0,3).map(d=>d.title),
      vaultId: app?.vault?.vaultId,
      vaultName: app?.vaultName,
      syncState: app?.syncState,
      empty: (document.body.innerText||'').includes('仓库还是空的')
    });
  })()`);
  console.log(`${(i + 1) * 5}s`, s);
}

ws.close();
killAll();
process.exit(0);
