/**
 * 找出 accept 脚本挑中的那篇文档为什么推送不上去。
 *
 * 已排除：同步时序（已改成等 idle 再编辑，仍然失败）。
 * 已确认：tools/probe-electron-save.mjs 在同样代码上能推送成功（推送 1 篇、
 *        云端对象含标记）。两者唯一差别是**挑中的文档不同**。
 *
 * accept: `sorted[0]`（按 size 升序，挑最小的）→ 云端只有 2 个对象（正文 rev1 + manifest）
 * probe : 同样逻辑，但成功时云端有 3 个对象（rev2 含标记）
 *
 * 所以要查的是：accept 挑中那篇的实际状态 —— 它是不是 size=0、path 异常、
 * 或者根本是「已被删除/不该同步」的文档。
 *
 * 关键：把 docs 里 size 最小的 8 篇都打出来，看 accept 会挑中哪一篇。
 *
 * Run: node tools/probe-electron-docpick.mjs 2.3.0
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.3.0';
const SRC = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}\\NeoMD-${VERSION}-electron-x64`;
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\eldoc-${VERSION}`;
const CDP = 9773;
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
  async eval(expr, timeoutMs = 240000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text });
    return r.result?.result?.value;
  }
}

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(2500);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
  try { execFileSync('robocopy', [SRC, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' }); }
  catch (e) { if (typeof e.status !== 'number' || e.status > 7) throw e; }
  try { fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {}
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'portable.txt'), 'portable\r\n', 'utf8');

  spawn(path.join(dir, 'Neo MD.exe'), [`--remote-debugging-port=${CDP}`, '--no-sandbox'],
    { cwd: dir, env, stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /neomd:\/\/|localhost|127\.0\.0\.1/.test(t.url));
      if (page) { target = page; break; }
    } catch {}
  }
  if (!target) { console.log('CDP target 未出现'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const ready = await cdp.eval(`!!document.querySelector('#app')?.__vue_app__`);
    if (ready === true) break;
  }
  await cdp.eval(`(async () => {
    const r = await fetch('https://md.zhengl.vip/api/auth/login', { method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'eldoc-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(22000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no app store' });
    for (let i = 0; i < 60; i++) {
      await sleep(2500);
      if ((app.docs||[]).length > 0 && app.syncState === 'idle') break;
    }

    const out = { docs: (app.docs||[]).length, syncState: app.syncState };
    const list = app.docs || [];
    const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));

    // accept 会挑 sorted[0] —— 把它连同前 8 篇全打出来
    out.pick = sorted.slice(0, 8).map(d => ({
      docId: d.docId, title: String(d.title ?? '').slice(0, 40),
      size: d.size, path: String(d.path ?? '').slice(0, 60),
      rev: d.rev, syncedRev: d.syncedRev, hash: String(d.hash ?? '').slice(0,12),
      deletedAt: d.deletedAt ?? null,
    }));

    // 关键：看这几篇在云端的对象情况
    const tok = localStorage.getItem('neomd.access') || '';
    const vaultId = app.vault?.vaultId || '';
    out.cloud = [];
    for (const d of sorted.slice(0, 4)) {
      try {
        const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/'+vaultId+'/docs/'+d.docId+'/') + '&limit=200',
          { headers: { authorization: 'Bearer ' + tok } });
        const j = await r.json();
        const keys = ((j&&j.data&&j.data.objects)||[]).map(o=>o.key||o.Key).filter(Boolean);
        out.cloud.push({ docId: d.docId, size: d.size, objectCount: keys.length, keys: keys.slice(0,4) });
      } catch (e) {
        out.cloud.push({ docId: d.docId, err: String(e).slice(0,80) });
      }
    }

    // 再验一次：对 sorted[0] 真正做一次编辑保存，看能否推送
    const first = sorted[0];
    const stamp = 'DOCPICK-' + Date.now();
    await app.openDoc(first.docId);
    await sleep(2500);
    const tabId = app.activeTabId;
    const tabNow = () => (app.tabs||[]).find(t => t.id === tabId);
    out.targetDoc = { docId: first.docId, size: first.size, title: String(first.title ?? '').slice(0,40),
      contentLenOnOpen: (tabNow()?.content ?? '').length };

    await app.updateTabContent(tabId, (tabNow()?.content ?? '') + '\\n\\n' + stamp);
    await sleep(600);
    out.dirtyAfterEdit = tabNow()?.dirty;
    await app.saveActiveTab();
    for (let i = 0; i < 25; i++) {
      await sleep(3000);
      if (app.syncState === 'idle' || app.syncState === 'error') break;
    }
    out.afterSave = {
      syncState: app.syncState, summary: app.lastSyncSummary?.message ?? '',
      rev: tabNow()?.rev, syncedRev: tabNow()?.syncedRev, contentLen: (tabNow()?.content ?? '').length,
    };

    // 云端复查
    try {
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/'+vaultId+'/docs/'+first.docId+'/') + '&limit=200',
        { headers: { authorization: 'Bearer ' + tok } });
      const j = await r.json();
      const keys = ((j&&j.data&&j.data.objects)||[]).map(o=>o.key||o.Key).filter(Boolean);
      out.cloudAfter = { objectCount: keys.length, keys: keys.slice(0,5) };
      // 逐个取，看是否有标记
      out.stampFound = false;
      for (const k of keys.slice(0,5)) {
        const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(k), { headers: { authorization: 'Bearer ' + tok } });
        const t = await ro.text();
        if (t.indexOf(stamp) >= 0) { out.stampFound = true; out.stampInKey = k; break; }
      }
    } catch (e) { out.cloudAfterErr = String(e).slice(0,120); }

    out.stamp = stamp;
    return JSON.stringify(out);
  })()`, 600000);

  console.log('\n=== electron docpick probe ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
