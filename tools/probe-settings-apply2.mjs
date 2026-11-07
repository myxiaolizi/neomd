/**
 * Settings genuinely applied? (round 2 — navigate the settings tab's own groups)
 *
 * Round 1 proved:
 *   - the settings tab DOES open (`.settings` present, 2 visible inputs)
 *   - appearance.fontSize is already 28, i.e. someone's earlier change persisted
 *   - but the font-size control was NOT in the currently shown group
 *     (only "实时预览" checkbox + naming template were rendered)
 * So the settings page is grouped by nav items, and the font control lives in
 * another group. Testing it requires clicking that nav item first.
 *
 * This probe clicks through the settings nav, finds the font-size control in
 * whichever group holds it, drives it with real input events, and then checks
 * store + localStorage + computed CSS.
 *
 * Run: node tools/probe-settings-apply2.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9665 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9666;
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
    const p = this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => ({ __timeout: true }))]);
    if (r.__timeout) return JSON.stringify({ __err: 'TIMEOUT' });
    if (r.result?.exceptionDetails) return JSON.stringify({ __err: r.result.exceptionDetails.text, d: r.result.exceptionDetails.exception?.description?.slice(0,300) });
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
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(path.join(dir, spec.exe), spec.args, { cwd: dir, env, stdio: 'ignore' });

  let origin = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    try {
      const b = path.join(dir, 'data', 'boot.json');
      if (fs.existsSync(b)) {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(fs.readFileSync(b, 'utf8'));
        if (m) { origin = m[1].replace(/\/$/, ''); break; }
      }
    } catch {}
  }
  console.log(`shell=${SHELL} origin=${origin}`);

  let cdp = null, ws = null;
  if (spec.dbg) {
    for (let i = 0; i < 30; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${spec.dbg}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) { ({ ws, cdp } = await connect(page.webSocketDebuggerUrl)); break; }
      } catch {}
      await sleep(700);
    }
  }
  if (!cdp) {
    const cd = path.join(process.cwd(), `.tmp-setapply2-${SHELL}`);
    fs.rmSync(cd, { recursive: true, force: true });
    spawn(CHROME, ['--remote-debugging-port=' + CDP_PORT, `--user-data-dir=${cd}`, '--headless=new',
      '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {} }
    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
    ({ ws, cdp } = await connect(t.webSocketDebuggerUrl));
  }
  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(6000);
  await cdp.send('Runtime.enable');

  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'setapply2-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 60000);
  await cdp.send('Page.reload');
  await sleep(20000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { groups: [], probes: [] };
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let st = null; for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
    out.beforeFontSize = st?.settings?.appearance?.fontSize ?? null;
    out.beforeTheme = st?.settings?.appearance?.theme ?? null;

    document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(2500);

    // walk every settings nav item and see which controls each group exposes
    const navs = Array.from(document.querySelectorAll('.settings__nav-item'));
    out.navCount = navs.length;
    let found = null;
    for (let i = 0; i < navs.length && i < 14; i++) {
      const nav = navs[i];
      const label = (nav.innerText || '').trim();
      nav.click();
      await sleep(1200);
      const nums = Array.from(document.querySelectorAll('.settings input[type="number"], .settings input[type="range"]'));
      out.groups.push({ label, numberControls: nums.length,
        names: nums.slice(0, 6).map(x => ({ type:x.type, v:x.value, min:x.min, max:x.max,
          aria: x.getAttribute('aria-label') || '',
          label:(x.closest('label, .settings__row, .settings__field, .field')?.innerText||'').slice(0,30) })) });
      /*
       * 字号控件的定位方式：它没有把文字放在 <label for> 里，而是用了
       * aria-label="编辑器正文字号"（SettingsPage.vue:2438）。
       * 前两轮按 label 文本匹配，所以 12 个分组全都没找到 —— 是探测方式的问题，
       * 不是控件缺失。这里按 aria-label 匹配，并保留 min/max=12/32 的兜底形状判断。
       */
      const fsEl = nums.find(x => /字号/i.test(x.getAttribute('aria-label') || ''))
        || nums.find(x => /字号|字体|font/i.test(x.closest('label, .settings__row, .settings__field, .field')?.innerText || ''))
        || nums.find(x => x.type === 'number' && Number(x.min) === 12 && Number(x.max) === 32);
      if (fsEl && !found) { found = { el: fsEl, group: label, aria: fsEl.getAttribute('aria-label') || '' }; }
    }

    if (!found) { out.ok = false; out.why = '所有分组都没有字号控件'; return JSON.stringify(out); }
    out.ok = true;
    out.fontGroup = found.group;

    const el = found.el;
    const before = Number(el.value);
    const target = before >= 24 ? before - 2 : before + 2;
    el.value = String(target);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(3000);

    out.apply = {
      controlBefore: before, target,
      storeAfter: st?.settings?.appearance?.fontSize ?? null,
      lsFontSize: (() => { try { return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}')?.appearance?.fontSize ?? null; } catch { return null; } })(),
      computed: (() => {
        const node = document.querySelector('.ProseMirror, .cm-content, .shell__content, .nm-content');
        return node ? getComputedStyle(node).fontSize : null;
      })(),
    };
    out.apply.storeChanged = out.apply.storeAfter !== out.beforeFontSize;
    out.apply.lsChanged = out.apply.lsFontSize === target;
    return JSON.stringify(out);
  })()`, 400000);

  console.log('\n=== settings apply trace (group walk) ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
