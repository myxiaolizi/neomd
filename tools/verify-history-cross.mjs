/**
 * Cross-shell history / version visibility check.
 *
 * The goal requires "edited history versions must be viewable across ends".
 * The generic acceptance suite only asserted that the versions prefix returns
 * HTTP 200 (any object count, including zero, passed), which proves nothing:
 * a broken upload would still show 200/0.
 *
 * What "cross-end history" actually means here
 * --------------------------------------------
 * `saveActiveTab()` archives the **previous** content into
 * `versions/<docId>/`, then syncs the **new** content to `docs/<docId>/`.
 * So after one save:
 *   - the version objects contain the OLD text (that is the point of history:
 *     you roll back to a previous state);
 *   - the text we just typed lives in the DOC object.
 *
 * Therefore the real properties to prove are:
 *   a) a version object exists for this doc (history was recorded),
 *   b) the cloud doc object contains our marker (the save really synced),
 *   c) a DIFFERENT shell process reads that same doc and sees the marker.
 *
 * (c) is the "cross-end" part: the bytes live in cloud storage, not in one
 * shell's local cache.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = {
  tauri: { dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
  flutter: { dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
  winui3: { dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  qt: { dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  electron: { dir: 'NeoMD-2.1.0-electron-x64', exe: 'Neo MD.exe', args: [] },
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
  async eval(expr, timeoutMs = 120000) {
    const p = this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return { __err: 'TIMEOUT' };
    if (r.result?.exceptionDetails) {
      return {
        __err: r.result.exceptionDetails.text,
        d: r.result.exceptionDetails.exception?.description?.slice(0, 400),
      };
    }
    return r.result?.result?.value;
  }
}

/** Start a shell and attach a CDP session to its page. */
async function openShell(name, cdpPort, chromePort) {
  const spec = SHELLS[name];
  const dir = path.join(RELEASE, spec.dir);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(2500);

  let proc = null;
  if (name === 'electron') {
    // Electron has no local HTTP server; drive it straight through its own CDP.
    proc = spawn(path.join(dir, spec.exe), [`--remote-debugging-port=${cdpPort}`], { cwd: dir, env, stdio: 'ignore' });
    let target = null;
    for (let i = 0; i < 50; i++) {
      await sleep(700);
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /neomd/i.test(t.url));
        if (target) break;
      } catch {}
    }
    if (!target) throw new Error('electron CDP target not found');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await sleep(4000);
    return { cdp, proc, ws, origin: target.url.replace(/\/$/, '') };
  }

  proc = spawn(path.join(dir, spec.exe), spec.args, { cwd: dir, env, stdio: 'ignore' });
  let origin = null;
  for (let i = 0; i < 55; i++) {
    await sleep(700);
    try {
      const boot = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(boot)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(boot, 'utf8'));
        if (m) {
          origin = m[1].replace(/\/$/, '');
          break;
        }
      }
      const pt = path.join(dir, 'data', 'server-port.txt');
      if (fs.existsSync(pt)) {
        const p = fs.readFileSync(pt, 'utf8').trim();
        if (/^\d+$/.test(p)) {
          origin = `http://127.0.0.1:${p}`;
          break;
        }
      }
    } catch {}
  }
  if (!origin) throw new Error('no local endpoint');

  const chromeDir = path.join(process.cwd(), `.tmp-hist-${name}`);
  fs.rmSync(chromeDir, { recursive: true, force: true });
  spawn(CHROME, [`--remote-debugging-port=${chromePort}`, `--user-data-dir=${chromeDir}`,
    '--headless=new', '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      if (r.ok) break;
    } catch {}
  }
  const t = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(origin + '/')}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);
  return { cdp, proc, ws, origin };
}

