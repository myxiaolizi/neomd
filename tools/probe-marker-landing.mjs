/**
 * Diagnostic: after a save in a shell, where does the marker text actually land?
 *
 * The cross-shell history test found version objects but none containing the
 * marker we wrote. Before changing any product code we need to know whether
 *   (a) the save never persisted the marker (editor/save path problem), or
 *   (b) the marker persisted into the doc but no version captured it
 *       (versioning problem), or
 *   (c) both are fine and only my object-key search was wrong.
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
  async eval(expr, timeoutMs = 120000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
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

  const cd = path.join(process.cwd(), '.tmp-hdiag');
  fs.rmSync(cd, { recursive: true, force: true });
  spawn(CHROME, ['--remote-debugging-port=9931', `--user-data-dir=${cd}`, '--headless=new', '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:9931/json/version'); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:9931/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'hdiag-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) { localStorage.setItem('neomd.access', j.data.accessToken); if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken); }
    return 'ok';
  })()`);
  await cdp.send('Page.reload');
  await sleep(18000);
  await cdp.send('Runtime.enable');

  const marker = 'HDIAG-' + Date.now();

  const res = await cdp.eval(`(async () => {
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const tok = localStorage.getItem('neomd.access') || '';
    const out = { marker: ${JSON.stringify(marker)} };
    out.docs = (app?.docs||[]).length;
    const first = (app?.docs||[])[0];
    if (!first) { out.err = 'no docs'; return JSON.stringify(out); }
    const docId = first.docId ?? first.id;
    out.docId = docId;
    out.docTitle = first.title;

    // open + edit + save
    let tabId = null;
    try { await app.openDocument(docId); await new Promise(r=>setTimeout(r,3000)); tabId = app.activeTabId ?? app.tabs?.[0]?.id; } catch(e) { out.openErr = String(e).slice(0,150); }
    const tm = app.tabs?.find(t=>t.id===tabId) || app.tabs?.[0];
    if (!tm) { out.err2 = 'no tab'; return JSON.stringify(out); }
    tabId = tm.id;
    const orig = tm.content ?? '';
    out.contentLenBefore = orig.length;
    await app.updateTabContent(tabId, orig + '\\n\\n' + out.marker);
    await new Promise(r=>setTimeout(r,1500));
    // confirm the store actually holds our text before saving
    const tm2 = app.tabs?.find(t=>t.id===tabId);
    out.tabHasMarker = (tm2?.content ?? '').includes(out.marker);
    try { await app.saveActiveTab(); out.saved = true; } catch(e) { out.saveErr = String(e).slice(0,200); }
    await new Promise(r=>setTimeout(r,10000));
    out.dirtyAfter = app.isDirty;
    out.summary = app.lastSyncSummary?.message ?? '';

    // 1) does the LOCAL file contain the marker?
    try {
      const v = app.vault;
      out.localHasMarker = v && typeof v.readDoc === 'function' ? String(await v.readDoc(docId)).includes(out.marker) : null;
    } catch(e) { out.localErr = String(e).slice(0,150); }

    // 2) does the CLOUD doc object contain it?
    const vid = app?.vault?.vaultId || '';
    out.vaultId = vid;
    const dp = 'vaults/' + vid + '/docs/' + docId + '/';
    try {
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(dp) + '&limit=50', { headers:{authorization:'Bearer '+tok} });
      const j = await r.json();
      const objs = (j?.data?.objects ?? []).map(o=>o.key||o.Key).filter(Boolean);
      out.docObjects = objs.length;
      out.docKeys = objs.slice(0,4);
      // read the newest doc object
      objs.sort((x,y)=>{ const nx=Number((x.split('/').pop()||'').split('-')[0])||0; const ny=Number((y.split('/').pop()||'').split('-')[0])||0; return ny-nx; });
      if (objs[0]) {
        const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(objs[0]), { headers:{authorization:'Bearer '+tok} });
        const text = await ro.text();
        out.cloudDocStatus = ro.status;
        out.cloudDocHasMarker = text.includes(out.marker);
        out.cloudDocTail = text.slice(-120);
      }
    } catch(e) { out.cloudErr = String(e).slice(0,150); }

    // 3) versions: any containing the marker?
    const vp = 'vaults/' + vid + '/versions/' + docId + '/';
    try {
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(vp) + '&limit=50', { headers:{authorization:'Bearer '+tok} });
      const j = await r.json();
      const objs = (j?.data?.objects ?? []).map(o=>o.key||o.Key).filter(Boolean);
      out.versionObjects = objs.length;
      objs.sort((x,y)=>{ const nx=Number((x.split('/').pop()||'').split('-')[0])||0; const ny=Number((y.split('/').pop()||'').split('-')[0])||0; return ny-nx; });
      let hit = false, checked = 0;
      for (const k of objs.slice(0, 6)) {
        const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(k), { headers:{authorization:'Bearer '+tok} });
        const text = await ro.text();
        checked++;
        if (text.includes(out.marker)) { hit = true; out.versionHitKey = k; break; }
      }
      out.versionChecked = checked;
      out.versionHasMarker = hit;
      out.versionTail = objs[0] ? objs[0].split('/').pop() : '';
    } catch(e) { out.verErr = String(e).slice(0,150); }

    return JSON.stringify(out);
  })()`, 240000);

  console.log('\n=== result ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
