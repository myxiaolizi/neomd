#!/usr/bin/env node
/**
 * 决定性验证：登录后「打开云端已有仓库」，702 篇文档是否会真正落地到本地。
 *
 * 这一步用于区分两类根因：
 *   A) 同步引擎坏了（即使打开云端仓库也拉不到）
 *   B) 登录后没有自动切到云端仓库（用户看到的是空的本地默认仓库）
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.0.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9488;
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
    return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + m)); } }, 180000); });
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

const ud = path.join(process.cwd(), '.tmp-open-profile');
fs.rmSync(ud, { recursive: true, force: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ud}`, '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {} }

const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json();
const cdp = await CDP.attach(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(4000);

// 登录
await cdp.eval(`(async () => {
  const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ account:'admin', password:'6655', deviceId:'open-'+Date.now() }) });
  const j = await res.json();
  localStorage.setItem('neomd.access', j.data.accessToken);
  if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
  return 'ok';
})()`);
await cdp.eval('location.reload()');
await sleep(7000);

// 看注册表条目
console.log('\n=== 登录后注册表条目 ===');
console.log(await cdp.eval(`(async () => {
  const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
  const app = pinia._s.get('app');
  const out = { currentVault: app.vault ? { id: app.vault.vaultId, name: app.vault.name, location: app.vault.location } : null, docs: app.docs?.length };
  try { out.list = app.vaultList?.map(v => ({ id: v.vaultId, name: v.name, location: v.location, current: v.current })); } catch(e) { out.listErr = String(e); }
  return JSON.stringify(out, null, 1);
})()`));

// 关键：打开云端仓库（用 vaultId 或 cloud: 位置）
console.log('\n=== 尝试打开云端仓库 笔记本 / vaultmvuqt3rn8ubd9num ===');
console.log(await cdp.eval(`(async () => {
  const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
  const app = pinia._s.get('app');
  const results = [];
  const tries = ['vaultmvuqt3rn8ubd9num', 'cloud:vaultmvuqt3rn8ubd9num', 'cloud:admin'];
  for (const loc of tries) {
    try {
      const t0 = Date.now();
      await app.openVault(loc, '笔记本');
      results.push({ loc, ok: true, ms: Date.now()-t0, docs: app.docs?.length, vault: app.vault?.name, vaultId: app.vault?.vaultId });
    } catch(e) { results.push({ loc, ok:false, err: String(e).slice(0,200) }); }
  }
  return JSON.stringify({ results, finalDocs: app.docs?.length }, null, 1);
})()`));

await sleep(3000);
console.log('\n=== 打开后的 DOM ===');
console.log(await cdp.eval(`JSON.stringify({
  emptyVault: document.body.innerText.includes('仓库还是空的'),
  bodyLen: (document.body.innerText||'').trim().length,
  head: (document.body.innerText||'').trim().slice(0,400)
}, null, 1)`));

// 再跑一次同步
console.log('\n=== 打开云端仓库后 syncAllVaults ===');
console.log(await cdp.eval(`(async () => {
  const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
  const app = pinia._s.get('app');
  try { const r = await app.syncAllVaults({ silent: true }); return JSON.stringify({ r, docs: app.docs?.length }); }
  catch(e) { return JSON.stringify({ err: String(e).slice(0,300) }); }
})()`));

await sleep(2000);
console.log('\n=== 同步后 DOM ===');
console.log(await cdp.eval(`JSON.stringify({
  emptyVault: document.body.innerText.includes('仓库还是空的'),
  bodyLen: (document.body.innerText||'').trim().length,
  head: (document.body.innerText||'').trim().slice(0,500)
}, null, 1)`));

try { chrome.kill(); execSync(`taskkill /F /PID ${chrome.pid} /T`, { stdio:'ignore' }); } catch {}
try { proc.kill(); } catch {}
kill('NeoMD.exe');
process.exit(0);