async function login(cdp) {
  return cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'hist-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return 'ok';
    }
    return 'fail:' + (j?.message || r.status);
  })()`);
}

/** Wait until the shell has synced at least `want` documents. */
async function waitDocs(cdp, want = 1, tries = 14) {
  for (let i = 0; i < tries; i++) {
    await sleep(6000);
    const s = await cdp.eval(`(() => {
      const a = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({ d: (a?.docs||[]).length, v: a?.vault?.vaultId ?? '' });
    })()`);
    try {
      const o = JSON.parse(s);
      if (o.d >= want) return o;
    } catch {}
  }
  return { d: 0, v: '' };
}

(async () => {
  const A = process.argv[2] ?? 'qt';
  const B = process.argv[3] ?? 'tauri';
  const marker = 'XVER-' + Date.now();
  const out = { writer: A, reader: B, marker, steps: [], pass: false };
  const fail = (why) => {
    out.steps.push({ step: 'abort', ok: false, why });
    return out;
  };

  let sa = null;
  let sb = null;
  try {
    // ---------- shell A: log in, sync, edit, save ----------
    sa = await openShell(A, 9911, 9912);
    out.steps.push({ step: 'openA', ok: true, origin: sa.origin });
    const la = await login(sa.cdp);
    if (la !== 'ok') return fail('loginA=' + la);
    await sa.cdp.send('Page.reload');
    await sleep(7000);
    await sa.cdp.send('Runtime.enable');
    const da = await waitDocs(sa.cdp, 1);
    out.steps.push({ step: 'syncA', ok: da.d > 0, docs: da.d, vaultId: da.v });
    if (da.d === 0) return fail('shell A never synced any document');

    // Hand the marker to the page as a global: embedding it through nested
    // template interpolation is fragile and previously produced a syntax error.
    await sa.cdp.eval(`window.__NM_MARK = ${JSON.stringify(marker)}; 'set'`);

    const writeRes = await sa.cdp.eval(`(async () => {
      const MARK = window.__NM_MARK;
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      const first = (app?.docs||[])[0];
      const docId = first?.docId ?? first?.id;
      if (!docId) return JSON.stringify({ ok:false, why:'no docs' });
      let openErr = '';
      try {
        await app.openDoc(docId);
      } catch (e) { openErr = String(e).slice(0, 200); }
      await new Promise(function (r) { setTimeout(r, 3000); });
      const active = (app.tabs||[]).find(function (t) { return t.id === app.activeTabId; }) || (app.tabs||[])[0];
      if (!active) return JSON.stringify({ ok:false, why:'no tab', openErr });
      const activeDocId = active.docId ?? (active.meta && active.meta.docId) ?? active.id;
      if (activeDocId !== docId) {
        return JSON.stringify({ ok:false, why:'tab mismatch', openErr, docId, activeDocId });
      }
      const orig = active.content || '';
      await app.updateTabContent(active.id, orig + String.fromCharCode(10, 10) + MARK);
      await new Promise(function (r) { setTimeout(r, 1500); });
      try { await app.saveActiveTab(); } catch (e) { openErr += ' save:' + String(e).slice(0,150); }
      await new Promise(function (r) { setTimeout(r, 9000); });
      const after = (app.tabs||[]).find(function (t) { return t.id === active.id; });
      return JSON.stringify({ ok:true, docId: docId, docTitle: first.title, activeDocId: activeDocId,
        tabHasMarker: String(after && after.content || '').includes(MARK),
        dirty: app.isDirty, summary: (app.lastSyncSummary && app.lastSyncSummary.message) || '', openErr: openErr });
    })()`, 180000);

    let w = {};
    try {
      w = JSON.parse(writeRes);
    } catch {
      return fail('write parse: ' + String(writeRes).slice(0, 200));
    }
    out.steps.push({
      step: 'write', ok: w.ok === true, docId: w.docId, docTitle: w.docTitle,
      tabHasMarker: w.tabHasMarker, dirty: w.dirty, summary: w.summary, openErr: w.openErr,
    });
    if (w.ok !== true) return fail('write failed: ' + (w.why || '') + ' ' + (w.openErr || ''));

    // ---------- shell A: prove a version exists and the doc carries the marker ----------
    const readScript = `(async () => {
      const MARK = window.__NM_MARK;
      const tok = localStorage.getItem('neomd.access') || '';
      const docId = window.__NM_DOCID;
      const out = { docId: docId };
      const vl = await (await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } })).json();
      const ids = (vl && vl.data && vl.data.vaults ? vl.data.vaults : []).map(function (v) { return v.vaultId; });
      out.tried = ids.length;
      const newestFirst = function (arr) {
        return arr.sort(function (x, y) {
          const nx = Number((x.split('/').pop()||'').split('-')[0]) || 0;
          const ny = Number((y.split('/').pop()||'').split('-')[0]) || 0;
          return ny - nx;
        });
      };
      for (const vid of ids) {
        const vp = 'vaults/' + vid + '/versions/' + docId + '/';
        const vr = await fetch('/api/storage/list?prefix=' + encodeURIComponent(vp) + '&limit=100',
          { headers: { authorization: 'Bearer ' + tok } });
        const vj = await vr.json();
        const vkeys = ((vj && vj.data && vj.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
        const dp = 'vaults/' + vid + '/docs/' + docId + '/';
        const dr = await fetch('/api/storage/list?prefix=' + encodeURIComponent(dp) + '&limit=100',
          { headers: { authorization: 'Bearer ' + tok } });
        const dj = await dr.json();
        const dkeys = ((dj && dj.data && dj.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
        if (!vkeys.length && !dkeys.length) continue;
        newestFirst(dkeys);
        let hit = false;
        for (const k of dkeys.slice(0, 3)) {
          const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(k),
            { headers: { authorization: 'Bearer ' + tok } });
          const text = await ro.text();
          if (text.includes(MARK)) { hit = true; break; }
        }
        return JSON.stringify({ vid: vid, tried: ids.length, versionCount: vkeys.length,
          docCount: dkeys.length, docHasMarker: hit });
      }
      return JSON.stringify({ vid: '', tried: ids.length, versionCount: 0, docCount: 0, docHasMarker: false });
    })()`;

    await sa.cdp.eval(`window.__NM_MARK = ${JSON.stringify(marker)}; window.__NM_DOCID = ${JSON.stringify(w.docId)}; 'set'`);
    let ra = {};
    try {
      ra = JSON.parse(await sa.cdp.eval(readScript, 180000));
    } catch {
      return fail('readA parse failed');
    }
    out.steps.push({
      step: 'readA', ok: ra.versionCount > 0 && ra.docHasMarker === true,
      vid: ra.vid, versionCount: ra.versionCount, docCount: ra.docCount, docHasMarker: ra.docHasMarker,
    });

    // ---------- shell B: a DIFFERENT shell must see the same doc + history ----------
    try { sa.proc?.kill(); } catch {}
    try { sa.ws?.close(); } catch {}
    try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${SHELLS[A].exe}`, '/T'], { stdio: 'ignore' }); } catch {}
    await sleep(3000);

    sb = await openShell(B, 9921, 9922);
    out.steps.push({ step: 'openB', ok: true, origin: sb.origin });
    const lb = await login(sb.cdp);
    if (lb !== 'ok') return fail('loginB=' + lb);
    await sb.cdp.send('Page.reload');
    await sleep(7000);
    await sb.cdp.send('Runtime.enable');
    const db = await waitDocs(sb.cdp, 1);
    out.steps.push({ step: 'syncB', ok: db.d > 0, docs: db.d, vaultId: db.v });

    await sb.cdp.eval(`window.__NM_MARK = ${JSON.stringify(marker)}; window.__NM_DOCID = ${JSON.stringify(w.docId)}; 'set'`);
    let rb = {};
    try {
      rb = JSON.parse(await sb.cdp.eval(readScript, 180000));
    } catch {
      return fail('readB parse failed');
    }
    out.steps.push({
      step: 'readB', ok: rb.docHasMarker === true && rb.versionCount > 0,
      vid: rb.vid, versionCount: rb.versionCount, docCount: rb.docCount, docHasMarker: rb.docHasMarker,
    });

    out.pass = ra.versionCount > 0 && ra.docHasMarker === true &&
      rb.versionCount > 0 && rb.docHasMarker === true;
  } catch (e) {
    out.steps.push({ step: 'exception', ok: false, why: String(e).slice(0, 300) });
    out.pass = false;
  } finally {
    try { sb?.proc?.kill(); } catch {}
    try { sb?.ws?.close(); } catch {}
    try { sa?.proc?.kill(); } catch {}
    try { sa?.ws?.close(); } catch {}
    for (const n of [A, B]) {
      try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${SHELLS[n].exe}`, '/T'], { stdio: 'ignore' }); } catch {}
    }
    try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  }

  fs.mkdirSync('reports', { recursive: true });
  const outFile = path.join('reports', `history-cross-${A}-to-${B}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})();
