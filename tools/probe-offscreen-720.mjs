/**
 * 720px 宽时到底哪些元素越界？它们是被合理裁剪，还是真的点不到？
 *
 * 上一轮修复后 layout.narrow 报 offscreen=14 但 overflow=0。
 * 说明页面不再横向滚动（overflow:hidden 生效），但仍有一批元素右边界超出视口。
 * 这两种情况含义完全不同：
 *   - 越界但被 overflow:hidden 祖先裁剪、且属于纯信息展示  -> 可接受
 *   - 越界的是**可点击控件**（缩放/视图切换），用户点不到        -> 真缺陷
 * 不能靠数字猜，必须把这些元素打出来看。
 *
 * Run: node tools/probe-offscreen-720.mjs 2.2.0 tauri
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
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\offs-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9753;
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

  const cd = path.join(process.cwd(), `.tmp-offs-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'offs-'+Date.now()}) });
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
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 25 && (app?.docs || []).length === 0; i++) await sleep(2000);
    const d = (app?.docs || [])[0];
    if (d) { await app.openDoc(d.docId); await sleep(3000); }
    return 'ok';
  })()`, 180000);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(1600);

  const r = await cdp.eval(`(() => {
    const vw = window.innerWidth;
    const rows = [];
    for (const el of document.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.right <= vw + 1) continue;
      // 判断是否被某个 overflow 裁剪祖先裁掉
      let clippedBy = null;
      let p = el.parentElement;
      while (p) {
        const cs = getComputedStyle(p);
        if (cs.overflow !== 'visible' || cs.overflowX !== 'visible') {
          const pb = p.getBoundingClientRect();
          if (pb.right <= vw + 1) { clippedBy = (p.className || p.tagName).toString().slice(0, 40); break; }
        }
        p = p.parentElement;
      }
      const interactive = !!el.closest('button, a, input, select, [role="button"], .st, [tabindex]');
      rows.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').trim().slice(0, 55),
        right: Math.round(b.right), w: Math.round(b.width), over: Math.round(b.right - vw),
        clippedBy, interactive,
        text: (el.innerText || '').trim().slice(0, 22),
      });
    }
    rows.sort((a,b) => b.over - a.over);
    // 关键：状态栏右侧控件的可达性
    const zc = document.querySelector('.zoomctl, [class*="zoomctl"]');
    const zcR = zc ? Math.round(zc.getBoundingClientRect().right) : null;
    return JSON.stringify({ vw, count: rows.length,
      interactiveOffscreen: rows.filter(r => r.interactive && !r.clippedBy).length,
      clippedInteractive: rows.filter(r => r.interactive && r.clippedBy).length,
      zoomctlRight: zcR, zoomctlReachable: zcR === null ? null : zcR <= vw,
      rows: rows.slice(0, 16) });
  })()`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n=== offscreen @720px ===');
  try {
    const o = JSON.parse(r);
    console.log(JSON.stringify(o, null, 2));
  } catch { console.log(r); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
