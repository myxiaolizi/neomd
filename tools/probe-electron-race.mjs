/**
 * 查清「连续两次保存（自动 + 手动）会不会丢推送」。
 *
 * 已验证的事实：
 *   - accept 脚本：updateTabContent → 等 800ms → saveActiveTab
 *     → 结果「推送 0 篇、跳过 2603 篇」，云端没有标记。
 *   - probe 脚本：updateTabContent → 等 2500ms 再 saveActiveTab
 *     → 结果「推送 1 篇」，云端有标记。
 *
 * 差异只有一个：accept 等的 800ms **小于** 自动保存的 1500ms 节流窗口。
 * 于是产生竞态：
 *   编辑(0ms) → 手动 save(800ms) 开始 → 它内部先 await vault.read() 归档旧内容
 *   → 自动保存定时器(1500ms) 触发 saveActiveTab({auto:true}) → 看到 dirty 仍在 → 保存并 commit
 *   → 手动 save 恢复执行时 dirty 已被清 → 走 `if (!tab.dirty) return` 直接返回
 *
 * 这里要回答的核心问题：**改动到底传上去了没有？**
 *   A) 若自动保存那次推送成功 → 云端有标记，只是 accept 查得太早 → 测法问题
 *   B) 若两次都没推送 → 真缺陷（并发保存互相踩）
 *
 * 做法：完全模拟 accept 的时序（800ms），但保存后**等足**再查云端。
 *
 * Run: node tools/probe-electron-race.mjs 2.3.0
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.3.0';
const SRC = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}\\NeoMD-${VERSION}-electron-x64`;
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\elrace-${VERSION}`;
const CDP = 9775;
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'elrace-'+Date.now()}) });
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
    const out = { docs: (app.docs||[]).length, vaultId: app.vault?.vaultId ?? '' };
    const tok = localStorage.getItem('neomd.access') || '';
    const vaultId = app.vault?.vaultId || '';

    const listCloud = async (docId) => {
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/'+vaultId+'/docs/'+docId+'/') + '&limit=200',
        { headers: { authorization: 'Bearer ' + tok } });
      const j = await r.json();
      const keys = ((j&&j.data&&j.data.objects)||[]).map(o=>o.key||o.Key).filter(Boolean);
      const revOf = (k) => Number((k.split('/').pop()||'').split('-')[0]) || 0;
      keys.sort((a,b)=>revOf(b)-revOf(a));
      return keys;
    };
    const hasStamp = async (docId, stamp) => {
      const keys = await listCloud(docId);
      for (const k of keys.slice(0,5)) {
        const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(k), { headers: { authorization: 'Bearer ' + tok } });
        const t = await ro.text();
        if (t.indexOf(stamp) >= 0) return { found: true, key: k, count: keys.length };
      }
      return { found: false, count: keys.length, keys: keys.slice(0,4) };
    };

    /* ---- 场景1：复刻 accept 的时序（800ms 后 save）---- */
    const d1 = (app.docs||[]).find(d => (d.size ?? 0) === 0) ?? app.docs[0];
    const stamp1 = 'RACE-800-' + Date.now();
    await app.openDoc(d1.docId);
    await sleep(2500);
    let tabId = app.activeTabId;
    const t1 = () => (app.tabs||[]).find(t => t.id === tabId);
    await app.updateTabContent(tabId, (t1()?.content ?? '') + '\\n\\n' + stamp1);
    await sleep(800);                    // <- accept 的等待
    const dirtyAtSave = t1()?.dirty;
    await app.saveActiveTab();           // <- 可能与 1500ms 自动保存竞态
    for (let i = 0; i < 25; i++) {
      await sleep(3000);
      if (app.syncState === 'idle' || app.syncState === 'error') break;
    }
    // 关键：等足再查，别像 accept 那样立刻查
    await sleep(6000);
    const check1 = await hasStamp(d1.docId, stamp1);
    out.scenario800 = {
      docId: d1.docId, docTitle: String(d1.title ?? '').slice(0,30), dirtyAtSave,
      saveSummary: app.lastSyncSummary?.message ?? '',
      cloudAfterWait: check1,
    };

    /* ---- 场景2：等 2500ms 后 save（probe 的时序）---- */
    const d2 = (app.docs||[]).find(d => (d.size ?? 0) === 0 && d.docId !== d1.docId) ?? app.docs[1] ?? d1;
    const stamp2 = 'RACE-2500-' + Date.now();
    await app.openDoc(d2.docId);
    await sleep(2500);
    tabId = app.activeTabId;
    const t2 = () => (app.tabs||[]).find(t => t.id === tabId);
    await app.updateTabContent(tabId, (t2()?.content ?? '') + '\\n\\n' + stamp2);
    await sleep(2500);
    await app.saveActiveTab();
    for (let i = 0; i < 25; i++) {
      await sleep(3000);
      if (app.syncState === 'idle' || app.syncState === 'error') break;
    }
    await sleep(3000);
    const check2 = await hasStamp(d2.docId, stamp2);
    out.scenario2500 = {
      docId: d2.docId, docTitle: String(d2.title ?? '').slice(0,30),
      saveSummary: app.lastSyncSummary?.message ?? '',
      cloudAfterWait: check2,
    };

    out.verdict = {
      // 场景1 若云端有标记，说明自动保存把改动推上去了 —— 只是 accept 查得早
      s800_cloudHasStamp: check1.found,
      s2500_cloudHasStamp: check2.found,
      // 真正的判定：两种时序下改动是否都最终到达云端
      noDataLoss: check1.found && check2.found,
    };
    return JSON.stringify(out);
  })()`, 900000);

  console.log('\n=== electron save race probe ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/F', '/FI', 'IMAGENAME eq Neo MD.exe', '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
