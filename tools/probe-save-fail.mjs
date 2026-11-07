#!/usr/bin/env node
/**
 * 诊断：Qt/Flutter 同步成功后，「保存」与 `/api/storage/list` 报 Failed to fetch。
 *
 * 假设：文档规模上来后（500+ 篇），上传用的是 PUT + 较大 body，
 * 或是 presign 之后直传 OSS 的地址在代理下不可达。
 * 本脚本把保存过程中的真实请求/响应都打出来。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9485;
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
    if (ex) return JSON.stringify({ __exception: ex.text + ' ' + (ex.exception?.description || '') });
    return r.result?.result?.value;
  }
}

killAll();
await sleep(2000);
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
    '--user-data-dir=' + path.join(process.env.TEMP || '.', `cdp-${SHELL}-save`),
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
await cdp.send('Network.enable');
// 关键：新建的 target 初始在 about:blank，localStorage 不可用。
// 必须先显式导航到壳的 origin，等页面真正加载后再操作。
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
await sleep(8000);

// 登录
await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({account:'admin',password:'6655',deviceId:'save-'+Date.now()}) });
  const j = await res.json();
  if (j?.data?.accessToken) {
    localStorage.setItem('neomd.access', j.data.accessToken);
    if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  }
  return 'ok';
})()`);
await cdp.eval('location.reload()');
await sleep(30000);

// 等首拉完成
for (let i = 0; i < 20; i++) {
  const s = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    return JSON.stringify({ docs:(app?.docs||[]).length, syncState: app?.syncState });
  })()`);
  const o = JSON.parse(s);
  if (o.syncState === 'idle' && o.docs > 0) { console.log('首拉完成', s); break; }
  await sleep(5000);
}

// 直接用 fetch 打这些接口，逐个看真实状态
const probes = await cdp.eval(`(async () => {
  const tok = localStorage.getItem('neomd.access') || '';
  const H = { authorization: 'Bearer ' + tok };
  const out = {};
  const hit = async (name, url, opts) => {
    try {
      const r = await fetch(url, opts);
      const txt = await r.text();
      out[name] = { status: r.status, len: txt.length, head: txt.slice(0,160) };
    } catch (e) { out[name] = { err: String(e).slice(0,200) }; }
  };
  await hit('storageList', '/api/storage/list?prefix=versions%2F&limit=5', { headers: H });
  await hit('storageListVault', '/api/storage/list?prefix=' + encodeURIComponent('vaults/') + '&limit=5', { headers: H });
  await hit('presign', '/api/storage/presign', { method:'POST', headers: {...H, 'content-type':'application/json'},
    body: JSON.stringify({ key: 'vaults/test/probe.txt', contentType:'text/plain' }) });
  await hit('vaults', '/api/vaults', { headers: H });
  return JSON.stringify(out, null, 1);
})()`);
console.log('=== api probes ===');
console.log(probes);

// 触发一次保存，抓 Network 失败
const saveResult = await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
  if (!app) return JSON.stringify({err:'no app'});
  const docs = app.docs || [];
  if (!docs.length) return JSON.stringify({err:'no docs'});
  const first = docs[0];
  await app.openDoc(first.id);
  await sleep(2500);
  const tabId = app.activeTabId;
  const tab = app.tabs?.find(t=>t.id===tabId);
  const stamp = 'SAVEPROBE-' + Date.now();
  try {
    await app.updateTabContent(tabId, (tab?.content ?? '') + '\\n\\n' + stamp);
    await sleep(600);
    await app.saveActiveTab();
    await sleep(3000);
    return JSON.stringify({ ok:true, doc:first.title, tabId, stamp, dirty: app.isDirty, summary: app.lastSyncSummary });
  } catch (e) { return JSON.stringify({ ok:false, err: String(e).slice(0,400), doc:first.title, stamp }); }
})()`);
console.log('=== save attempt ===');
console.log(saveResult);

ws.close();
killAll();
process.exit(0);
