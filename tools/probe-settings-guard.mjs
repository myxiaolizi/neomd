/**
 * 验证 settings action 的入参防护是否真的挡住了脏数据。
 *
 * 缺陷来源：flutter 壳实测（qwen3.8-max）报 updateAppearance 无入参类型校验，
 * 传字符串 'dark' 会被 Object.assign/展开变成索引键，appearance 里出现
 * "0":"d","1":"a","2":"r","3":"k" 并持久化到 localStorage['neomd.settings.v1']。
 *
 * 本探针直接调这些 action 传错误类型，然后检查：
 *   1. appearance / layout 里是否出现数字键（0/1/2/3）
 *   2. localStorage 里是否被写入脏数据
 *   3. 正常对象调用是否仍然生效（不能因为加了防护把正常路径也挡住）
 *
 * Run: node tools/probe-settings-guard.mjs 2.2.0 tauri
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
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\guard-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9757;
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

  const cd = path.join(process.cwd(), `.tmp-guard-${SHELL}`);
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
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'guard-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(16000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
    if (!pinia) return JSON.stringify({ err: 'no pinia' });
    const all = pinia._s;
    // 找设置 store（含 appearance/settings 键的那个）
    let st = null, stName = null;
    for (const [name, store] of all) {
      if (store && typeof store === 'object' && (store.settings || store.updateAppearance)) {
        st = store; stName = name; break;
      }
    }
    if (!st) return JSON.stringify({ err: 'no settings store', names: [...all.keys()].slice(0, 20) });

    const hasUpdateAppearance = typeof st.updateAppearance === 'function';
    const hasUpdateLayout = typeof st.updateLayout === 'function';
    const digitKeys = (obj) => Object.keys(obj || {}).filter(k => /^\\d+$/.test(k));

    const out = { storeName: stName, hasUpdateAppearance, hasUpdateLayout, cases: [] };

    // 基线：记录正常值，供最后确认没被污染
    out.baseline = {
      appearanceDigits: digitKeys(st.settings?.appearance),
      layoutDigits: digitKeys(st.settings?.layout),
      theme: st.settings?.appearance?.theme,
    };

    const lsName = 'neomd.settings.v1';
    const lsDigits = () => {
      try {
        const raw = localStorage.getItem(lsName);
        if (!raw) return { absent: true };
        const j = JSON.parse(raw);
        return {
          appearanceDigits: digitKeys(j?.appearance),
          layoutDigits: digitKeys(j?.layout),
        };
      } catch (e) { return { parseError: String(e).slice(0, 60) }; }
    };

    // ---- 1. 传字符串（原缺陷场景）----
    if (hasUpdateAppearance) {
      try { st.updateAppearance('dark'); } catch (e) { out.cases.push({ case: 'string->updateAppearance', threw: String(e).slice(0,80) }); }
      await sleep(800);
      out.cases.push({ case: 'string->updateAppearance',
        appearanceDigits: digitKeys(st.settings?.appearance),
        themeUnchanged: st.settings?.appearance?.theme === out.baseline.theme,
        ls: lsDigits() });
    }

    // ---- 2. 传数组 ----
    if (hasUpdateAppearance) {
      try { st.updateAppearance(['x','y']); } catch (e) { /* ignore */ }
      await sleep(800);
      out.cases.push({ case: 'array->updateAppearance',
        appearanceDigits: digitKeys(st.settings?.appearance), ls: lsDigits() });
    }

    // ---- 3. 传 null ----
    if (hasUpdateAppearance) {
      try { st.updateAppearance(null); } catch (e) { /* ignore */ }
      await sleep(500);
      out.cases.push({ case: 'null->updateAppearance',
        appearanceDigits: digitKeys(st.settings?.appearance), ls: lsDigits() });
    }

    // ---- 4. updateLayout 传字符串 ----
    if (hasUpdateLayout) {
      try { st.updateLayout('narrow'); } catch (e) { /* ignore */ }
      await sleep(800);
      out.cases.push({ case: 'string->updateLayout',
        layoutDigits: digitKeys(st.settings?.layout), ls: lsDigits() });
    }

    // ---- 5. 正常对象必须仍然生效（防止防护过头）----
    if (hasUpdateAppearance) {
      const before = st.settings?.appearance?.fontSize;
      st.updateAppearance({ fontSize: (before ?? 16) === 17 ? 16 : 17 });
      await sleep(900);
      out.cases.push({ case: 'normal-object->updateAppearance',
        before, after: st.settings?.appearance?.fontSize,
        applied: st.settings?.appearance?.fontSize !== before,
        appearanceDigits: digitKeys(st.settings?.appearance) });
    }

    out.finalLs = lsDigits();
    out.verdict = {
      noDigitsInAppearance: out.cases.every(c => !c.appearanceDigits || c.appearanceDigits.length === 0),
      noDigitsInLayout: out.cases.every(c => !c.layoutDigits || c.layoutDigits.length === 0),
      noDigitsInLs: !(out.finalLs?.appearanceDigits?.length || out.finalLs?.layoutDigits?.length),
      normalPathWorks: out.cases.some(c => c.case === 'normal-object->updateAppearance' && c.applied === true),
    };
    return JSON.stringify(out);
  })()`, 240000);

  console.log('\n=== settings guard probe (' + SHELL + ') ===');
  try {
    const o = JSON.parse(res);
    console.log(JSON.stringify(o, null, 2));
    const v = o.verdict ?? {};
    const ok = v.noDigitsInAppearance && v.noDigitsInLayout && v.noDigitsInLs && v.normalPathWorks;
    console.log('\nRESULT: ' + (ok ? 'PASS 脏数据被挡住且正常路径生效' : 'FAIL ' + JSON.stringify(v)));
  } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
