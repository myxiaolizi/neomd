#!/usr/bin/env node
/**
 * Qt 版 /api/vaults 返回 0 的定向诊断。
 *
 * 直连 PowerShell 打同一接口能拿到 5 个仓库，
 * 但页面内 fetch 拿到 0 个 —— 必须把页面里实际发出的请求
 * 与响应体都打出来，才能定位是头部差异还是响应解析差异。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9477;
const DIR = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0\\NeoMD-2.1.0-qt-x64';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  for (const n of ['NeoMD.exe', 'chrome.exe']) {
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
    return r.result?.result?.value;
  }
}

killAll();
await sleep(2000);

// 起壳
fs.rmSync(path.join(DIR, 'data', 'boot.json'), { force: true });
const shell = spawn(path.join(DIR, 'NeoMD.exe'), ['--no-sandbox'], { cwd: DIR, stdio: 'ignore' });
let port = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  try {
    const b = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8'));
    port = Number(/:(\d+)\//.exec(b.url)[1]);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) break;
  } catch {}
}
if (!port) throw new Error('壳未就绪');
console.log('壳端口', port);

// 起 Chrome 连同一个本地服务
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(process.env.TEMP || '.', 'cdp-qt-probe'),
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
await sleep(7000);

// 1) 页面内登录并打印完整响应
const r = await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({account:'admin',password:'6655',deviceId:'cdp-qt-probe'})
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (j?.data?.accessToken) {
    localStorage.setItem('neomd.access', j.data.accessToken);
    if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  }
  return JSON.stringify({ status: res.status, hasToken: !!j?.data?.accessToken, head: text.slice(0,300) });
})()`);
console.log('login:', r);

// 2) 页面内 /api/vaults：完整响应体
const v = await cdp.eval(`(async () => {
  const tok = localStorage.getItem('neomd.access') || '';
  const res = await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const vaults = j?.data?.vaults;
  return JSON.stringify({
    status: res.status,
    ok: res.ok,
    isArray: Array.isArray(vaults),
    count: Array.isArray(vaults) ? vaults.length : -1,
    keys: j && typeof j === 'object' ? Object.keys(j) : [],
    dataKeys: j?.data && typeof j.data === 'object' ? Object.keys(j.data) : [],
    head: text.slice(0, 400)
  });
})()`);
console.log('vaults:', v);

// 3) 对比：同一 token 用绝对地址直连上游（绕过壳代理）
const v2 = await cdp.eval(`(async () => {
  const tok = localStorage.getItem('neomd.access') || '';
  try {
    const res = await fetch('https://md.zhengl.vip/api/vaults', { headers: { authorization: 'Bearer ' + tok } });
    const j = await res.json();
    return JSON.stringify({ status: res.status, count: j?.data?.vaults?.length ?? -1 });
  } catch (e) { return JSON.stringify({ err: String(e).slice(0,200) }); }
})()`);
console.log('vaults-direct-upstream:', v2);

// 4) 壳代理健康：非鉴权接口
const v3 = await cdp.eval(`(async () => {
  const res = await fetch('/api/health').catch(()=>null);
  return JSON.stringify({ status: res ? res.status : -1 });
})()`);
console.log('health:', v3);

ws.close();
killAll();
process.exit(0);
