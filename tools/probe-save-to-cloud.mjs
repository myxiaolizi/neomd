/**
 * Does a shell's save actually reach cloud storage?
 *
 * The cross-shell history test showed: the editor tab holds our marker, the
 * dirty flag clears, but the cloud doc objects for that docId never contain it.
 * Two very different explanations fit that symptom:
 *   (1) the save is local-only and cloud sync silently no-ops, or
 *   (2) the save works but writes to a different object/key than we expect.
 *
 * This probe separates them: it records the doc's object list and newest
 * content BEFORE the save, then again AFTER, and prints both rev numbers plus
 * content tails. A new rev appearing with the marker = sync works; no new rev =
 * the save never reached the cloud.
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
      return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
    }
    return r.result?.result?.value;
  }
}

/** Snapshot cloud state of one doc: object keys, newest rev, newest content tail. */
const SNAP = `(async () => {
  const tok = localStorage.getItem('neomd.access') || '';
  const docId = window.__NM_DOCID;
  const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
  const vid = app?.vault?.vaultId || '';
  const dp = 'vaults/' + vid + '/docs/' + docId + '/';
  const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(dp) + '&limit=200',
    { headers: { authorization: 'Bearer ' + tok } });
  const j = await r.json();
  const keys = ((j && j.data && j.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
  const revOf = function (k) { return Number((k.split('/').pop() || '').split('-')[0]) || 0; };
  keys.sort(function (a, b) { return revOf(b) - revOf(a); });
  let newest = '', tail = '', size = 0, markerIn = false;
  if (keys[0]) {
    newest = keys[0].split('/').pop();
    const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(keys[0]),
      { headers: { authorization: 'Bearer ' + tok } });
    const text = await ro.text();
    size = text.length;
    tail = text.slice(-200);
    markerIn = text.includes(window.__NM_MARK || '\\u0000none');
  }
  return JSON.stringify({ vid: vid, objects: keys.length, maxRev: keys[0] ? revOf(keys[0]) : 0,
    newest: newest, size: size, tail: tail, markerIn: markerIn });
})()`;

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

  const cd = path.join(process.cwd(), '.tmp-savediag');
  fs.rmSync(cd, { recursive: true, force: true });
  spawn(CHROME, ['--remote-debugging-port=9941', `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9941/json/version'); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:9941/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'savediag-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) { localStorage.setItem('neomd.access', j.data.accessToken); if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken); }
    return 'ok';
  })()`);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const marker = 'SAVE-' + Date.now();

  // pick the doc + open it
  const pick = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const first = (app?.docs||[])[0];
    const docId = first?.docId ?? first?.id;
    window.__NM_DOCID = docId;
    window.__NM_MARK = ${JSON.stringify(marker)};
    let err = '';
    try { await app.openDoc(docId); } catch(e) { err = String(e).slice(0,200); }
    await new Promise(function (r) { setTimeout(r, 3000); });
    const act = (app.tabs||[]).find(function (t) { return t.id === app.activeTabId; }) || (app.tabs||[])[0];
    return JSON.stringify({ docId: docId, err: err, activeId: act && act.id,
      activeDocId: act && (act.docId ?? (act.meta&&act.meta.docId) ?? act.id),
      contentLen: (act && act.content || '').length, dirty: act && act.dirty });
  })()`);
  console.log('\n=== picked doc ===');
  console.log(pick);

  console.log('\n=== cloud BEFORE save ===');
  const before = await cdp.eval(SNAP);
  console.log(JSON.stringify(JSON.parse(before), null, 2));

  // write + save
  const sv = await cdp.eval(`(async () => {
    const MARK = window.__NM_MARK;
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const act = (app.tabs||[]).find(function (t) { return t.id === app.activeTabId; }) || (app.tabs||[])[0];
    const orig = act.content || '';
    await app.updateTabContent(act.id, orig + String.fromCharCode(10,10) + MARK);
    await new Promise(function (r) { setTimeout(r, 1200); });
    const afterEdit = (app.tabs||[]).find(function (t) { return t.id === act.id; });
    const dirtyBeforeSave = afterEdit && afterEdit.dirty;
    let saveErr = '';
    let ret = null;
    try { ret = await app.saveActiveTab(); } catch(e) { saveErr = String(e).slice(0,250); }
    await new Promise(function (r) { setTimeout(r, 12000); });
    const fin = (app.tabs||[]).find(function (t) { return t.id === act.id; });
    return JSON.stringify({ dirtyBeforeSave: dirtyBeforeSave, saveErr: saveErr,
      ret: typeof ret === 'undefined' ? 'undefined' : String(ret).slice(0,120),
      dirtyAfter: fin && fin.dirty, tabHasMarker: String(fin && fin.content || '').includes(MARK),
      summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '',
      syncState: app.syncState });
  })()`, 240000);
  console.log('\n=== save ===');
  console.log(sv);

  console.log('\n=== cloud AFTER save ===');
  const after = await cdp.eval(SNAP);
  console.log(JSON.stringify(JSON.parse(after), null, 2));

  // force a full sync, then re-check
  const fs2 = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    let err = '';
    try { await app.syncNow({ silent: true }); } catch(e) { err = String(e).slice(0,250); }
    await new Promise(function (r) { setTimeout(r, 15000); });
    return JSON.stringify({ err: err, syncState: app.syncState,
      summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '',
      docs: (app.docs||[]).length });
  })()`, 240000);
  console.log('\n=== force syncNow ===');
  console.log(fs2);

  console.log('\n=== cloud AFTER force sync ===');
  const after2 = await cdp.eval(SNAP);
  console.log(JSON.stringify(JSON.parse(after2), null, 2));

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
