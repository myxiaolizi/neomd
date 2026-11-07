/**
 * Why does a save sometimes push 0 files?
 *
 * Seen on Tauri 2.2.0: append a marker, save, wait for sync to go idle — the
 * summary says "推送 0 篇，跳过 1355 篇" and the marker never reaches the cloud.
 * So saveActiveTab wrote something that the sync engine then decided not to push.
 *
 * The push gate in sync-engine.ts skips a doc when
 *   r.hash === l.hash          (already identical)
 *   l.rev === l.syncedRev      (no local change since last sync)
 * Both depend on the *index* entry keeping up with the *file*. If the file was
 * rewritten but the index still carries the old hash/rev, the engine wrongly
 * concludes "nothing changed" and silently pushes nothing.
 *
 * This probe measures index-vs-file consistency right after a save:
 *   before save : rev / syncedRev / hash / size
 *   after save  : same fields, plus whether the on-disk text actually contains the marker
 *   after sync  : same fields again + whether the cloud object carries the marker
 *
 * Run: node tools/probe-save-push.mjs 2.2.0 tauri
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'tauri';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9657 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9658;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.wait.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, timeoutMs = 300000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0,400) });
    return r.result?.result?.value;
  }
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { ws, cdp };
}

(async () => {
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args, { cwd: dir, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    try {
      const b = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(b)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(b, 'utf8'));
        if (m) { origin = m[1].replace(/\/$/, ''); break; }
      }
    } catch {}
  }
  console.log(`shell=${SHELL} origin=${origin}`);

  let cdp = null, ws = null;
  if (spec.dbg) {
    for (let i = 0; i < 30; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${spec.dbg}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { ({ ws, cdp } = await connect(page.webSocketDebuggerUrl)); break; }
      } catch {}
      await sleep(700);
    }
  }
  if (!cdp) {
    const cd = path.join(process.cwd(), `.tmp-savepush-${SHELL}`);
    fs.rmSync(cd, { recursive: true, force: true });
    spawn(CHROME, ['--remote-debugging-port=' + CDP_PORT, `--user-data-dir=${cd}`, '--headless=new',
      '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {} }
    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
    ({ ws, cdp } = await connect(t.webSocketDebuggerUrl));
  }
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'savepush-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(18000);
  await cdp.send('Runtime.enable');

  const result = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const out = { steps: [] };

    // wait for the startup sync to settle
    for (let i = 0; i < 90; i++) { if (app.syncState === 'idle') break; await sleep(2000); }
    for (let i = 0; i < 60; i++) { if ((app.docs||[]).length) break; await sleep(2000); }

    const doc = (app.docs||[])[0];
    if (!doc) return JSON.stringify({ ok:false, why:'no docs' });
    out.docId = doc.docId; out.title = doc.title;

    const snap = (label) => {
      const d = (app.docs||[]).find(x => x.docId === doc.docId) || {};
      const tab = app.tabs?.find(t => t.id === app.activeTabId);
      return {
        label,
        rev: d.rev ?? null,
        syncedRev: d.syncedRev ?? null,
        hash: typeof d.hash === 'string' ? d.hash.slice(0, 16) : d.hash,
        size: d.size ?? null,
        dirty: tab?.dirty ?? null,
        syncState: app.syncState,
      };
    };

    await app.openDoc(doc.docId);
    await sleep(2500);
    out.steps.push(snap('afterOpen'));

    const stamp = 'SAVEPUSH-' + Date.now();
    out.stamp = stamp;
    const tab = app.tabs?.find(t => t.id === app.activeTabId);
    const before = tab?.content ?? '';
    await app.updateTabContent(app.activeTabId, before + '\\n\\n' + stamp);
    await sleep(900);
    out.steps.push(snap('afterEdit_beforeSave'));

    await app.saveActiveTab();
    await sleep(1500);
    out.steps.push(snap('afterSave'));

    // does the file on disk really carry the marker?
    try {
      const txt = await app.readDocContent?.(doc.docId);
      out.diskHasStamp = typeof txt === 'string' ? txt.indexOf(stamp) >= 0 : null;
      out.diskLen = typeof txt === 'string' ? txt.length : null;
    } catch (e) { out.diskErr = String(e).slice(0,200); }

    // wait for sync to settle
    for (let i = 0; i < 120; i++) { if (app.syncState === 'idle') break; await sleep(2000); }
    out.steps.push(snap('afterSyncIdle'));
    out.summary = app.lastSyncSummary ?? null;

    // cloud check
    const tok = localStorage.getItem('neomd.access') || '';
    const vaultId = app.vault?.vaultId;
    const pre = 'vaults/' + vaultId + '/docs/' + doc.docId + '/';
    const lr = await fetch('/api/storage/list?prefix=' + encodeURIComponent(pre), { headers: { authorization: 'Bearer ' + tok } });
    const lj = await lr.json().catch(()=>({}));
    const keys = ((lj && lj.data && lj.data.objects) || []).map(o => o.key || o.Key).filter(Boolean);
    keys.sort().reverse();
    out.cloudObjectCount = keys.length;
    out.cloudKeys = keys.slice(0, 4);
    for (const k of keys.slice(0, 5)) {
      const rr = await fetch('/api/storage/object?key=' + encodeURIComponent(k), { headers: { authorization: 'Bearer ' + tok } });
      const tx = await rr.text();
      if (tx.indexOf(stamp) >= 0) { out.cloudHasStamp = true; out.cloudStampKey = k; break; }
    }
    if (out.cloudHasStamp !== true) out.cloudHasStamp = false;

    return JSON.stringify(out);
  })()`, 600000);

  console.log('\n=== save-push trace ===');
  try {
    const o = JSON.parse(result);
    console.log(JSON.stringify(o, null, 2));
  } catch {
    console.log(result);
  }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
