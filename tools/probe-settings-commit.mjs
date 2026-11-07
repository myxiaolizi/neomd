/**
 * Settings: does "改草稿 → 点保存 → 真正生效" work end to end?
 *
 * Findings so far (each step narrowed the question):
 *   1. Settings page opens fine (Ctrl+, -> tab present).
 *   2. There IS a font-size control: SettingsPage.vue:2432
 *      type=number min=12 max=32 aria-label="编辑器正文字号", in the 「编辑器」 group.
 *   3. Editing it does NOT immediately change the store — and that is BY DESIGN:
 *      patchAppearance() only writes draft.value and shows
 *      "草稿已更新，点「保存」生效" (SettingsPage.vue:426-430).
 *      A subagent read this as "设置无效", which is a misunderstanding.
 *
 * So the only real question left: does clicking 保存 actually commit the draft
 * to the store + localStorage? If yes, settings work and the earlier report was
 * a misdiagnosis. If no, that is a genuine "settings never apply" defect.
 *
 * Run: node tools/probe-settings-commit.mjs 2.2.0 qt
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.argv[2] ?? '2.2.0';
const SHELL = process.argv[3] ?? 'qt';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const SHELLS = {
  qt: { dir: `NeoMD-${VERSION}-qt-x64`, exe: 'NeoMD.exe', args: ['--no-sandbox'], dbg: 9667 },
  tauri: { dir: `NeoMD-${VERSION}-tauri-x64`, exe: 'NeoMD.exe', args: [] },
  winui3: { dir: `NeoMD-${VERSION}-winui3-x64`, exe: 'NeoMD.WinUI3.exe', args: [] },
  flutter: { dir: `NeoMD-${VERSION}-flutter-x64`, exe: 'neomd_flutter.exe', args: [] },
  electron: { dir: `NeoMD-${VERSION}-electron-x64`, exe: 'Neo MD.exe', args: [] },
};
const spec = SHELLS[SHELL];
const dir = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9668;
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
    const cd = path.join(process.cwd(), `.tmp-setcommit-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'setcommit-'+Date.now()}) });
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
    const out = {};
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let st = null; for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
    const ls = () => { try { return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}'); } catch { return {}; } };

    out.before = { storeFontSize: st?.settings?.appearance?.fontSize ?? null, lsFontSize: ls()?.appearance?.fontSize ?? null };

    // open settings
    document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(2500);

    // go to the group that holds the font control
    const navs = Array.from(document.querySelectorAll('.settings__nav-item'));
    for (const n of navs) { if (/编辑器/.test(n.innerText || '')) { n.click(); await sleep(1200); break; } }

    // locate the font-size control by its aria-label
    const el = Array.from(document.querySelectorAll('.settings input[type="number"]'))
      .find(x => /字号/.test(x.getAttribute('aria-label') || ''));
    if (!el) return JSON.stringify({ ok:false, why:'找不到 aria-label 含「字号」的输入框', ...out });

    const from = Number(el.value);
    const to = from >= 26 ? from - 2 : from + 2;
    out.control = { aria: el.getAttribute('aria-label'), from, to, min: el.min, max: el.max };

    // type the new value (real user interaction)
    el.focus();
    el.value = String(to);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);
    out.afterEditDraft = { storeFontSize: st?.settings?.appearance?.fontSize ?? null, lsFontSize: ls()?.appearance?.fontSize ?? null };

    // find and click the 保存 button inside the settings savebar
    const btns = Array.from(document.querySelectorAll('.settings-savebar button, .settings-savebar__actions button'));
    out.saveButtons = btns.map(b => (b.innerText || '').trim().slice(0, 12));
    const saveBtn = btns.find(b => /^保存$|^保存$|保存设置|保存并/.test((b.innerText || '').trim())) || btns.find(b => /保存/.test(b.innerText || ''));
    if (!saveBtn) return JSON.stringify({ ok:false, why:'找不到保存按钮', ...out });

    saveBtn.click();
    await sleep(6000);

    out.afterSave = {
      storeFontSize: st?.settings?.appearance?.fontSize ?? null,
      lsFontSize: ls()?.appearance?.fontSize ?? null,
      saveMessage: (document.querySelector('.settings-savebar__state, .settings-page__hint')?.innerText || '').slice(0, 80),
    };
    out.ok = true;
    out.effective = out.afterSave.storeFontSize === to;
    return JSON.stringify(out);
  })()`, 400000);

  console.log('\n=== settings commit trace ===');
  try { console.log(JSON.stringify(JSON.parse(res), null, 2)); } catch { console.log(res); }

  if (ws) ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
