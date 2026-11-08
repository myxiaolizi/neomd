/**
 * 定位 electron 的 edit.save 为什么推送 0 篇。
 *
 * 现象（稳定复现 2 次）：
 *   脏=false，同步态=idle，拉取 0 篇，推送 0 篇，跳过 2601 篇
 *   云端未确认：最新 5 个对象均不含标记（对象 2 个）
 *
 * "跳过 2601 篇"来自 sync-engine.ts:245 —— `l.hash === entry.hash` 就 markSynced + skipped。
 * 也就是说同步引擎认为**本地索引里的 hash 与云端 manifest 完全一致**，所以没有任何推送。
 *
 * 但刚刚调用过 saveActiveTab，按理本地 hash 应该变了。可疑点：
 *   a) saveActiveTab 内部 fireAndLog(syncNow) 用的 hash 计算时机不对
 *   b) 本地索引(l)是**内存里的旧快照**，save 后没刷新，比对的仍是旧 hash
 *   c) 那篇文档的 blob 确实传上去了，只是 accept 脚本查错了 docId/prefix
 *
 * 本探针把每一步的 hash / rev / syncedRev 都打出来，直接看是哪种。
 * 特别注意：**必须逐文档看**，不能只看汇总的 skipped 数字。
 *
 * Run: node tools/probe-electron-save.mjs 2.3.0
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.3.0';
const SRC = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}\\NeoMD-${VERSION}-electron-x64`;
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\elsave-${VERSION}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9771;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.wait = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method) this.events.push(m);
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
  // electron 有 portable.txt，数据在 data/；清掉会话态但保留标记
  for (const sub of ['data']) {
    const p = path.join(dir, sub);
    if (fs.existsSync(p)) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch {} }
  }
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'portable.txt'), 'portable\r\n', 'utf8');

  const exe = path.join(dir, 'Neo MD.exe');
  // electron 主进程自己开 CDP 端口
  spawn(exe, [`--remote-debugging-port=${CDP}`, '--no-sandbox'], { cwd: dir, env, stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && /neomd:\/\/|localhost|127\.0\.0\.1/.test(t.url));
      if (page) { target = page; break; }
    } catch {}
  }
  if (!target) { console.log('CDP target 未出现'); process.exit(1); }
  console.log('target:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // 登录
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const ready = await cdp.eval(`!!document.querySelector('#app')?.__vue_app__`);
    if (ready === 'true' || ready === true) break;
  }
  await cdp.eval(`(async () => {
    const r = await fetch('https://md.zhengl.vip/api/auth/login', { method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'elsave-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no app store' });
    for (let i = 0; i < 40 && (app.docs || []).length === 0; i++) await sleep(2500);

    const out = { docs: (app.docs || []).length, vaultId: app.vault?.vaultId ?? '' };
    const list = app.docs || [];
    if (!list.length) return JSON.stringify({ ...out, ok:false, why:'docs empty' });

    // 与 accept 脚本一致：挑最小文档
    const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));
    const first = sorted[0] ?? list[0];
    const docId = first?.docId ?? first?.id;
    const stamp = 'PROBE-ELSAVE-' + Date.now();
    out.docId = docId;
    out.origSize = first?.size;

    await app.openDoc(docId);
    await sleep(2500);
    const tabId = app.activeTabId;
    const tab0 = () => (app.tabs || []).find(t => t.id === tabId);
    out.beforeEdit = {
      contentLen: (tab0()?.content ?? '').length,
      dirty: tab0()?.dirty, rev: tab0()?.rev, syncedRev: tab0()?.syncedRev,
    };

    await app.updateTabContent(tabId, (tab0()?.content ?? '') + '\\n\\n' + stamp);
    await sleep(600);
    out.afterEdit = {
      contentLen: (tab0()?.content ?? '').length,
      dirty: tab0()?.dirty, rev: tab0()?.rev, syncedRev: tab0()?.syncedRev,
    };

    await app.saveActiveTab();
    out.afterSaveImmediate = {
      dirty: tab0()?.dirty, rev: tab0()?.rev, syncedRev: tab0()?.syncedRev,
      syncState: app.syncState,
    };

    for (let i = 0; i < 25; i++) {
      await sleep(3000);
      if (app.syncState === 'idle' || app.syncState === 'error') break;
    }
    out.afterSync = {
      dirty: tab0()?.dirty, rev: tab0()?.rev, syncedRev: tab0()?.syncedRev,
      syncState: app.syncState,
      lastSyncSummary: app.lastSyncSummary?.message ?? '',
    };

    // 关键：直接看本地索引里这篇的 hash，与云端 manifest 的 hash 比对
    try {
      const m = await app.vault?.get?.(docId);
      out.localMeta = m ? { hash: String(m.hash ?? '').slice(0,16), rev: m.rev, syncedRev: m.syncedRev, size: m.size } : null;
    } catch (e) { out.localMetaErr = String(e).slice(0,100); }

    // 读云端 manifest 中该文档的 entry
    try {
      const tok = localStorage.getItem('neomd.access') || '';
      const vaultId = app.vault?.vaultId || '';
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/'+vaultId+'/docs/'+docId+'/') + '&limit=200',
        { headers: { authorization: 'Bearer ' + tok } });
      const j = await r.json();
      const keys = ((j&&j.data&&j.data.objects)||[]).map(o=>o.key||o.Key).filter(Boolean);
      keys.sort((a,b)=> (Number((b.split('/').pop()||'').split('-')[0])||0) - (Number((a.split('/').pop()||'').split('-')[0])||0));
      out.cloudKeys = keys.slice(0,5);
      out.cloudKeyCount = keys.length;
      // 把最新的对象正文取出来，看标记是否在里面
      if (keys.length) {
        const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(keys[0]), { headers: { authorization: 'Bearer ' + tok } });
        const t = await ro.text();
        out.cloudLatestHasStamp = t.indexOf(stamp) >= 0;
        out.cloudLatestLen = t.length;
        out.cloudLatestTail = t.slice(-120);
      }
    } catch (e) { out.cloudErr = String(e).slice(0,150); }

    // 再看本地磁盘上的文件有没有写进去
    try {
      const all = await app.readDoc?.(docId);
      out.localReadLen = typeof all === 'string' ? all.length : -1;
      out.localReadHasStamp = typeof all === 'string' && all.indexOf(stamp) >= 0;
    } catch (e) { out.localReadErr = String(e).slice(0,100); }

    out.stamp = stamp;
    return JSON.stringify(out);
  })()`, 600000);

  console.log('\n=== electron save probe ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  const failed = [];
  for (const e of cdp.events) {
    if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) {
      failed.push({ status: e.params.response.status, url: e.params.response.url.slice(0, 120) });
    }
  }
  const by = {};
  for (const f of failed) by[f.status] = (by[f.status]||0)+1;
  console.log('\n失败请求:', JSON.stringify(by));

  ws.close();
  try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
