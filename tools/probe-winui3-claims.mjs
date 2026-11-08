/**
 * 裁决 winui3 报告里的两条指控，用可复现的判据而不是描述性文字。
 *
 * 待裁决：
 *   ① 「设置保存功能失效：改字号保存后 store 无变化」
 *      —— 但 tauri/qt/flutter 同代码同一项都 PASS，需确认 winui3 是否真的不同
 *   ② 「管理后台往返后 app 页面未加载」
 *      —— 需区分"真白屏"与"用户布局偏好导致正文区收起"（后者正文少但 DOM 完整）
 *
 * 判据（都取 DOM 结构而非正文长度）：
 *   设置链路：draft 阶段 store 不变（正确）-> 点保存 -> store 与 localStorage 同变
 *   后台往返：往返后 #app 子节点数、.shell__work DOM 长度、body.innerText 长度、
 *             未捕获异常数；三者都非零才算"没白屏"
 *
 * Run: node tools/probe-winui3-claims.mjs 2.2.0 winui3
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
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\claims-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9767;
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

  const cd = path.join(process.cwd(), `.tmp-claims-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'claims-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(24000);
  await cdp.send('Runtime.enable');

  // ===== 指控①：设置保存 =====
  const settings = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
    if (!pinia) return JSON.stringify({ ok:false, why:'no pinia' });
    let st = null;
    for (const [, s] of pinia._s) { if (s && typeof s === 'object' && s.settings) { st = s; break; } }
    if (!st) return JSON.stringify({ ok:false, why:'no settings store' });

    const out = { ok:true, storeFound: true };
    out.hasPatchAppearance = typeof st.patchAppearance === 'function';
    out.hasSaveDraft = typeof st.saveDraft === 'function';

    // 打开设置标签（Ctrl+, 的等价调用）
    try {
      const app = pinia._s.get('app');
      if (app?.openSettings) await app.openSettings();
      else {
        // 兜底：直接点按钮
        const btn = document.querySelector('[aria-label*="设置"], .topbar__btn--settings, [title*="设置"]');
        if (btn) btn.click();
      }
    } catch (e) { out.openSettingsErr = String(e).slice(0, 100); }
    await sleep(3000);

    out.settingsTabOpen = !!(document.querySelector('.settings, .settings-page, [class*="settings"]'));
    out.savebarPresent = !!document.querySelector('.settings-savebar');

    // 记录基线
    const before = st.settings?.appearance?.fontSize;
    out.beforeFontSize = before;
    out.beforeLs = (() => { try { const j = JSON.parse(localStorage.getItem('neomd.settings.v1')||'null'); return j?.appearance?.fontSize; } catch { return null; } })();

    // 走正式 UI：找字号输入框，改值
    let usedUi = false;
    const inp = document.querySelector('input[aria-label="编辑器正文字号"]');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, String((before ?? 16) === 20 ? 21 : 20));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      usedUi = true;
      await sleep(1500);
    }
    out.usedUiInput = usedUi;

    // 草稿阶段：store 应**不变**（两段式设计的正确行为）
    out.draftStage = { storeValue: st.settings?.appearance?.fontSize,
      lsValue: (() => { try { const j = JSON.parse(localStorage.getItem('neomd.settings.v1')||'null'); return j?.appearance?.fontSize; } catch { return null; } })() };

    // 点保存
    const saveBtn = document.querySelector('.settings-savebar button, .settings-savebar .btn--primary, .settings-savebar [class*="save"]');
    out.saveBtnFound = !!saveBtn;
    if (saveBtn) { saveBtn.click(); await sleep(3000); }

    out.afterSave = { storeValue: st.settings?.appearance?.fontSize,
      lsValue: (() => { try { const j = JSON.parse(localStorage.getItem('neomd.settings.v1')||'null'); return j?.appearance?.fontSize; } catch { return null; } })() };

    out.verdict = {
      draftDidNotPersist: out.draftStage.storeValue === before,
      savedChangedStore: out.afterSave.storeValue !== before,
      savedChangedLs: out.afterSave.lsValue !== before,
    };
    return JSON.stringify(out);
  })()`, 300000);
  console.log('\n=== 指控① 设置保存 ===');
  try { console.log(JSON.stringify(JSON.parse(settings), null, 2)); } catch { console.log(settings); }

  // ===== 指控②：管理后台往返是否白屏 =====
  const admin = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
    const app = pinia._s.get('app');

    const measure = () => {
      const root = document.querySelector('#app');
      const work = document.querySelector('.shell__work');
      return {
        path: location.pathname,
        appChildren: root ? root.children.length : -1,
        appHtmlLen: root ? root.innerHTML.length : -1,
        workHtmlLen: work ? work.innerHTML.length : 0,
        workExists: !!work,
        textLen: (document.body.innerText || '').length,
        shellExists: !!document.querySelector('.shell'),
      };
    };

    const out = {};
    // 先确保在 /app 且有文档标签
    const docTab = (app?.tabs || []).find(t => t.docId || t.meta?.docId);
    if (docTab) { app.activeTabId = docTab.id; }
    await sleep(2000);
    out.before = measure();

    // 往返一次
    history.pushState({}, '', '/admin');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(4000);
    out.inAdmin = measure();

    history.pushState({}, '', '/app');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(5000);
    out.backToApp = measure();

    // 再往返两次（累计 3 次，与原缺陷条件一致）
    for (let i = 0; i < 2; i++) {
      history.pushState({}, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(3500);
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(4500);
    }
    out.after3 = measure();
    out.tabsAfter3 = (app?.tabs || []).length;

    // 判据：返回 /app 后必须有 shell 结构、DOM 有内容、文字非空
    out.verdict = {
      notBlank: out.after3.shellExists && out.after3.appHtmlLen > 5000 && out.after3.textLen > 20,
      adminNotBlank: out.inAdmin.appHtmlLen > 500,
    };
    return JSON.stringify(out);
  })()`, 300000);
  console.log('\n=== 指控② 管理后台往返 ===');
  try { console.log(JSON.stringify(JSON.parse(admin), null, 2)); } catch { console.log(admin); }

  const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  console.log(`\n=== 未捕获异常：${thrown.length} 个 ===`);
  for (const e of thrown.slice(0, 5)) {
    console.log(String(e.params?.exceptionDetails?.text ?? '').slice(0, 160));
  }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
