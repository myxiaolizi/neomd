#!/usr/bin/env node
/** 单壳深度诊断：启动壳 + CDP 连入，dump 真实 DOM 状态，用于定位白屏/骨架缺失 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.0.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9466;
const SHELLS = {
  tauri: { dir: 'NeoMD-2.0.0-tauri-x64', exe: 'NeoMD.exe' },
  qt: { dir: 'NeoMD-2.0.0-qt-x64', exe: 'NeoMD.exe' },
  winui3: { dir: 'NeoMD-2.0.0-winui3-x64', exe: 'NeoMD.WinUI3.exe' },
  flutter: { dir: 'NeoMD-2.0.0-flutter-x64', exe: 'neomd_flutter.exe' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = process.argv[2] ?? 'tauri';
const shell = SHELLS[name];

function kill(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {}
}
function ports(pid) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 1 << 25 });
    const s = new Set();
    for (const l of out.split(/\r?\n/)) {
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
function bootPort(dir) {
  try {
    const m = /:(\d+)\//.exec(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'boot.json'), 'utf8')).url);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
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
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); j(new Error('timeout ' + method)); } }, 40000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
}

const dir = path.join(RELEASE, shell.dir);
const exe = path.join(dir, shell.exe);
kill(shell.exe);
await sleep(1500);
try { fs.rmSync(path.join(dir, 'data', 'boot.json'), { force: true }); } catch {}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(exe, [], { cwd: dir, env, stdio: 'ignore' });
let port = null;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  const c = new Set(ports(proc.pid)); const b = bootPort(dir); if (b) c.add(b);
  for (const p of c) { try { const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(4000) }); if (r.ok && /<html/i.test(await r.text())) { port = p; break; } } catch {} }
  if (port) break;
}
console.log('shell port =', port);

const ud = path.join(process.cwd(), '.tmp-cdp-dbg');
fs.rmSync(ud, { recursive: true, force: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ud}`, '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {} }
console.log('chrome ws =', !!wsUrl);

const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' })).json();
const cdp = await CDP.attach(t.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

for (const wait of [1500, 3000, 5000, 8000]) {
  await sleep(wait);
  const snap = await cdp.eval(`JSON.stringify({
    t: Math.round(performance.now()),
    readyState: document.readyState,
    path: location.pathname,
    title: document.title,
    bodyLen: (document.body.innerText||'').trim().length,
    bodyHead: (document.body.innerText||'').trim().slice(0,300),
    appHTML: (document.querySelector('#app')?.innerHTML||'').slice(0,400),
    topClasses: [...document.querySelectorAll('#app > *')].map(e=>e.className).slice(0,10),
    sidebar: !!document.querySelector('[class*="sidebar"],[class*="leftpanel"],[class*="sidebar"]'),
    editor: !!document.querySelector('.ProseMirror, [class*="editor"],[class*="wysiwyg"], textarea'),
    tabbar: !!document.querySelector('[class*="tabbar"],[class*="tabs"]'),
    hasNeoMD: !!window.NeoMD
  })`);
  console.log('\n--- after wait', wait, '---');
  console.log(snap);
}

const fails = cdp.events.filter(e => e.method === 'Network.loadingFailed');
const resp = cdp.events.filter(e => e.method === 'Network.responseReceived');
console.log('\n=== failed requests ===');
for (const f of fails.slice(0, 20)) console.log(f.params.errorText, f.params.type);
console.log('\n=== non-200 responses ===');
for (const r of resp.slice(0, 60)) { if (r.params.response.status >= 400) console.log(r.params.response.status, r.params.response.url.slice(0, 140)); }
const exc = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
console.log('\n=== exceptions ===');
for (const e of exc.slice(0, 10)) console.log(JSON.stringify(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text).slice(0, 400));

try { chrome.kill(); execSync(`taskkill /F /PID ${chrome.pid} /T`, { stdio: 'ignore' }); } catch {}
try { proc.kill(); } catch {}
kill(shell.exe);
process.exit(0);
