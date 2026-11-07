#!/usr/bin/env node
/**
 * 登录后「仓库同步」全链路探针。
 *
 * 目标：区分三种可能的失败点
 *   A) 登录后未自动 pull 仓库清单        → 左侧看不到云端仓库
 *   B) pull 了清单但未拉取文档内容        → 看到仓库名但「仓库还是空的」
 *   C) 拉取了但渲染层没更新              → store 有数据但 UI 空
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.0.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9477;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kill(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {}
}
function ports(pid) {
  try {
    const o = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 1 << 25 });
    const s = new Set();
    for (const l of o.split(/\r?\n/)) {
      if (!/LISTENING/i.test(l)) continue;
      const f = l.trim().split(/\s+/);
      if (f.length < 5 || Number(f[4]) !== pid) continue;
      const p = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
      if (p) s.add(p);
    }
    return [...s];
  } catch {
    return [];
  }
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && this.p.has(m.id)) { const { r, j } = this.p.get(m.id); this.p.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); }
      else if (m.method) this.events.push(m);
    });
  }
  static async attach(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    return new CDP(ws);
  }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + m)); } }, 120000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
}

const dir = path.join(RELEASE, 'NeoMD-2.0.0-tauri-x64');
const exe = path.join(dir, 'NeoMD.exe');
kill('NeoMD.exe');
await sleep(1500);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(exe, [], { cwd: dir, env, stdio: 'ignore' });
let port = null;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  for (const p of ports(proc.pid)) { try { const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(4000) }); if (r.ok && /<html/i.test(await r.text())) { port = p; break; } } catch {} }
  if (port) break;
}
console.log('shell port =', port);

const ud = path.join(process.cwd(), '.tmp-probe-profile');
fs.rmSync(ud, { recursive: true, force: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ud}`, '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsV = null;
for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { wsV = (await r.json()).webSocketDebuggerUrl; break; } } catch {} }

const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json();
const cdp = await CDP.attach(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

await sleep(4000);
console.log('\n=== 初始状态 ===');
console.log(await cdp.eval(`JSON.stringify({ path: location.pathname, bodyLen: (document.body.innerText||'').trim().length })`));

// 登录
console.log('\n=== 执行登录 ===');
console.log(await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ account:'admin', password:'6655', deviceId:'probe-'+Date.now() }) });
  const j = await res.json();
  localStorage.setItem('neomd.access', j.data.accessToken);
  if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  return JSON.stringify({ status: res.status, token: j.data.accessToken.slice(0,12)+'...' });
})()`));

await cdp.eval('location.reload()');
await sleep(7000);

console.log('\n=== 登录后状态 ===');
console.log(await cdp.eval(`JSON.stringify({
  bodyLen: (document.body.innerText||'').trim().length,
  head: (document.body.innerText||'').trim().slice(0,400),
  notLogged: document.body.innerText.includes('未登录'),
  emptyVault: document.body.innerText.includes('仓库还是空的'),
  vaultName: [...document.querySelectorAll('[class*="vault"]')].map(e=>e.textContent.trim()).slice(0,6)
}, null, 1)`));

// 检查 Pinia store 里的真实状态
console.log('\n=== store 层真实状态（通过 __pinia / devtools 不可用则用 DOM 推断）===');
console.log(await cdp.eval(`(async () => {
  // 尝试读取 vue app 实例上的 store
  const appEl = document.querySelector('#app');
  const vm = appEl?.__vue_app__;
  if (!vm) return JSON.stringify({ note: 'no __vue_app__' });
  const pinia = vm.config.globalProperties.$pinia;
  if (!pinia) return JSON.stringify({ note: 'no pinia' });
  const st = pinia.state.value;
  const out = {};
  for (const k of Object.keys(st)) {
    const s = st[k];
    out[k] = { docs: s?.docs?.length ?? null, vaults: s?.vaults?.length ?? null, vault: s?.vault?.name ?? null };
  }
  return JSON.stringify(out, null, 1);
})()`));

// 手动触发同步，看是否能把 702 篇拉下来
console.log('\n=== 手动触发 syncAllVaults / 打开云端仓库 ===');
console.log(await cdp.eval(`(async () => {
  const vm = document.querySelector('#app')?.__vue_app__;
  const pinia = vm?.config.globalProperties.$pinia;
  if (!pinia) return JSON.stringify({ note:'no pinia' });
  const app = pinia._s.get('app');
  if (!app) return JSON.stringify({ note:'no app store', keys:[...pinia._s.keys()] });
  const before = { docs: app.docs?.length ?? null, vaults: app.vaults?.length ?? null };
  let syncRes = null, err = null;
  try { syncRes = await app.syncAllVaults({ silent: true }); } catch(e) { err = String(e).slice(0,300); }
  return JSON.stringify({ before, after: { docs: app.docs?.length ?? null, vaults: app.vaults?.length ?? null }, syncRes, err }, null, 1);
})()`));

await sleep(2000);
console.log('\n=== 同步后 DOM ===');
console.log(await cdp.eval(`JSON.stringify({
  emptyVault: document.body.innerText.includes('仓库还是空的'),
  bodyLen: (document.body.innerText||'').trim().length,
  head: (document.body.innerText||'').trim().slice(0,300)
}, null, 1)`));

const fails = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
console.log('\n=== 异常 ===');
for (const e of fails.slice(0, 8)) console.log(String(e.params.exceptionDetails?.exception?.description).slice(0, 400));

try { chrome.kill(); execSync(`taskkill /F /PID ${chrome.pid} /T`, { stdio:'ignore' }); } catch {}
try { proc.kill(); } catch {}
kill('NeoMD.exe');
process.exit(0);
