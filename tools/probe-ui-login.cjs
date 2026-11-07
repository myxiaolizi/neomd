/**
 * Real UI login path verification (click the form, do not call the API directly).
 *
 * Background: the Qt verifier reported that after filling admin/6655 on /login
 * and submitting, localStorage never received a token -- yet calling
 * /api/auth/login over raw HTTP through the same shell works fine.
 * We must decide whether the front-end login button is broken, or whether the
 * automation simply targeted the wrong element.
 *
 * This script does three things over CDP:
 * 1. Locate the real account/password inputs and submit button on /login.
 * 2. Fill them and dispatch a real mouse click at the button centre.
 * 3. Read localStorage afterwards to see whether neomd.access appeared.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const DIR = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0\\NeoMD-2.1.0-qt-x64';
const EXE = path.join(DIR, 'NeoMD.exe');
const CDP = 9503;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kill = () => {
  try {
    execSync('taskkill /F /IM NeoMD.exe /T', { stdio: 'ignore' });
  } catch {}
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.wait = new Map();
    this.logs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) {
        this.wait.get(m.id)(m);
        this.wait.delete(m.id);
      } else if (m.method) this.logs.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.wait.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

(async () => {
  kill();
  await sleep(3000);
  /*
   * QtWebEngine ignores the Chromium `--remote-debugging-port` flag.
   * It only opens a DevTools endpoint when the
   * QTWEBENGINE_REMOTE_DEBUGGING environment variable is set to a port.
   */
  const childEnv = { ...process.env, QTWEBENGINE_REMOTE_DEBUGGING: String(CDP) };
  const proc = spawn(EXE, ['--no-sandbox'], {
    cwd: DIR,
    env: childEnv,
    stdio: 'ignore',
  });

  let port = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      const b = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'boot.json'), 'utf8'));
      const m = /:(\d+)\//.exec(b.url || '');
      if (m) {
        port = Number(m[1]);
        break;
      }
    } catch {}
  }
  if (!port) {
    console.log('NO PORT');
    kill();
    process.exit(1);
  }
  console.log('shell port =', port);

  let target = null;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      // Qt's CDP page list may not carry a 127.0.0.1 url, so accept any page.
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!target) {
    console.log('NO TARGET');
    kill();
    process.exit(1);
  }
  console.log('attached:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(6000);

  // Clear stored token and go to /login to simulate a first run.
  await cdp.eval("(() => { localStorage.clear(); location.href = '/login'; return 1; })()");
  await sleep(5000);

  const before = await cdp.eval(`JSON.stringify({
    path: location.pathname,
    token: !!localStorage.getItem('neomd.access'),
    inputs: [...document.querySelectorAll('input')].map(i => ({
      type: i.type, name: i.name, placeholder: i.placeholder, id: i.id, cls: i.className
    })),
    buttons: [...document.querySelectorAll('button')].map(b => ({
      text: (b.innerText||'').trim().slice(0,20), type: b.type, cls: b.className
    }))
  })`);
  console.log('\n=== /login DOM ===');
  try {
    console.log(JSON.stringify(JSON.parse(before), null, 2));
  } catch {
    console.log(before);
  }

  // Fill the form. Match on several likely attribute names, fall back to order.
  const filled = await cdp.eval(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const acc = inputs.find(i => /account|user|mail/i.test((i.name||'')+(i.placeholder||'')+(i.id||''))) || inputs[0];
    const pwd = inputs.find(i => i.type === 'password') || inputs[1];
    if (!acc || !pwd) return JSON.stringify({ ok:false });
    const set = (el, v) => {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(acc, 'admin');
    set(pwd, '6655');
    return JSON.stringify({ ok:true,
      acc: { name: acc.name, ph: acc.placeholder, val: acc.value },
      pwd: { name: pwd.name, val: pwd.value.length }
    });
  })()`);
  console.log('\n=== filled ===');
  console.log(filled);

  // Click the real submit button by centre coordinates.
  /*
   * Careful: every <button> on this page renders with type="submit" (a real front-end
   * defect we noted separately), so matching on type submit would hit the brand logo.
   * Match the visible label instead: the primary submit carries .card__submit.
   */
  const btnBox = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const submit = document.querySelector('button.card__submit')
      || btns.find(b => /^\\s*(sign\\s*in|login)\\s*$/i.test(b.innerText||''))
      || btns.find(b => b.classList.contains('nm-btn--primary'));
    if (!submit) return JSON.stringify({ ok:false, count: btns.length });
    const r = submit.getBoundingClientRect();
    return JSON.stringify({ ok:true, text: (submit.innerText||'').trim(), x: r.x + r.width/2, y: r.y + r.height/2 });
  })()`);
  const box = JSON.parse(btnBox);
  console.log('\n=== submit button ===');
  console.log(box);

  if (box.ok) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
  }

  let after = null;
  for (let i = 0; i < 24; i++) {
    await sleep(1200);
    after = await cdp.eval(`JSON.stringify({
      path: location.pathname,
      token: !!localStorage.getItem('neomd.access'),
      tokenLen: (localStorage.getItem('neomd.access')||'').length,
      bodyText: (document.body.innerText||'').trim().slice(0, 240)
    })`);
    try {
      if (JSON.parse(after).token) break;
    } catch {}
  }
  console.log('\n=== after real UI login ===');
  console.log(after);

  console.log('\n=== console errors ===');
  for (const l of cdp.logs.filter((x) => x.method === 'Runtime.consoleAPICalled' && x.params?.type === 'error')) {
    console.log('  ', (l.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  for (const l of cdp.logs.filter((x) => x.method === 'Runtime.exceptionThrown')) {
    console.log('  EXC', l.params?.exceptionDetails?.text);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const out = 'C:\\Data\\BAC\\neomd\\neomd-V1\\reports\\model-verify\\qt-ui-login-probe.png';
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('\nscreenshot:', out);
  }

  ws.close();
  kill();
  process.exit(0);
})();
