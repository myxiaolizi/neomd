/**
 * 定位 winui3 的同步为什么进入 error，以及历史版本为什么不增长。
 *
 * 已知：
 *   - winui3 验收三项失败：edit.save（同步态=error）、history.list、history.grow
 *   - qwen37plus 报相同的「历史版本」问题（保存后版本不增长）
 *   - deepseekv4pro 报 winui3 12/12 全过（那时还没这些问题）
 *   - 其他四壳同样代码，save/history 都正常
 *   => 高度怀疑是 winui3 副本的同步链路出了问题，而同步失败会让版本落不了盘
 *
 * 必须抓到真实错误文本，不能猜。本探针在网络层把失败的请求全部录下来：
 *   - 用 CDP Network 域监听 responseReceived / loadingFailed
 *   - 记录状态码、URL、以及 4xx/5xx 的响应体前若干字符
 *   - 同时读 app.syncState / app.syncError / storageConfigProblem
 *
 * Run: node tools/probe-winui3-sync.mjs 2.2.0 winui3
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
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\syncdiag-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9765;
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
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  return { ws, cdp };
}

(async () => {
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(2500);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 400 }); } catch {}
  try { execFileSync('robocopy', [SRC, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' }); }
  catch (e) { if (typeof e.status !== 'number' || e.status > 7) throw e; }
  for (const sub of ['vault', 'webengine', 'webview2', 'boot.json', 'chrome-cdp-tmp']) {
    fs.rmSync(path.join(dir, 'data', sub), { recursive: true, force: true });
  }

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

  const cd = path.join(process.cwd(), `.tmp-syncdiag-${SHELL}`);
  try { fs.rmSync(cd, { recursive: true, force: true }); } catch {}
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const { ws, cdp } = await connect(t.webSocketDebuggerUrl);

  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'syncdiag-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(25000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ err:'no app store' });
    for (let i = 0; i < 30 && (app.docs || []).length === 0; i++) await sleep(2000);

    const out = {
      docs: (app.docs || []).length,
      vaultId: (app.vault?.vaultId || '').slice(-8),
      vaultLocation: String(app.vaultLocation ?? ''),
      syncState: app.syncState,
      syncError: String(app.syncError ?? '').slice(0, 500),
      storageConfigProblem: String(app.storageConfigProblem ?? '').slice(0, 300),
    };

    // 存储相关设置（脱敏：只看有没有值，不输出值）
    try {
      const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      let settings = null;
      for (const [, s] of st) { if (s && typeof s === 'object' && s.settings) { settings = s; break; } }
      if (settings) {
        const cfg = settings.settings?.storage || {};
        out.storage = {
          hasBucket: !!cfg.bucket, hasEndpoint: !!cfg.endpoint,
          hasAk: !!cfg.accessKeyId, hasSk: !!cfg.accessKeySecret,
          bucketLen: (cfg.bucket || '').length,
        };
        const sec = settings.secrets || {};
        out.secrets = { hasKeyId: !!sec.storageKeyId, hasSecret: !!sec.storageSecret };
      }
    } catch (e) { out.settingsErr = String(e).slice(0, 100); }

    // 做一次保存，观察状态变化
    await app.createDoc({ title: 'syncdiag-' + Date.now(), content: '同步诊断基线' });
    await sleep(2500);
    const tabId = app.activeTabId;
    const tabNow = () => app.tabs?.find(t => t.id === tabId);
    const docId = tabNow()?.docId ?? tabNow()?.meta?.docId;
    out.docId = (docId || '').slice(-10);

    const snap = () => { const t2 = tabNow(); return { rev: t2?.rev, syncedRev: t2?.syncedRev, dirty: t2?.dirty, syncState: app.syncState }; };
    out.afterCreate = snap();

    app.updateTabContent?.(tabId, (tabNow()?.content ?? '') + '\\n\\nDIAG-' + Date.now());
    await sleep(800);
    await app.saveActiveTab?.();
    out.afterSaveImmediate = snap();

    for (let i = 0; i < 25; i++) {
      await sleep(4000);
      if (app.syncState === 'idle' || app.syncState === 'error') break;
    }
    out.afterWait = snap();
    out.syncErrorFinal = String(app.syncError ?? '').slice(0, 500);

    if (typeof app.listDocVersions === 'function' && docId) {
      try { const v = await app.listDocVersions(docId); out.versions = (v || []).length; } catch (e) { out.versionsErr = String(e).slice(0,100); }
    }
    return JSON.stringify(out);
  })()`, 600000);

  // 从 Network 事件里挑失败的请求
  const failed = [];
  for (const e of cdp.events) {
    if (e.method === 'Network.responseReceived') {
      const r = e.params.response;
      if (r.status >= 400) {
        failed.push({ status: r.status, url: r.url.slice(0, 160), type: e.params.type });
      }
    } else if (e.method === 'Network.loadingFailed') {
      failed.push({ error: String(e.params.errorText).slice(0, 80), type: e.params.type });
    }
  }
  const byStatus = {};
  for (const f of failed) { const k = f.status ?? f.error ?? '?'; byStatus[k] = (byStatus[k] || 0) + 1; }

  console.log('\n=== sync diagnosis (' + SHELL + ') ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }
  console.log('\n=== 失败请求统计 ===');
  console.log(JSON.stringify(byStatus, null, 2));
  console.log('\n=== 失败请求样例（前 12 条）===');
  for (const f of failed.slice(0, 12)) console.log(JSON.stringify(f));

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
