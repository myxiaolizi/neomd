/**
 * 复核「Electron 保存后历史版本为空」是否成立。
 *
 * 冲突点：
 *   - 子代理 electron-gemini4argon 报 FAIL：保存成功但 listDocVersions 返回空
 *   - 我的 tools/electron-accept.mjs 里 history.list 是 PASS（历史 2 个对象）
 * 两者都在 Electron 2.2.0 上，必须查清谁对。
 *
 * 已确立的产品语义（前几轮踩实）：
 *   saveActiveTab 归档的是**保存前的旧内容**，所以「版本对象不含刚写入的文本」
 *   是正确行为，跨端判据应是「版本数 > 0 + 云端 doc 含标记」。
 *
 * 怀疑子代理测法是：新建文档 -> 首次保存 -> 立刻查版本 -> 空。
 * 首次保存时"保存前旧内容"是空的，可能不产生归档对象（合理）。
 * 而我的验收用的是仓库里已有内容的旧文档，所以有历史。
 *
 * 本探针同时覆盖两种情况，看看到底哪种为空、是否合理：
 *   A. 已有内容的旧文档 -> 保存 -> 查版本
 *   B. 新建空文档     -> 首次保存 -> 查版本 -> 再次保存 -> 再查版本
 *
 * Run: node tools/probe-history-220.mjs electron
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SHELL = process.argv[2] ?? 'electron';
const VERSION = process.argv[3] ?? '2.2.0';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;

const SHELLS = {
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', proto: true },
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], env: { QTWEBENGINE_REMOTE_DEBUGGING: '9741' } },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', http: 51337 },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe' },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe' },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CDP = 9743;
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
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 400) });
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
  const env = { ...process.env, ...(spec.env ?? {}) };
  delete env.ELECTRON_RUN_AS_NODE;

  const args = [...(spec.args ?? [])];
  if (SHELL === 'electron') args.push(`--remote-debugging-port=${CDP}`);
  spawn(path.join(dir, spec.exe), args, { cwd: dir, env, stdio: 'ignore' });

  let ws = null, cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    await sleep(700);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && (SHELL !== 'electron' || /neomd:\/\//.test(t.url)));
      if (page) ({ ws, cdp } = await connect(page.webSocketDebuggerUrl));
    } catch {}
  }
  if (!cdp) { console.log('CDP not ready'); process.exit(1); }

  // 等应用起来并登录
  await sleep(12000);
  await cdp.eval(`(async () => {
    const tok = localStorage.getItem('neomd.access');
    if (tok) return 'already';
    const r = await fetch('https://md.zhengl.vip/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'probe-hist-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'login';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(15000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ err: 'no app store' });
    for (let i = 0; i < 20 && (app.docs || []).length === 0; i++) await sleep(2000);
    out.docsCount = (app.docs || []).length;
    out.syncState = app.syncState;

    const hasListApi = typeof app.listDocVersions === 'function';
    out.hasListDocVersions = hasListApi;
    const storeKeys = Object.keys(app).filter(k => /hist|version/i.test(k));
    out.versionKeys = storeKeys;
    const vaultKeys = app.vault ? Object.keys(app.vault).filter(k => /hist|version|list/i.test(k)) : [];
    out.vaultVersionKeys = vaultKeys;

    // 直接用底层接口查版本前缀作为独立证据（不依赖 store 方法）
    const vaultId = app.vault?.vaultId || app.vaultId;
    out.vaultId = (vaultId || '').slice(-10);

    const callVersions = async (docId) => {
      // a) store 公开方法
      if (typeof app.listDocVersions === 'function') {
        try { const v = await app.listDocVersions(docId); return { via: 'app.listDocVersions', n: (v || []).length, sample: (v || []).slice(0,3) }; }
        catch (e) { return { via: 'app.listDocVersions', err: String(e).slice(0,150) }; }
      }
      // b) vault 上的方法
      for (const name of ['listVersions', 'versions', 'listDocVersions', 'history']) {
        if (typeof app.vault?.[name] === 'function') {
          try { const v = await app.vault[name](docId); return { via: 'vault.' + name, n: (v || []).length }; }
          catch (e) { /* try next */ }
        }
      }
      return { via: 'none', n: null };
    };

    // ---------- A. 已有内容的旧文档 ----------
    const withContent = (app.docs || []).filter(d => (d.size ?? 0) > 0).sort((a,b)=>(a.size??0)-(b.size??0));
    const oldDoc = withContent[0] || (app.docs || [])[0];
    if (oldDoc) {
      await app.openDoc(oldDoc.docId);
      await sleep(2500);
      const tabId = app.activeTabId;
      const tab = () => app.tabs?.find(t => t.id === tabId);
      const markA = 'HIST-A-' + Date.now();
      app.updateTabContent?.(tabId, (tab()?.content ?? '') + '\\n\\n' + markA);
      await sleep(600);
      const beforeVer = await callVersions(oldDoc.docId);
      await app.saveActiveTab?.();
      await sleep(20000);
      const afterVer = await callVersions(oldDoc.docId);
      out.caseA = { docId: oldDoc.docId.slice(-8), size: oldDoc.size, beforeVer, afterVer };
    }

    // ---------- B. 新建空文档 ----------
    try {
      await app.createDoc({ title: 'hist-probe-' + Date.now(), content: '' });
      await sleep(2500);
      const tabId = app.activeTabId;
      const t = app.tabs?.find(x => x.id === tabId);
      const docId = t?.docId;
      const markB = 'HIST-B-' + Date.now();
      app.updateTabContent?.(tabId, markB);
      await sleep(600);
      await app.saveActiveTab?.();
      await sleep(18000);
      const v1 = await callVersions(docId);
      // 再编辑再存一次，看第二次是否产生版本
      app.updateTabContent?.(tabId, markB + '-2nd');
      await sleep(600);
      await app.saveActiveTab?.();
      await sleep(18000);
      const v2 = await callVersions(docId);
      out.caseB = { docId: (docId||'').slice(-8), afterFirstSave: v1, afterSecondSave: v2 };
    } catch (e) { out.caseB = { err: String(e).slice(0,200) }; }

    return JSON.stringify(out);
  })()`, 600000);

  console.log('\n=== history probe (' + SHELL + ') ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
