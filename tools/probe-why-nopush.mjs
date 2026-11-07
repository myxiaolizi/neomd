/**
 * Why does the engine report "pushed 0" right after a save?
 *
 * After fixing the syncNow serialization, a save still reports
 * `推送 0 篇` and the cloud doc rev does not advance. That means the engine ran
 * but decided there was nothing to push. The suspect is the version/manifest
 * bookkeeping the engine uses to decide a doc changed, not the transport.
 *
 * This probe prints, right after a save:
 *   - what the engine's own change detection sees for the doc
 *   - the local doc's rev/hash vs the manifest's recorded rev/hash
 *   - the remote newest rev/hash
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

  const cd = path.join(process.cwd(), '.tmp-whynopush');
  fs.rmSync(cd, { recursive: true, force: true });
  spawn(CHROME, ['--remote-debugging-port=9943', `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9943/json/version'); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:9943/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'why-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) { localStorage.setItem('neomd.access', j.data.accessToken); if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken); }
    return 'ok';
  })()`);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const marker = 'WHY-' + Date.now();

  // Wait for a completely idle state first, so the save's sync is not racing
  // an in-progress sync (that race is what the earlier fix addressed).
  for (let i = 0; i < 20; i++) {
    const s = await cdp.eval(`(() => {
      const a = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({ state: a?.syncState, docs: (a?.docs||[]).length });
    })()`);
    let o = {};
    try { o = JSON.parse(s); } catch {}
    console.log('  idle check:', JSON.stringify(o));
    if (o.state === 'idle' && o.docs > 0) break;
    await sleep(5000);
  }

  const pre = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const first = (app?.docs||[])[0];
    const docId = first?.docId ?? first?.id;
    window.__NM_DOCID = docId;
    window.__NM_MARK = ${JSON.stringify(marker)};
    await app.openDoc(docId);
    await new Promise(function (r) { setTimeout(r, 2500); });
    // local meta before edit
    const before = (app.docs||[]).find(function (d) { return d.docId === docId; });
    // engine internals: can we see a manifest / state map?
    const v = app.vault;
    return JSON.stringify({
      docId: docId,
      docMetaBefore: before ? { rev: before.rev, hash: before.hash, size: before.size, updatedAt: before.updatedAt } : null,
      syncState: app.syncState,
      vaultKeys: v ? Object.keys(v).slice(0, 40) : [],
    });
  })()`, 120000);
  console.log('\n=== BEFORE EDIT ===');
  console.log(pre);

  const doSave = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const MARK = window.__NM_MARK;
    const act = (app.tabs||[]).find(function (t) { return t.id === app.activeTabId; });
    const orig = act.content || '';
    await app.updateTabContent(act.id, orig + String.fromCharCode(10,10) + MARK);
    await new Promise(function (r) { setTimeout(r, 1000); });
    const preSave = {
      syncState: app.syncState,
      dirty: (app.tabs||[]).find(function(t){return t.id===act.id;})?.dirty,
    };
    let err = '';
    try { await app.saveActiveTab(); } catch(e) { err = String(e).slice(0,300); }
    const immediately = {
      syncState: app.syncState,
      summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '',
    };
    await new Promise(function (r) { setTimeout(r, 14000); });
    const later = {
      syncState: app.syncState,
      summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '',
      dirty: (app.tabs||[]).find(function(t){return t.id===act.id;})?.dirty,
      logs: (app.syncLogs||[]).slice(0, 5).map(function(l){ return l.level + ': ' + String(l.message).slice(0,160); }),
    };
    const after = (app.docs||[]).find(function (d) { return d.docId === window.__NM_DOCID; });
    return JSON.stringify({ preSave: preSave, immediately: immediately, later: later,
      err: err,
      docMetaAfter: after ? { rev: after.rev, hash: after.hash, size: after.size, updatedAt: after.updatedAt } : null });
  })()`, 240000);
  console.log('\n=== SAVE (base fixed, no race) ===');
  try { console.log(JSON.stringify(JSON.parse(doSave), null, 2)); } catch { console.log(doSave); }

  const cloud = await cdp.eval(`(async () => {
    const tok = localStorage.getItem('neomd.access') || '';
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const vid = app?.vault?.vaultId || '';
    const dp = 'vaults/' + vid + '/docs/' + window.__NM_DOCID + '/';
    const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(dp) + '&limit=200',
      { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json();
    const keys = ((j && j.data && j.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
    const revOf = function (k) { return Number((k.split('/').pop()||'').split('-')[0]) || 0; };
    keys.sort(function (a, b) { return revOf(b) - revOf(a); });
    let markerIn = false, tail = '';
    if (keys[0]) {
      const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(keys[0]), { headers: { authorization: 'Bearer ' + tok } });
      const text = await ro.text();
      markerIn = text.includes(window.__NM_MARK);
      tail = text.slice(-120);
    }
    return JSON.stringify({ vid: vid, objects: keys.length, maxRev: keys[0] ? revOf(keys[0]) : 0, markerIn: markerIn, tail: tail });
  })()`, 120000);
  console.log('\n=== CLOUD AFTER SAVE (no race) ===');
  console.log(JSON.stringify(JSON.parse(cloud), null, 2));

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
