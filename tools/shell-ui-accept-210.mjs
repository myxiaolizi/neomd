#!/usr/bin/env node
/**
 * 鍥涘３ UI 绾ч獙鏀舵祴璇曞彴锛圕DP 椹卞姩锛夈€? *
 * 鎬濊矾锛氬洓涓闈㈠３閮藉湪 127.0.0.1:<闅忔満绔彛> 涓婃墭绠″悓涓€浠?Web 搴旂敤锛? * 骞朵笖閮芥敞鍏ヤ簡 window.NeoMD銆傚洜姝ゆ垜鍙互锛? *   1. 鍚姩琚祴澹筹紙鎷垮埌瀹冪湡瀹炵殑鏈湴绔彛涓庡師鐢?bridge锛夛紱
 *   2. 鐢?Chrome/Edge 鐨?CDP 杩炲埌杩欎釜绔彛锛屾墽琛岀湡瀹?DOM 鎿嶄綔涓庢柇瑷€銆? *
 * 杩欐牱楠岃瘉鐨勬槸銆岃澹冲疄闄呮彁渚涚殑閭ｄ唤椤甸潰 + 璇ュ３鐨勫師鐢熸ˉ銆嶏紝
 * 鑰屼笉鏄殢渚垮紑涓祻瑙堝櫒娴?web 绔€斺€斿３涔嬮棿鐨勫樊寮傦紙bridge 瀹炵幇銆? * 娉ㄥ叆鏃舵満銆佷唬鐞嗚涓猴級閮戒細鐪熷疄鏆撮湶鍑烘潵銆? *
 * 鐢ㄦ硶锛? *   node tools/shell-ui-accept.mjs --shell tauri
 *   node tools/shell-ui-accept.mjs --all
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const ACCOUNT = { username: 'admin', password: '6655' };
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9455;

const SHELLS = [
  { name: 'tauri', dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe' },
  { name: 'qt', dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe' },
  { name: 'winui3', dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe' },
  { name: 'flutter', dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 鏋佺畝 CDP 瀹㈡埛绔紙Node 24 鑷甫 WebSocket锛?---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 杩炴帴澶辫触')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 瓒呮椂: ${method}`));
        }
      }, 45000);
    });
  }

  /** 鍦ㄩ〉闈㈤噷姹傚€硷紝杩斿洖 JS 鍊硷紙鑷姩 await Promise锛?*/
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval 澶辫触');
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ---------------- 澹崇敓鍛藉懆鏈?---------------- */

function killShell(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {
    /* 涓嶅湪璺?*/
  }
}

function listenPorts(pid) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || Number(f[4]) !== pid) continue;
      const p = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
      if (p) ports.add(p);
    }
    return [...ports];
  } catch {
    return [];
  }
}

