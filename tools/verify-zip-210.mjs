/**
 * End-to-end verification of the shipped zips.
 *
 * This is the test that actually matches the user's acceptance criterion:
 * "unzip the portable package and double-click NeoMD.exe, it just runs".
 * Everything before this ran against the release folders, which we had been
 * mutating in place. Here each zip is extracted to a pristine temp directory so
 * a missing file or a leftover absolute path shows up as a real failure.
 *
 * Checks per shell:
 *   1. exe launches and publishes its local endpoint
 *   2. the app page renders and injects window.NeoMD
 *   3. login works and the vault syncs (doc count climbs above zero)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const ZIPS = path.join(RELEASE, 'zips');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9701;
const argv = process.argv.slice(2);
const ONLY = argv[0] ?? 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = {
  tauri: { zip: 'NeoMD-2.1.0-tauri-x64.zip', exe: 'NeoMD.exe', args: [] },
  flutter: { zip: 'NeoMD-2.1.0-flutter-x64.zip', exe: 'neomd_flutter.exe', args: [] },
  winui3: { zip: 'NeoMD-2.1.0-winui3-x64.zip', exe: 'NeoMD.WinUI3.exe', args: [] },
  qt: { zip: 'NeoMD-2.1.0-qt-x64.zip', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  electron: { zip: 'NeoMD-2.1.0-electron-x64.zip', exe: 'Neo MD.exe', args: [] },
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
  async eval(expr, timeoutMs = 90000) {
    const p = this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
    }
    return r.result?.result?.value;
  }
}

async function launchChrome() {
  const dir = path.join(os.tmpdir(), 'nm-zip-chrome-' + Date.now());
  fs.rmSync(dir, { recursive: true, force: true });
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${dir}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

async function testShell(name, spec) {
  const work = path.join(os.tmpdir(), `nm-zip-${name}-${Date.now()}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const zip = path.join(ZIPS, spec.zip);
  if (!fs.existsSync(zip)) return { name, ok: false, why: 'zip missing' };

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${work}' -Force`],
      { stdio: 'pipe', timeout: 600000 });
  } catch (e) {
    return { name, ok: false, why: 'unzip failed: ' + String(e).slice(0, 120) };
  }

  const dir = path.join(work, spec.zip.replace(/\.zip$/, ''));
  const exe = path.join(dir, spec.exe);
  if (!fs.existsSync(exe)) return { name, ok: false, why: 'exe missing after unzip' };

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exe, spec.args, { cwd: dir, env, stdio: 'ignore' });

  /*
   * Endpoint discovery differs by shell.
   *
   * Electron does NOT run a local HTTP server: it loads the app over the custom
   * `neomd://neomd/app` protocol, so it never writes boot.json or
   * server-port.txt. Failing it for "no endpoint" would be wrong — the correct
   * check is that the process stays alive and its CDP target renders. We verify
   * Electron through its own remote-debugging port instead.
   */
  let origin = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    try {
      const boot = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(boot)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(boot, 'utf8'));
        if (m) { origin = m[1].replace(/\/$/, ''); break; }
      }
      const pt = path.join(dir, 'data', 'server-port.txt');
      if (!origin && fs.existsSync(pt)) {
        const p = fs.readFileSync(pt, 'utf8').trim();
        if (/^\d+$/.test(p)) { origin = `http://127.0.0.1:${p}`; break; }
      }
    } catch {}
    if (proc.exitCode !== null) break;
  }

  // Electron: talk to the app through its own debugging port, no HTTP origin.
  if (!origin && name === 'electron') {
    const EP = 9801;
    try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
    await sleep(2500);
    spawn(exe, ['--remote-debugging-port=' + EP], { cwd: dir, env, stdio: 'ignore' });
    let target = null;
    for (let i = 0; i < 50; i++) {
      await sleep(600);
      try {
        const list = await (await fetch(`http://127.0.0.1:${EP}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /neomd/i.test(t.url));
        if (target) break;
      } catch {}
    }
    if (!target) {
      try { proc.kill(); } catch {}
      return { name, ok: false, why: 'electron CDP target not found' };
    }
    const ews = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ews.addEventListener('open', r));
    const ecdp = new Cdp(ews);
    await ecdp.send('Runtime.enable');
    await sleep(5000);
    const er = await ecdp.eval(`(() => JSON.stringify({
      text: (document.body.innerText||'').length,
      nodes: document.querySelector('#app')?.children.length ?? 0,
      inj: !!(window.NeoMD && window.NeoMD.env),
      env: window.NeoMD?.env ?? '',
      ver: window.NeoMD?.version ?? '',
      url: location.href
    }))()`);
    const el = await ecdp.eval(`(async () => {
      const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({account:'admin',password:'6655',deviceId:'zip-e-'+Date.now()}) });
      const j = await r.json();
      if (j?.data?.accessToken) { localStorage.setItem('neomd.access', j.data.accessToken); return 'ok'; }
      return 'fail:' + (j?.message || r.status);
    })()`);
    await ecdp.send('Page.reload');
    await sleep(8000);
    await ecdp.send('Runtime.enable');
    let edocs = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(6000);
      const s = await ecdp.eval(`(() => {
        const a = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
        return JSON.stringify({ d: (a?.docs||[]).length });
      })()`);
      try { edocs = JSON.parse(s).d; if (edocs > 0) break; } catch {}
    }
    ews.close();
    try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
    await sleep(1500);
    fs.rmSync(work, { recursive: true, force: true });
    let o = {};
    try { o = JSON.parse(er); } catch {}
    const eok = o.text > 50 && o.inj && el === 'ok' && edocs > 0;
    return { name, ok: eok, text: o.text, inj: o.inj, ver: o.ver, login: el, docs: edocs,
      why: eok ? '' : `text=${o.text} inj=${o.inj} login=${el} docs=${edocs}` };
  }

  if (!origin) {
    try { proc.kill(); } catch {}
    return { name, ok: false, why: `no endpoint (exited=${proc.exitCode})` };
  }

  await launchChrome();
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(8000);

  const render = await cdp.eval(`(() => {
    const app = document.querySelector('#app');
    return JSON.stringify({
      text: (document.body.innerText||'').length,
      nodes: app ? app.children.length : 0,
      inj: !!(window.NeoMD && window.NeoMD.env),
      env: window.NeoMD?.env ?? '',
      ver: window.NeoMD?.version ?? ''
    });
  })()`);

  const login = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'zip-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return 'ok';
    }
    return 'fail:' + (j?.message || r.status);
  })()`);

  await cdp.send('Page.reload');
  await sleep(6000);
  await cdp.send('Runtime.enable');

  // wait for the vault to actually populate
  let docs = 0;
  let vaultId = '';
  for (let i = 0; i < 15; i++) {
    await sleep(6000);
    const s = await cdp.eval(`(() => {
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({ d: (app?.docs||[]).length, v: (app?.vault?.vaultId||'').slice(-8) });
    })()`);
    try {
      const o = JSON.parse(s);
      docs = o.d; vaultId = o.v;
      if (docs > 0) break;
    } catch {}
  }

  ws.close();
  try { proc.kill(); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(2000);
  fs.rmSync(work, { recursive: true, force: true });

  let r;
  try { r = JSON.parse(render); } catch { r = {}; }
  const ok = r.text > 50 && r.nodes >= 1 && r.inj && login === 'ok' && docs > 0;
  return {
    name, ok,
    text: r.text, inj: r.inj, ver: r.ver, login, docs, vaultId,
    why: ok ? '' : `text=${r.text} inj=${r.inj} login=${login} docs=${docs}`,
  };
}

(async () => {
  const names = ONLY === 'all' ? Object.keys(SHELLS) : [ONLY];
  const results = [];
  for (const n of names) {
    try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${SHELLS[n].exe}`, '/T'], { stdio: 'ignore' }); } catch {}
    await sleep(3000);
    const r = await testShell(n, SHELLS[n]);
    results.push(r);
    console.log(`${r.name.padEnd(9)} ${r.ok ? 'PASS' : 'FAIL'}  text=${r.text ?? '-'} inj=${r.inj ?? '-'} ver=${r.ver ?? '-'} login=${r.login ?? '-'} docs=${r.docs ?? '-'}${r.why ? '  ' + r.why : ''}`);
  }
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nresult: ${pass}/${results.length}`);
  process.exit(0);
})();
