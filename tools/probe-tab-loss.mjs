/**
 * 复核「管理后台往返后标签从 3 个变 2 个（丢失）」，判断是否是我修复引入的回归。
 *
 * 背景：
 *   我修「标签重复累积」的做法是 restoreTabs 里先清空 tabs 再按持久化重建。
 *   重建时对每个 docId 检查 `vault.value?.get(docId)`，不存在就 `continue`
 *   （原代码注释写的是"文档已被删除/改名 → 不复活幽灵标签"）。
 *
 *   子代理 qt-qwen37plus 报：3 个标签 -> 往返 -> 2 个，且 logo id 变了
 *   （证明走了重建），无重复。这与我修的「重复」是相反方向的问题。
 *
 * 怀疑根因：
 *   如果某个标签对应的文档**不在 vault 索引里**（例如刚创建、索引还没刷新，
 *   或者该文档属于另一个仓库），重建时就会被跳过 → 标签消失。
 *   我的验收脚本从 app.docs 里挑文档（一定在索引中），所以测不出来。
 *
 * 本探针刻意制造这个条件：
 *   A. 开 3 个来自索引的文档 -> 往返 -> 应仍为 3（基线）
 *   B. 新建一个文档（可能尚未进索引）-> 连同另外 2 个 -> 往返 -> 看是否丢
 *   C. 对每个标签检查 vault.get(docId) 是否存在，把"索引里没有的标签"点出来
 *
 * Run: node tools/probe-tab-loss.mjs 2.2.0 tauri
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
const dir = `C:\\Data\\BAC\\neomd\\.testcopy\\loss-${SHELL}`;
const SRC = path.join(RELEASE, spec.dir);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9763;
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

  const cd = path.join(process.cwd(), `.tmp-loss-${SHELL}`);
  try { fs.rmSync(cd, { recursive: true, force: true }); } catch {}
  spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${cd}`, '--headless=new',
    '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(400); try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(origin + '/')}`, { method: 'PUT' })).json();
  const { ws, cdp } = await connect(t.webSocketDebuggerUrl);

  await cdp.send('Page.navigate', { url: origin + '/' });
  await sleep(7000);
  await cdp.send('Runtime.enable');
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'loss-'+Date.now()}) });
    const j = await r.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
    }
    return 'ok';
  })()`, 90000);
  await cdp.send('Page.reload');
  await sleep(22000);
  await cdp.send('Runtime.enable');

  const res = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ err:'no app store' });
    for (let i = 0; i < 25 && (app.docs || []).length === 0; i++) await sleep(2000);

    const snap = () => {
      const tabs = app.tabs || [];
      return {
        count: tabs.length,
        tabs: tabs.map(t => {
          const docId = t.docId ?? t.meta?.docId ?? '';
          const inIndex = !!(app.vault?.get?.(docId));
          return { docId: docId.slice(-10), title: String(t.title ?? '').slice(0, 16), inIndex,
            isSettings: String(t.title ?? '') === '设置' || /^settings/i.test(String(docId)) };
        }),
      };
    };
    const roundTrip = async () => {
      history.pushState({}, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(3000);
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await sleep(3200);
    };

    const out = {};

    // ---- C. 先点出"当前已打开的标签里，有没有不在索引中的" ----
    out.initial = snap();
    out.initialNotInIndex = out.initial.tabs.filter(t => !t.inIndex && !t.isSettings);

    // ---- A. 3 个索引内文档 -> 往返 ----
    const opened = new Set((app.tabs || []).map(t => t.docId ?? t.meta?.docId).filter(Boolean));
    let added = 0;
    for (const d of (app.docs || [])) {
      if (added >= 3) break;
      if (opened.has(d.docId)) continue;
      await app.openDoc(d.docId);
      await sleep(1600); opened.add(d.docId); added += 1;
    }
    out.caseA_before = snap();
    await roundTrip();
    out.caseA_after = snap();

    // ---- B. 新建文档（可能还没进索引）+ 2 个索引内文档 -> 往返 ----
    const beforeCreate = (app.tabs || []).length;
    let created = null;
    try {
      const r = await app.createDoc({ title: 'loss-probe-' + Date.now(), content: 'x' });
      created = typeof r === 'string' ? r : (r?.docId ?? null);
    } catch (e) { out.createErr = String(e).slice(0, 120); }
    await sleep(2500);
    const activeTab = (app.tabs || []).find(x => x.id === app.activeTabId);
    const activeDocId = activeTab?.docId ?? activeTab?.meta?.docId ?? created;
    out.caseB_createdDocId = String(activeDocId ?? '').slice(-10);
    out.caseB_createdInIndex = !!(app.vault?.get?.(activeDocId));
    out.caseB_createdTabExists = !!(app.tabs || []).find(x => (x.docId ?? x.meta?.docId) === activeDocId);
    out.caseB_before = snap();

    await roundTrip();
    out.caseB_after = snap();

    out.verdict = {
      caseA_stable: out.caseA_after.count === out.caseA_before.count,
      caseB_stable: out.caseB_after.count === out.caseB_before.count,
      caseB_lostCount: out.caseB_before.count - out.caseB_after.count,
      // 关键：如果丢的那个正是"不在索引里"的文档，说明根因确认
      caseB_lostWasNotInIndex: (() => {
        const afterIds = new Set(out.caseB_after.tabs.map(t => t.docId));
        const lost = out.caseB_before.tabs.filter(t => !afterIds.has(t.docId) && !t.isSettings);
        return lost.map(t => ({ docId: t.docId, inIndex: t.inIndex }));
      })(),
    };
    return JSON.stringify(out);
  })()`, 600000);

  console.log('\n=== tab loss probe (' + SHELL + ') ===');
  try {
    const o = JSON.parse(res);
    console.log(JSON.stringify(o, null, 2));
    const v = o.verdict ?? {};
    console.log('\nRESULT:');
    console.log(`  场景A（索引内文档）: ${v.caseA_stable ? '稳定，未丢标签' : '**丢标签**'}`);
    console.log(`  场景B（含新建文档）: ${v.caseB_stable ? '稳定' : `**丢了 ${v.caseB_lostCount} 个**`}`);
    if (v.caseB_lostWasNotInIndex?.length) {
      console.log(`  丢失的标签: ${JSON.stringify(v.caseB_lostWasNotInIndex)}`);
      const notInIndex = v.caseB_lostWasNotInIndex.filter(x => x.inIndex === false);
      console.log(`  => 其中不在 vault 索引里的: ${notInIndex.length} 个 ${notInIndex.length ? '【根因确认：重建时被当成幽灵标签跳过】' : ''}`);
    }
  } catch { console.log(res); }

  ws.close();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${spec.exe}`, '/T'], { stdio: 'ignore' }); } catch {}
  process.exit(0);
})();
