/**
 * 复核「窄窗时底部状态栏右侧控件溢出，整页横向滚动」。
 *
 * 来源：子代理 electron-glm53flash 在 2.2.0 Electron 上实测报告，
 * 称内容宽 ≲820px（含合法最小宽度 720px）时 statusbar 右侧控件溢出视口 98px，
 * 720px 实测 scrollWidth 818 > 720，整页出现横向滚动；984px 正常。
 *
 * 这条值得认真验，因为它符合"真实用户体验缺陷"的特征：
 * 窗口能拖到的最小宽度就是合法使用范围，在这个范围内出现横向滚动条是真问题。
 *
 * 本探针不依赖 Electron，直接驱动**外部 Chrome 连壳的 HTTP 端口**，
 * 在多个宽度下测量 documentElement.scrollWidth 与视口宽度，
 * 并定位到底是谁把宽度撑开了（找出溢出元素及其边界）。
 *
 * Run: node tools/probe-narrow-overflow.mjs 2.2.0 tauri
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
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', proto: true },
};
const spec = SHELLS[SHELL];
// 用副本，避免与并发测试抢端口和 data
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\narrow-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9751;
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
  // 准备干净副本
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  await sleep(2500);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  try {
    execFileSync('robocopy', [SRC, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' });
  } catch (e) { if (typeof e.status !== 'number' || e.status > 7) throw e; }
  // 清用户态但保留 flutter 运行时资产
  for (const sub of ['vault', 'webengine', 'webview2', 'boot.json', 'chrome-cdp-tmp']) {
    fs.rmSync(path.join(dir, 'data', sub), { recursive: true, force: true });
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args ?? [], { cwd: dir, env, stdio: 'ignore' });

  // 拿 origin
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
  console.log(`shell=${SHELL} origin=${origin}`);

  // 外部 Chrome
  const cd = path.join(process.cwd(), `.tmp-narrow-${SHELL}`);
  fs.rmSync(cd, { recursive: true, force: true });
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const { ws, cdp } = await connect(t.webSocketDebuggerUrl);

  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');

  // 登录并等同步
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'narrow-'+Date.now()}) });
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

  // 打开一个文档，让状态栏与正文都渲染出来
  await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    for (let i = 0; i < 25 && (app?.docs || []).length === 0; i++) await sleep(2000);
    const d = (app?.docs || [])[0];
    if (d) { await app.openDoc(d.docId); await sleep(3000); }
    return (app?.docs || []).length;
  })()`, 180000);

  const widths = [720, 760, 800, 820, 860, 920, 984, 1100, 1280];
  const out = [];
  for (const w of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1400);
    const r = await cdp.eval(`(() => {
      const de = document.documentElement;
      const vw = window.innerWidth;
      const over = {
        docScrollWidth: de.scrollWidth,
        docClientWidth: de.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        hOverflow: de.scrollWidth - vw,
      };
      // 找出所有右边界超出视口的元素，按超出量排序
      const bad = [];
      for (const el of document.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        const right = b.right;
        if (right > vw + 1) {
          const cls = (typeof el.className === 'string' ? el.className : '').trim().slice(0, 60);
          bad.push({ tag: el.tagName.toLowerCase(), cls, right: Math.round(right), w: Math.round(b.width), over: Math.round(right - vw) });
        }
      }
      bad.sort((a,b) => b.over - a.over);
      // 状态栏与缩放控件单独看一眼
      const sb = document.querySelector('.statusbar, .status-bar, [class*="statusbar"]');
      const zc = document.querySelector('[class*="zoomctl"], .zoomctl');
      return JSON.stringify({
        vw, ...over,
        statusbar: sb ? { right: Math.round(sb.getBoundingClientRect().right), w: Math.round(sb.getBoundingClientRect().width), cls: String(sb.className).slice(0,50) } : null,
        zoomctl: zc ? { right: Math.round(zc.getBoundingClientRect().right), w: Math.round(zc.getBoundingClientRect().width), cls: String(zc.className).slice(0,50) } : null,
        topOverflowers: bad.slice(0, 6),
        overflowCount: bad.length,
      });
    })()`);
    try { out.push({ width: w, ...JSON.parse(r) }); } catch { out.push({ width: w, raw: r }); }
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n=== narrow width overflow trace ===');
  for (const o of out) {
    const flag = o.hOverflow > 0 ? 'OVERFLOW' : 'ok';
    console.log(`${String(o.width).padStart(5)}px  vw=${o.vw}  docScrollW=${o.docScrollWidth}  overflow=${o.hOverflow}  ${flag}  offscreenEls=${o.overflowCount}`);
    if (o.topOverflowers?.length) {
      for (const b of o.topOverflowers.slice(0, 3)) {
        console.log(`          ${b.tag}.${b.cls} right=${b.right} w=${b.w} over=${b.over}`);
      }
    }
  }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(cd, { recursive: true, force: true });
  process.exit(0);
})();
