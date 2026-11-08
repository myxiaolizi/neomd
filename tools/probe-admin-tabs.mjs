/**
 * 复核「管理后台往返后标签页累积重复」。
 *
 * 来源：子代理 qt-qwen38max 在 2.2.0 Qt 上实测：
 *   3 个标签 -> 进 /admin -> 返回 /app -> 变成 5 个标签
 *   连续 3 次往返：7 -> 10 -> 13，每次 +2~3
 *   干净复现条件：≥2 个文档标签；router.push 与「返回编辑器」按钮两条路径都触发
 *   活动标签不重复，非活动标签重复；localStorage 不重复（说明是内存态恢复未去重）
 *
 * 这条如果成立，是**比窄窗溢出更严重**的用户可见缺陷：用户每次去后台看数据，
 * 回来就多出一堆重复标签，标签栏很快被垃圾占满。
 *
 * 本探针只关心一件事：往返之后 tags 数组长度是否增长、是否出现重复 id。
 * 用 CDP 直接驱动，不依赖任何被测壳的特有 API。
 *
 * Run: node tools/probe-admin-tabs.mjs 2.2.0 tauri
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'tauri';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe' },
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe' },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe' },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe' },
};
const spec = SHELLS[SHELL];
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\adm-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9755;
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
  async eval(expr, timeoutMs = 180000) {
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0, 300) });
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
  for (let i = 0; i < 70 && !origin; i++) {
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

  const cd = path.join(process.cwd(), `.tmp-adm-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'adm-'+Date.now()}) });
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
    const out = { steps: [] };
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ err: 'no app store' });
    for (let i = 0; i < 25 && (app.docs || []).length === 0; i++) await sleep(2000);

    const snap = (label) => {
      const tabs = app.tabs || [];
      const ids = tabs.map(t => t.id);
      const dupeIds = ids.filter((id, i) => ids.indexOf(id) !== i);
      const docIds = tabs.map(t => t.docId ?? t.meta?.docId).filter(Boolean);
      const dupeDocIds = docIds.filter((d, i) => docIds.indexOf(d) !== i);
      /*
       * lsTabs：localStorage 里持久化的标签列表。
       * 子代理说 localStorage 不重复、只有内存重复 —— 若属实，说明是
       * "从持久化恢复内存态时没去重"，修法在恢复逻辑而不是持久化逻辑。
       */
      let lsTabs = null;
      try {
        const raw = localStorage.getItem('neomd.tabs.v1') || localStorage.getItem('neomd.tabs');
        if (raw) { const j = JSON.parse(raw); lsTabs = Array.isArray(j) ? j.length : (Array.isArray(j?.tabs) ? j.tabs.length : null); }
      } catch {}
      return { label, count: tabs.length, ids, dupeIds, dupeDocIds, lsTabs,
        activeId: app.activeTabId };
    };

    // 先开 3 个文档标签，制造"≥2 个文档标签"的复现前提
    const docs = (app.docs || []).slice(0, 3);
    for (const d of docs) { await app.openDoc(d.docId); await sleep(1800); }
    out.steps.push(snap('打开 3 个文档后'));

    // 往返 1 次：/admin -> /app
    const roundTrip = async (tag) => {
      history.pushState({}, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(3000);
      const onAdmin = location.pathname;
      const adminTabs = (app.tabs || []).length;
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(3000);
      const backPath = location.pathname;
      out.steps.push({ ...snap(tag), onAdmin, adminTabs, backPath });
    };

    await roundTrip('往返 1 次后');
    await roundTrip('往返 2 次后');
    await roundTrip('往返 3 次后');

    const first = out.steps[0].count;
    const last = out.steps[out.steps.length - 1].count;
    out.summary = {
      initialTabs: first,
      finalTabs: last,
      grew: last > first,
      anyDupeIds: out.steps.some(s => (s.dupeIds || []).length > 0),
      anyDupeDocIds: out.steps.some(s => (s.dupeDocIds || []).length > 0),
      lsCounts: out.steps.map(s => s.lsTabs),
    };
    return JSON.stringify(out);
  })()`, 420000);

  console.log('\n=== admin round-trip tabs probe (' + SHELL + ') ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
