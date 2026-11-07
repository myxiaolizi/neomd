/**
 * Inspect the exact push-gate variables for one doc after a save.
 *
 * sync-engine.ts decides "do not push" at line ~363:
 *     if (l.rev === (l.syncedRev ?? -1)) continue;
 * and before that, "already identical" at line ~359:
 *     if (r.hash === l.hash) { markSynced(...); continue; }
 *
 * After a save the cloud rev does not advance, so one of these must be firing
 * with unexpected values. This probe reads the real numbers from the live vault
 * (rev, hash, syncedRev) and the real remote manifest entry (rev, hash) for the
 * same docId, so we can tell exactly which condition swallowed the push.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = {
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
};
const name = process.argv[2] ?? 'qt';
const spec = SHELLS[name];
const dir = path.join(RELEASE, spec.dir);

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
  async eval(expr, timeoutMs = 180000) {
    const p = this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
    }
    return r.result?.result?.value;
  }
}

(async () => {
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(3000);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args, { cwd: dir, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 55; i++) {
    await sleep(700);
    try {
      const b = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(b)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(b, 'utf8'));
        if (m) { origin = m[1].replace(/\/$/, ''); break; }
      }
    } catch {}
  }
  console.log('origin =', origin);

  const cd = path.join(process.cwd(), '.tmp-gate');
  fs.rmSync(cd, { recursive: true, force: true });
  spawn(CHROME, ['--remote-debugging-port=9945', `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9945/json/version'); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:9945/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'gate-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) { localStorage.setItem('neomd.access', j.data.accessToken); if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken); }
    return 'ok';
  })()`);
  await cdp.send('Page.reload');
  await sleep(22000);
  await cdp.send('Runtime.enable');

  const marker = 'GATE-' + Date.now();

  // Wait for a truly idle sync, so nothing races.
  for (let i = 0; i < 20; i++) {
    const s = await cdp.eval(`(() => {
      const a = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({ state: a?.syncState, docs: (a?.docs||[]).length });
    })()`);
    let o = {};
    try { o = JSON.parse(s); } catch {}
    if (o.state === 'idle' && o.docs > 0) { console.log('idle at', o.docs); break; }
    await sleep(5000);
  }

  // The gate values BEFORE the edit.
  const gateBefore = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const first = (app?.docs||[])[0];
    const docId = first?.docId ?? first?.id;
    window.__NM_DOCID = docId;
    window.__NM_MARK = ${JSON.stringify(marker)};
    await app.openDoc(docId);
    await new Promise(function (r) { setTimeout(r, 2500); });

    const v = app.vault;
    const localAll = v.listAll ? v.listAll() : [];
    const lm = localAll.find(function (d) { return d.docId === docId; });
    const tok = localStorage.getItem('neomd.access') || '';
    const vid = app?.vault?.vaultId || '';

    // remote manifest entries: per-doc manifest + device index
    const mfKey = 'vaults/' + vid + '/manifest/' + docId + '.json';
    let manifest = null;
    const mr = await fetch('/api/storage/object?key=' + encodeURIComponent(mfKey), { headers: { authorization: 'Bearer ' + tok } });
    if (mr.ok) { try { manifest = await mr.json(); } catch(e) { manifest = { parseErr: String(e).slice(0,80) }; } }

    return JSON.stringify({
      docId: docId, vid: vid,
      local: lm ? { rev: lm.rev, hash: lm.hash, syncedRev: lm.syncedRev, size: lm.size, updatedAt: lm.updatedAt } : null,
      manifestStatus: mr.status,
      manifest: manifest ? { rev: manifest.rev, hash: manifest.hash, updatedAt: manifest.updatedAt, size: manifest.size, deletedAt: manifest.deletedAt } : null,
      hashEqual: !!(lm && manifest && lm.hash === manifest.hash),
      syncedRevEqualsRev: !!(lm && lm.rev === (lm.syncedRev ?? -1)),
    });
  })()`, 120000);
  console.log('\n=== GATE BEFORE EDIT ===');
  try { console.log(JSON.stringify(JSON.parse(gateBefore), null, 2)); } catch { console.log(gateBefore); }

  // Edit + save, then read the gate values again (this is the critical snapshot).
  const gateAfter = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const MARK = window.__NM_MARK;
    const act = (app.tabs||[]).find(function (t) { return t.id === app.activeTabId; });
    const orig = act.content || '';
    await app.updateTabContent(act.id, orig + String.fromCharCode(10,10) + MARK);
    await new Promise(function (r) { setTimeout(r, 1000); });
    const stateBeforeSave = { syncState: app.syncState };
    try { await app.saveActiveTab(); } catch(e) {}
    // Immediately after saveActiveTab resolves (this is when sync:afterSave fires)
    const v0 = app.vault;
    const a0 = (v0.listAll ? v0.listAll() : []).find(function (d) { return d.docId === window.__NM_DOCID; });
    const snapAtSave = a0 ? { rev: a0.rev, hash: a0.hash, syncedRev: a0.syncedRev } : null;
    const stateAtSave = { syncState: app.syncState, summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '' };

    await new Promise(function (r) { setTimeout(r, 75000); });

    const v1 = app.vault;
    const a1 = (v1.listAll ? v1.listAll() : []).find(function (d) { return d.docId === window.__NM_DOCID; });
    const snapLater = a1 ? { rev: a1.rev, hash: a1.hash, syncedRev: a1.syncedRev } : null;

    const tok = localStorage.getItem('neomd.access') || '';
    const vid = app?.vault?.vaultId || '';
    const mfKey = 'vaults/' + vid + '/manifest/' + window.__NM_DOCID + '.json';
    let manifest = null;
    const mr = await fetch('/api/storage/object?key=' + encodeURIComponent(mfKey), { headers: { authorization: 'Bearer ' + tok } });
    if (mr.ok) { try { manifest = await mr.json(); } catch(e) {} }

    return JSON.stringify({
      stateBeforeSave: stateBeforeSave,
      snapAtSave: snapAtSave,
      stateAtSave: stateAtSave,
      snapLater: snapLater,
      stateLater: { syncState: app.syncState, summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '' },
      manifest: manifest ? { rev: manifest.rev, hash: manifest.hash } : null,
      hashEqualLater: !!(a1 && manifest && a1.hash === manifest.hash),
      gateL363: !!(a1 && a1.rev === (a1.syncedRev ?? -1)),
      logs: (app.syncLogs||[]).slice(0,6).map(function(l){ return l.level + ': ' + String(l.message).slice(0,140); }),
    });
  })()`, 240000);
  console.log('\n=== GATE AFTER EDIT+SAVE ===');
  try { console.log(JSON.stringify(JSON.parse(gateAfter), null, 2)); } catch { console.log(gateAfter); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
