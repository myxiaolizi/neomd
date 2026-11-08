/**
 * 查清 winui3 验收里那三条失败的真因：是产品缺陷还是副本残留配置。
 *
 * 失败现象：
 *   edit.save  -> 同步态=error，提示"对象存储配置不完整：缺少 AccessKey ID 或 Secret"
 *   history.list -> 历史对象 1 个 / 正文对象 0 个
 *   history.grow -> 保存后版本数未增加（0 -> 0）
 *
 * 这三条都指向同一件事：云端保存没成功。提示里已经写明原因是
 * "对象存储配置不完整"，而正确配置下同步会"改用平台存储"——
 * 也就是说这是个**无效的残留配置**在阻挠保存，不是保存逻辑坏了。
 *
 * 关键问题：这个残留配置是哪来的？
 * 副本是从 releases 复制的，若 releases 的 localStorage 里就存着这份
 * 半截配置（之前的测试者填过又没填完），那所有基于该副本的测试都会失败，
 * 属于环境问题；若在干净 profile 下也会出现，才是产品缺陷。
 *
 * 本探针做两件事：
 *   A. 读出当前 localStorage 里的 storage/server 配置，确认它确实半截
 *   B. 清掉它，再走一次保存，看同步是否恢复正常 —— 恢复即证明是残留配置
 *
 * Run: node tools/probe-storage-config-pollution.mjs 2.2.0 winui3
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'winui3';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe' },
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe' },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe' },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe' },
};
const spec = SHELLS[SHELL];
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\poll-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9761;
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
  await sleep(2500);
  // 从 releases 原样复制（**不清 webview2**）——正是为了复现"残留配置"这一现象
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 400 }); } catch {}
  try { execFileSync('robocopy', [SRC, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' }); }
  catch (e) { if (typeof e.status !== 'number' || e.status > 7) throw e; }
  console.log(`copied releases -> ${dir} (webview2/localStorage 原样保留)`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args ?? [], { cwd: dir, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 80 && !origin; i++) {
    await sleep(700);
    try {
      const b = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(b)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(b, 'utf8'));
        if (m) origin = m[1].replace(/\/$/, '');
      }
    } catch {}
  }
  console.log(`origin=${origin}`);

  const cd = path.join(process.cwd(), `.tmp-poll-${SHELL}`);
  try { fs.rmSync(cd, { recursive: true, force: true }); } catch {}
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const { ws, cdp } = await connect(t.webSocketDebuggerUrl);

  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);
  await cdp.send('Runtime.enable');

  // ---- A. 读当前配置 ----
  const before = await cdp.eval(`(() => {
    const out = { keys: Object.keys(localStorage) };
    try {
      const j = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null');
      out.server = j?.server ?? null;
      out.storageRaw = j?.storage ?? null;
      out.topKeys = j ? Object.keys(j) : null;
    } catch (e) { out.parseError = String(e).slice(0, 80); }
    // 也看看有没有独立的对象存储键
    for (const k of out.keys) {
      if (/storage|s3|oss|cos/i.test(k)) {
        try { out[k] = (localStorage.getItem(k) || '').slice(0, 400); } catch {}
      }
    }
    return JSON.stringify(out);
  })()`);
  console.log('\n=== A. localStorage 里的存储配置 ===');
  let bj = {};
  try { bj = JSON.parse(before); console.log(JSON.stringify(bj, null, 2)); } catch { console.log(before); }

  // ---- 登录 + 观察同步态 ----
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'poll-'+Date.now()}) });
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

  const applyPath = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 25 && (app?.docs || []).length === 0; i++) await sleep(2000);
    return JSON.stringify({ docs: (app?.docs || []).length, syncState: app?.syncState,
      syncError: String(app?.syncError ?? '').slice(0, 300) });
  })()`, 240000);
  console.log('\n=== B. 登录后同步态（未清理配置）===');
  console.log(applyPath);

  // ---- C. 清掉无效对象存储配置，只留 server 里的常规字段 ----
  const cleaned = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const raw = localStorage.getItem('neomd.settings.v1');
    if (!raw) return JSON.stringify({ ok:false, why:'no settings key' });
    const j = JSON.parse(raw);
    const removed = [];
    if (j.storage) { removed.push('storage'); delete j.storage; }
    if (j.server) {
      // 保留 mode/customBaseUrl/privacyMode，删掉一切对象存储相关字段
      for (const k of Object.keys(j.server)) {
        if (/access|secret|key|bucket|endpoint|region|s3|oss|cos|storage/i.test(k)) {
          removed.push('server.' + k); delete j.server[k];
        }
      }
    }
    localStorage.setItem('neomd.settings.v1', JSON.stringify(j));
    return JSON.stringify({ ok:true, removed });
  })()`);
  console.log('\n=== C. 清理动作 ===');
  console.log(cleaned);

  await cdp.send('Page.reload');
  await sleep(22000);
  await cdp.send('Runtime.enable');

  // ---- D. 清理后再保存一次，看同步能否成功 ----
  const after = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 25 && (app?.docs || []).length === 0; i++) await sleep(2000);
    const out = { docsBefore: (app?.docs || []).length, syncState: app?.syncState };

    await app.createDoc({ title: 'poll-clean-' + Date.now(), content: '清理配置后的保存测试' });
    await sleep(2500);
    const tabId = app.activeTabId;
    const tabNow = () => app.tabs?.find(t => t.id === tabId);
    const docId = tabNow()?.docId ?? tabNow()?.meta?.docId;
    out.docId = (docId || '').slice(-10);

    app.updateTabContent?.(tabId, (tabNow()?.content ?? '') + '\\n\\nPOLL-' + Date.now());
    await sleep(800);
    await app.saveActiveTab?.();
    // 等同步落地
    for (let i = 0; i < 20; i++) {
      await sleep(4000);
      if (app.syncState === 'idle') break;
    }
    out.syncStateAfter = app.syncState;
    out.syncError = String(app.syncError ?? '').slice(0, 300);
    const t2 = tabNow();
    out.tab = { rev: t2?.rev, syncedRev: t2?.syncedRev, dirty: t2?.dirty };
    if (typeof app.listDocVersions === 'function' && docId) {
      try { const v = await app.listDocVersions(docId); out.versions = (v || []).length; } catch (e) { out.versionsErr = String(e).slice(0,80); }
    }
    return JSON.stringify(out);
  })()`, 420000);
  console.log('\n=== D. 清理配置后重新保存 ===');
  try { console.log(JSON.stringify(JSON.parse(after), null, 2)); } catch { console.log(after); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