function portFromBootJson(dir) {
  try {
    const p = path.join(dir, 'data', 'boot.json');
    if (!fs.existsSync(p)) return null;
    const m = /:(\d+)\//.exec(JSON.parse(fs.readFileSync(p, 'utf8'))?.url ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchText(port, p, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ctl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

/** 鍚姩澹冲苟杩斿洖鏈湴绔彛 */
async function startShell(shell) {
  const dir = path.join(RELEASE, shell.dir);
  const exePath = path.join(dir, shell.exe);
  if (!fs.existsSync(exePath)) throw new Error(`涓荤▼搴忎笉瀛樺湪锛?{exePath}`);

  killShell(shell.exe);
  await sleep(1500);
  try {
    fs.rmSync(path.join(dir, 'data', 'boot.json'), { force: true });
  } catch {
    /* ignore */
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exePath, [], { cwd: dir, env, stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const cands = new Set(listenPorts(proc.pid));
    const b = portFromBootJson(dir);
    if (b) cands.add(b);
    for (const p of cands) {
      try {
        const r = await fetchText(p, '/', 4000);
        if (r.status === 200 && /<html/i.test(r.text)) return { proc, port: p, dir };
      } catch {
        /* next */
      }
    }
    if (proc.exitCode !== null) throw new Error(`澹冲惎鍔ㄥ嵆閫€鍑猴紝exitCode=${proc.exitCode}`);
  }
  throw new Error('鏈兘鍦ㄨ秴鏃跺唴鎵惧埌澹崇殑鏈湴 HTTP 鏈嶅姟');
}

/* ---------------- 娴忚鍣紙CDP 椹卞姩琚祴绔彛锛?---------------- */

let chromeProc = null;

async function startChrome() {
  const userDir = path.join(process.cwd(), '.tmp-cdp-profile');
  fs.rmSync(userDir, { recursive: true, force: true });
  chromeProc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return JSON.parse(await r.text()).webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
  }
  throw new Error('Chrome CDP 鏈氨缁?);
}

/** 鎵撳紑涓€涓柊 page target 骞惰繛鎺?*/
async function newPage(url) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const cdp = await CDP.attach(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, targetId: t.id };
}

/* ---------------- 鏂█宸ュ叿 ---------------- */

function makeReport(shellName) {
  const checks = [];
  const push = (id, pass, detail) => {
    checks.push({ id, pass, detail });
    process.stdout.write(`  [${pass ? 'PASS' : 'FAIL'}] ${id.padEnd(22)} ${detail}\n`);
  };
  return { shellName, checks, push };
}

/* ---------------- 涓绘祦绋?---------------- */

const only = (() => {
  const i = process.argv.indexOf('--shell');
  return i > -1 ? process.argv[i + 1] : null;
})();
const shells = only ? SHELLS.filter((s) => s.name === only) : SHELLS;

const allReports = [];
await startChrome();
process.stdout.write('Chrome CDP 灏辩华\n');

for (const shell of shells) {
  process.stdout.write(`\n========== ${shell.name} ==========\n`);
  const rep = makeReport(shell.name);
  let proc = null;
  let cdp = null;

  try {
    const started = await startShell(shell);
    proc = started.proc;
    rep.push('shell.boot', true, `鏈湴鏈嶅姟 127.0.0.1:${started.port}`);

    const page = await newPage(`http://127.0.0.1:${started.port}/`);
    cdp = page.cdp;
    await sleep(3500);

    // 1. window.NeoMD 涓庤繍琛岀幆澧?    const env = await cdp.eval('JSON.stringify({ has: !!window.NeoMD, env: window.NeoMD?.env, ver: window.NeoMD?.version, keys: window.NeoMD ? Object.keys(window.NeoMD) : [] })');
    const eo = JSON.parse(env);
    rep.push('inject.desktop', eo.has && eo.env === 'desktop', `window.NeoMD.env=${eo.env} version=${eo.ver}`);

    // 2. 椤甸潰鏄惁鐪熺殑娓叉煋鍑哄唴瀹癸紙鐧藉睆妫€娴嬶級
    const bodyInfo = await cdp.eval('JSON.stringify({ textLen: (document.body.innerText||"").trim().length, appChildren: document.querySelector("#app")?.children.length ?? -1, title: document.title })');
    const bi = JSON.parse(bodyInfo);
    rep.push('render.nonblank', bi.textLen > 100 && bi.appChildren > 0, `姝ｆ枃 ${bi.textLen} 瀛楋紝#app 瀛愯妭鐐?${bi.appChildren}锛屾爣棰樸€?{bi.title}銆峘);

    // 3. 渚ц竟鏍?/ 缂栬緫鍣ㄩ鏋舵槸鍚﹀瓨鍦?    const skeleton = await cdp.eval(`JSON.stringify({
      sidebar: !!document.querySelector('.sidebar, .leftpanel, [class*="sidebar"], [class*="leftpanel"]'),
      tabbar: !!document.querySelector('[class*="tabbar"], .nm-tabs, [class*="tab-bar"]'),
      editor: !!document.querySelector('.wysiwyg, [class*="editor"], .ProseMirror, textarea'),
      classes: [...new Set([...document.querySelectorAll('[class]')].map(e=>e.className).filter(c=>typeof c==='string').flatMap(c=>c.split(/\\s+/)).filter(Boolean))].slice(0,60)
    })`);
    const sk = JSON.parse(skeleton);
    rep.push('ui.skeleton', sk.sidebar && sk.editor, `渚ц竟鏍?${sk.sidebar} 鏍囩鏍?${sk.tabbar} 缂栬緫鍣?${sk.editor}`);

    // 4. 鐧诲綍锛氳蛋鍓嶇鐪熷疄鐨?auth store 閾捐矾锛堝惈 deviceId銆乼oken 閿悕锛?    const loginResult = await cdp.eval(`(async () => {
      // 鍓嶇鐪熷疄閿悕锛歯eomd.access / neomd.refresh锛堣 apps/web/src/api/client.ts锛?      const TOKEN_KEY = 'neomd.access';
      const REFRESH_KEY = 'neomd.refresh';
      if (localStorage.getItem(TOKEN_KEY)) return JSON.stringify({ already: true, token: true });
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: ${JSON.stringify(ACCOUNT.username)}, password: ${JSON.stringify(ACCOUNT.password)}, deviceId: 'accept-' + Date.now() })
      });
      const j = await res.json();
      if (!res.ok || !j?.data?.accessToken) return JSON.stringify({ ok: false, status: res.status, body: JSON.stringify(j).slice(0,300) });
      localStorage.setItem(TOKEN_KEY, j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem(REFRESH_KEY, j.data.refreshToken);
      return JSON.stringify({ ok: true, token: true });
    })()`);
    const lo = JSON.parse(loginResult);
    rep.push('auth.login', lo.ok !== false && lo.token === true, lo.ok !== false ? `鐧诲綍鎴愬姛锛堝凡鍐欏叆 ${'neomd.access'}锛塦 : `鐧诲綍澶辫触锛?{lo.status} ${lo.body}`);

    // 5. 鐧诲綍鍚庡埛鏂帮紝纭浼氳瘽鎸佷箙鍖?+ 鍓嶇鐪熺殑鎷夊埌浠撳簱骞舵覆鏌撳嚭鏉?    await cdp.eval('location.reload()');
    await sleep(6000);
    const afterReload = await cdp.eval(`(async () => {
      const tok = localStorage.getItem('neomd.access') || '';
      const res = await fetch('/api/vaults', { headers: { authorization: 'Bearer ' + tok } });
      const j = await res.json().catch(()=>({}));
      const vaults = j?.data?.vaults ?? [];
      const txt = (document.body.innerText||'');
      return JSON.stringify({
        status: res.status, count: vaults.length,
        docs: vaults.reduce((a,v)=>a+(v.docCount||0),0),
        uid: document.body.innerText.includes('鏈櫥褰?) ? 'NOT_LOGGED' : 'LOGGED',
        empty: txt.includes('浠撳簱杩樻槸绌虹殑'),
        bodyLen: txt.trim().length
      });
    })()`);
    const ar = JSON.parse(afterReload);
    rep.push('sync.vaults', ar.status === 200 && ar.count > 0, `/api/vaults -> ${ar.status}锛屼粨搴?${ar.count} 涓€佹枃妗?${ar.docs} 绡嘸);
    // 鐧诲綍鎬佸湪 UI 涓婃槸鍚︾湡鐨勭敓鏁堬紙"鏈櫥褰? 瀛楁牱娑堝け锛?    rep.push('auth.persist', ar.uid === 'LOGGED', ar.uid === 'LOGGED' ? 'UI 宸叉樉绀虹櫥褰曟€? : 'UI 浠嶆樉绀恒€屾湭鐧诲綍銆嶁€斺€斾細璇濇湭鎭㈠');
    // 浠撳簱鍒楄〃鏄惁鐪熺殑娓叉煋鍑轰簯绔枃妗ｏ紙涓嶆槸"浠撳簱杩樻槸绌虹殑"锛?    rep.push('sync.render', ar.empty === false, ar.empty ? '宸︿晶浠嶆樉绀恒€屼粨搴撹繕鏄┖鐨勩€嶁€斺€斾簯绔?702 绡囨湭鎷夊彇鍒版湰鍦? : '宸︿晶宸叉覆鏌撲簯绔粨搴撳唴瀹?);

    // 6. 鍘熺敓妗ワ紙澹崇壒鏈夛級
    const bridge = await cdp.eval(`(async () => {
      const b = window.NeoMD?.bridge;
      if (!b) return JSON.stringify({ ok:false, reason:'no bridge' });
      try {
        const ud = await b.paths.userData();
        const ver = await b.app.version();
        return JSON.stringify({ ok:true, userData:String(ud).slice(0,120), version:ver });
      } catch (e) { return JSON.stringify({ ok:false, reason:String(e).slice(0,200) }); }
    })()`);
    const br = JSON.parse(bridge);
    rep.push('bridge.native', br.ok === true, br.ok ? `paths.userData=${br.userData} version=${br.version}` : `妗ヨ皟鐢ㄥけ璐ワ細${br.reason}`);

    // 7. 绠＄悊鍚庡彴鑳藉惁杩涘叆骞惰繑鍥炵紪杈戝櫒锛堢敤鎴锋姤鍛婄殑銆岃繘寰楀幓鍑轰笉鏉ャ€嶏級
    const adminNav = await cdp.eval(`(async () => {
      const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
      // 鐩存帴鐢ㄥ墠绔矾鐢辫烦杞紝妯℃嫙鐐瑰嚮銆岀鐞嗗悗鍙般€?      const before = location.pathname;
      history.pushState({}, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(2500);
      const onAdmin = location.pathname === '/admin';
      const textLen = (document.body.innerText||'').trim().length;
      // 鍐嶅皾璇曡繑鍥炵紪杈戝櫒
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(2500);
      const backEditor = location.pathname === '/app';
      const editorText = (document.body.innerText||'').trim().length;
      return JSON.stringify({ before, onAdmin, textLen, backEditor, editorText });
    })()`);
    const an = JSON.parse(adminNav);
    rep.push('nav.admin', an.onAdmin && an.textLen > 50, `杩涘叆 /admin锛?{an.onAdmin}锛堟鏂?${an.textLen} 瀛楋級`);
    rep.push('nav.backEditor', an.backEditor && an.editorText > 50, `杩斿洖 /app锛?{an.backEditor}锛堟鏂?${an.editorText} 瀛楋級`);

    // 8. 鎺у埗鍙伴敊璇敹闆?    const errs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    rep.push('console.clean', thrown.length === 0, `鏈崟鑾峰紓甯?${thrown.length} 涓紝console.error ${errs.length} 鏉);
  } catch (e) {
    rep.push('runner', false, `鎵ц寮傚父锛?{e.message}`);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      proc?.kill();
    } catch {
      /* ignore */
    }
    killShell(shell.exe);
    await sleep(1500);
    allReports.push(rep);
  }
}

try {
  chromeProc?.kill();
  execSync(`taskkill /F /PID ${chromeProc?.pid} /T`, { stdio: 'ignore' });
} catch {
  /* ignore */
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/shell-ui-accept.json', JSON.stringify({ at: new Date().toISOString(), reports: allReports }, null, 2));

process.stdout.write('\n===== 姹囨€?=====\n');
for (const r of allReports) {
  const p = r.checks.filter((c) => c.pass).length;
  const failed = r.checks.filter((c) => !c.pass);
  process.stdout.write(`${r.shellName.padEnd(9)} ${p}/${r.checks.length} 閫氳繃`);
  if (failed.length) process.stdout.write(`  澶辫触锛?{failed.map((f) => f.id).join(',')}`);
  process.stdout.write('\n');
}
process.stdout.write('\n缁撴灉锛歳eports/shell-ui-accept.json\n');

