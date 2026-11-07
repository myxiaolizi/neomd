/**
 * Where does the appended text actually go when saveActiveTab() runs?
 *
 * Flutter 2.2.0 failed edit.save like this: rev 4 / syncedRev 4 (index says
 * "fully synced"), sync summary "推送 0 篇", and the cloud object list contains
 * no marker. So either
 *   a) the edit never reached the file on disk (write lost), or
 *   b) it reached disk but the index/rev was already ahead so nothing got pushed, or
 *   c) the edit was overwritten by the editor's own state before the save.
 *
 * These have very different consequences: (a)/(c) mean a user's typing can be
 * silently lost, which is a serious defect; (b) would be a test-harness artifact.
 *
 * This probe compares four views of the same document after a save:
 *   tab.content (in-memory editor state)
 *   disk file   (what the vault actually wrote)
 *   index entry (rev / syncedRev / hash / size)
 *   cloud       (objects under vaults/<vid>/docs/<docId>/)
 *
 * Run: node tools/probe-save-disk.mjs 2.2.0 flutter
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'flutter';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9661 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9662;
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
  async eval(expr, timeoutMs = 400000) {
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
    const cd = path.join(process.cwd(), `.tmp-savedisk-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'savedisk-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const out = {};

    for (let i = 0; i < 90; i++) { if (app.syncState === 'idle') break; await sleep(2000); }
    for (let i = 0; i < 60; i++) { if ((app.docs||[]).length) break; await sleep(2000); }

    const list = app.docs || [];
    if (!list.length) return JSON.stringify({ ok:false, why:'no docs' });
    const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));
    const doc = sorted[0];
    out.docId = doc.docId; out.title = doc.title;

    await app.openDoc(doc.docId);
    await sleep(2500);

    const stamp = 'DISK-' + Date.now();
    out.stamp = stamp;
    const idxOf = () => (app.docs||[]).find(d => d.docId === doc.docId) || {};
    const tabNow = () => app.tabs?.find(t => t.id === app.activeTabId);
    out.beforeSave = (() => { const d = idxOf(); const t = tabNow(); return {
      rev: d.rev, syncedRev: d.syncedRev, size: d.size, dirty: t?.dirty ?? null,
      tabLen: (t?.content ?? '').length }; })();

    const orig = tabNow()?.content ?? '';
    await app.updateTabContent(app.activeTabId, orig + '\\n\\n' + stamp);
    await sleep(900);
    const t1 = tabNow();
    out.afterEdit = { dirty: t1?.dirty ?? null, tabLen: (t1?.content ?? '').length,
      tabHasStamp: (t1?.content ?? '').indexOf(stamp) >= 0 };

    await app.saveActiveTab();
    await sleep(2500);
    const t2 = tabNow();
    const d2 = idxOf();
    out.afterSave = { dirty: t2?.dirty ?? null, tabLen: (t2?.content ?? '').length,
      tabHasStamp: (t2?.content ?? '').indexOf(stamp) >= 0,
      rev: d2.rev, syncedRev: d2.syncedRev, size: d2.size, syncState: app.syncState };

    // give autosave/sync a moment, then look at disk through the vault API
    await sleep(4000);
    out.disk = {};
    try {
      const bp = app.getBridge?.() ?? window.NeoMD;
      if (bp && bp.vault && typeof bp.vault.readDoc === 'function') {
        const r = await bp.vault.readDoc(doc.docId);
        const txt = typeof r === 'string' ? r : (r?.content ?? '');
        out.disk = { ok:true, len: txt.length, hasStamp: txt.indexOf(stamp) >= 0 };
      } else {
        // fall back to whatever read API the store exposes
        if (typeof app.readDocContent === 'function') {
          const txt = await app.readDocContent(doc.docId);
          out.disk = { ok:true, via:'readDocContent', len: (txt||'').length, hasStamp: (txt||'').indexOf(stamp) >= 0 };
        } else {
          out.disk = { ok:false, why:'no read API on bridge/store',
            bridgeKeys: bp ? Object.keys(bp).slice(0,20) : null,
            vaultKeys: bp?.vault ? Object.keys(bp.vault).slice(0,30) : null };
        }
      }
    } catch (e) { out.disk = { ok:false, err:String(e).slice(0,200) }; }

    // wait for sync to settle, then re-read
    for (let i = 0; i < 120; i++) { if (app.syncState === 'idle') break; await sleep(2000); }
    const d3 = idxOf();
    out.afterSync = { rev: d3.rev, syncedRev: d3.syncedRev, size: d3.size, summary: app.lastSyncSummary ?? null };

    // cloud
    const tok = localStorage.getItem('neomd.access') || '';
    const vaultId = app.vault?.vaultId;
    const pre = 'vaults/' + vaultId + '/docs/' + doc.docId + '/';
    const lr = await fetch('/api/storage/list?prefix=' + encodeURIComponent(pre) + '&limit=200',
      { headers: { authorization: 'Bearer ' + tok } });
    const lj = await lr.json().catch(()=>({}));
    const keys = ((lj && lj.data && lj.data.objects) || []).map(o => o.key || o.Key).filter(Boolean);
    out.cloud = { count: keys.length, keys: keys.slice(0,6) };
    out.cloud.hasStamp = false;
    for (const k of keys) {
      const rr = await fetch('/api/storage/object?key=' + encodeURIComponent(k), { headers: { authorization: 'Bearer ' + tok } });
      const tx = await rr.text();
      if (tx.indexOf(stamp) >= 0) { out.cloud.hasStamp = true; out.cloud.stampKey = k; break; }
    }
    return JSON.stringify(out);
  })()`, 700000);

  console.log('\n=== save/disk/cloud trace ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
