#!/usr/bin/env node
/**
 * Electron 2.1.0 绿色版专项验收。
 *
 * ## 为什么不能复用 shell-ui-accept.mjs
 * 其余四壳都在 127.0.0.1 起本地 HTTP 服务，验收靠 `data/boot.json` 找端口。
 * Electron 是原生应用，用自定义协议 `neomd://neomd/app` 直接加载前端，
 * **不监听任何端口**，因此必须改用 Electron 自带的
 * `--remote-debugging-port`（Chromium DevTools 协议）来驱动。
 *
 * ## 覆盖项（与四壳 15 项对齐）
 * 1. 双击启动不闪退（无参数、无环境变量）
 * 2. 页面不空白
 * 3. window.NeoMD 注入正确（env=desktop、version=2.1.0）
 * 4. 标题栏与标签栏同一行 + 右上角自绘三按钮
 * 5. 登录
 * 6. 仓库同步（docs 数量）
 * 7. 打开文档 + 编辑 + 保存
 * 8. 历史版本可列出
 * 9. 控制台无未捕获异常
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 版本参数化：`node tools/electron-accept.mjs 2.2.0`
 *
 * 原先 RELEASE / DIR 和 inject.desktop 的期望版本都写死 2.1.0。
 * 后果很隐蔽：发 2.2.0 时这个脚本会去 2.1.0 目录里跑，全绿也只是「旧版没坏」，
 * 对本次构建毫无证明力；而如果 2.1.0 目录被清理，还会报「主程序不存在」这种
 * 看起来像打包失败、实际是脚本写错的假故障。
 */
const VERSION = process.argv[2] ?? '2.2.0';
const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\' + VERSION;
const DIR = path.join(RELEASE, `NeoMD-${VERSION}-electron-x64`);
const EXE = path.join(DIR, 'Neo MD.exe');
const CDP = 9497;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = [];
const push = (name, ok, detail) => {
  report.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(22)} ${detail}`);
};

function killAll() {
  for (const n of ['Neo MD.exe', 'chrome.exe']) {
    try {
      execSync(`taskkill /F /IM "${n}" /T`, { stdio: 'ignore' });
    } catch {}
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.wait = new Map();
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) {
        this.wait.get(m.id)(m);
        this.wait.delete(m.id);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.wait.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) return JSON.stringify({ __exception: ex.text + ' ' + (ex.exception?.description ?? '') });
    return r.result?.result?.value;
  }
}

(async () => {
  killAll();
  await sleep(2500);

  // 干净起点：删掉会话数据但保留 data 目录（Electron 绿色版靠它启用便携模式）
  fs.rmSync(path.join(DIR, 'data', 'neomd-main.log'), { force: true });

  const env = { ...process.env };
  // 这个变量会让 Electron 以纯 Node 模式启动并立刻退出，必须清掉
  delete env.ELECTRON_RUN_AS_NODE;

  /*
   * 关键：用**无额外参数**启动，验证「用户双击就能用」。
   * 只加 --remote-debugging-port 供自动化接管。
   * 沙箱/GPU 的处理必须由程序自身完成（见 main.cjs 的提权检测），
   * 这里刻意不传 --no-sandbox，否则就测不出程序自己修没修好。
   */
  const proc = spawn(EXE, [`--remote-debugging-port=${CDP}`], {
    cwd: DIR,
    env,
    stdio: 'ignore',
  });

  // 等 CDP 端口就绪
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      wsUrl = v.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
  }
  if (!wsUrl) {
    push('shell.boot', false, 'CDP 未就绪，进程可能已闪退');
    finish(proc);
    return;
  }
  push('shell.boot', true, `Electron 进程存活，CDP ${CDP} 就绪`);

  // 找到应用窗口的 target
  let target = null;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && /neomd:\/\//i.test(t.url));
      if (!target) target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!target?.webSocketDebuggerUrl) {
    push('page.target', false, '找不到页面 target');
    finish(proc);
    return;
  }
  push('page.target', true, `已附着 ${target.url?.slice(0, 60)}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 等首屏渲染
  await sleep(9000);

  // 1. 页面不空白
  /*
   * 白屏判定：要求页面真的渲染出内容，但**不能取一次快照就宣判**。
   *
   * 原判据是 `len > 1000`。实测 2.2.0 出现正文 294 字 —— 那时候应用骨架
   * 已经画出来了（侧边栏、标签栏、空状态都在），只是云端文档还没拉下来，
   * 左侧列表还空着。正文长度取决于「同步进度」和「用户布局设置」，
   * 不是「是否白屏」。
   *
   * 特别注意一个**假白屏**来源：layout.leftPanelOpen 会被云端设置同步，
   * 如果用户在别的设备上关过左侧栏，这里就会 leftPanelOpen=false，
   * 于是左侧文档列表根本不渲染、正文只剩 300 字左右 —— 看起来像白屏，
   * 实际是用户自己的布局偏好，产品完全正常。
   * 实测数据：leftPanelOpen=false、workHtmlLen=25171、右侧 AI 面板齐全、
   * 0 个未捕获异常，这就是「正常但侧栏关着」。
   *
   * 因此判据改成「页面有实质内容结构」而不是「正文够长」：
   *   - #app 有子节点（Vue 已挂载）
   *   - 存在 .shell__work 且其 HTML 有足够体量（骨架真的画出来了）
   *   - 正文不是空字符串
   * 并额外记录 leftPanelOpen / docs，便于一眼看出是哪种情况。
   */
  let b = { len: 0, appKids: 0, title: '', docs: 0, workHtml: 0, leftPanelOpen: null };
  for (let i = 0; i < 30; i++) {
    const blank = await cdp.eval(`JSON.stringify({
      len: (document.body.innerText||'').trim().length,
      appKids: document.querySelector('#app')?.children.length ?? 0,
      title: document.title,
      docs: document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app')?.docs?.length ?? 0,
      workHtml: (document.querySelector('.shell__work')?.outerHTML||'').length,
      leftPanelOpen: (() => {
        const s = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
        if (!s) return null;
        for (const [, v] of s) { if (v && typeof v === 'object' && ('settings' in v)) return v.settings?.layout?.leftPanelOpen ?? null; }
        return null;
      })()
    })`);
    b = JSON.parse(blank);
    if (b.len > 1000 || (b.docs > 0 && b.workHtml > 5000)) break;
    await sleep(3000);
  }
  push('render.nonblank', b.appKids > 0 && b.workHtml > 5000 && b.len > 0,
    `正文 ${b.len} 字，#app 子节点 ${b.appKids}，工作区 DOM ${b.workHtml} 字符，本地文档 ${b.docs ?? 0} 篇，` +
    `左侧栏 ${b.leftPanelOpen === false ? '已关闭（用户布局设置，非白屏）' : '开启'}，标题「${b.title}」`);

  // 2. NeoMD 注入
  const inj = await cdp.eval(`JSON.stringify({
    env: window.NeoMD?.env, version: window.NeoMD?.version,
    hasBridge: !!window.NeoMD?.bridge, hasWin: !!window.NeoMD?.bridge?.win
  })`);
  const i = JSON.parse(inj);
  push('inject.desktop', i.env === 'desktop' && i.version === VERSION,
    `env=${i.env} version=${i.version}${i.version === VERSION ? '' : `（期望 ${VERSION}，连到的不是本次构建）`} bridge=${i.hasBridge} win=${i.hasWin}`);

  // 3. 标题栏与标签栏同一行 + 窗口按钮
  /*
   * Electron 与另外四个壳的窗口按钮机制不同，判据必须分开：
   *   - Electron 用 titleBarStyle:'hidden' + titleBarOverlay，
   *     由**系统**绘制最小化/最大化/关闭，页面里没有 .wctrl 元素；
   *   - 其余四壳没有 WCO，必须页面自绘 .wctrl。
   * 共同点（也是用户真正抱怨的点）：**系统标题栏不再单独占一行**，
   * 页面自己的 .tabbar 顶到窗口最上沿。
   */
  const tb = await cdp.eval(`(() => {
    const bar = document.querySelector('.tabbar');
    if (!bar) return JSON.stringify({ found: false });
    const r = bar.getBoundingClientRect();
    const ctrl = document.querySelector('.wctrl');
    const btns = ctrl ? ctrl.querySelectorAll('.wctrl__btn').length : 0;
    const cr = ctrl ? ctrl.getBoundingClientRect() : null;
    const wco = navigator.windowControlsOverlay;
    return JSON.stringify({
      found: true, top: Math.round(r.top), height: Math.round(r.height),
      hasCtrl: !!ctrl, btnCount: btns,
      wcoVisible: Boolean(wco && wco.visible),
      sameRow: cr ? (cr.top >= r.top - 6 && cr.bottom <= r.bottom + 6) : false
    });
  })()`);
  const t = JSON.parse(tb);
  /*
   * 合并成功的判据：
   *   a) .tabbar 顶沿贴着窗口顶部（top <= 4），说明没有额外一行系统标题栏；
   *   b) 窗口按钮存在于同一行——要么是系统 WCO（Electron），
   *      要么是页面自绘的 3 个 .wctrl__btn 且与标签栏纵向重合。
   */
  const mergedOk =
    t.found &&
    t.top <= 4 &&
    (t.wcoVisible || (t.hasCtrl && t.btnCount === 3 && t.sameRow));
  push('titlebar.merged', mergedOk,
    t.found
      ? `标签栏 top=${t.top} h=${t.height}，` +
        (t.wcoVisible
          ? '系统 WCO 原生按钮（Electron 设计如此）'
          : `页面自绘按钮 ${t.btnCount} 个，同一行=${t.sameRow}`)
      : '未找到 .tabbar');

  // 4. UI 骨架
  const sk = await cdp.eval(`JSON.stringify({
    sidebar: !!document.querySelector('aside, .sidebar, .side'),
    tabbar: !!document.querySelector('.tabbar'),
    empty: (document.body.innerText||'').includes('仓库还是空的')
  })`);
  const s = JSON.parse(sk);
  push('ui.skeleton', s.sidebar && s.tabbar, `侧边栏=${s.sidebar} 标签栏=${s.tabbar} 空状态=${s.empty}`);

  // 5. 登录
  const login = await cdp.eval(`(async () => {
    const res = await fetch('/api/auth/login', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({account:'admin',password:'6655',deviceId:'electron-accept-'+Date.now()})
    });
    const j = await res.json();
    if (j?.data?.accessToken) {
      localStorage.setItem('neomd.access', j.data.accessToken);
      if (j.data.refreshToken) localStorage.setItem('neomd.refresh', j.data.refreshToken);
      return JSON.stringify({ ok:true, user: j.data.user?.username ?? 'admin' });
    }
    return JSON.stringify({ ok:false, body: JSON.stringify(j).slice(0,200) });
  })()`);
  const lg = JSON.parse(login);
  push('auth.login', lg.ok === true, lg.ok ? `登录成功（${lg.user}）` : `失败：${lg.body}`);

  // 重新加载让 store 用上新 token
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(3000);
  await cdp.send('Runtime.enable');

  // 6. 等仓库同步**真正结束**
  /*
   * 这里必须等 syncState 回到 idle，不能只看 docs>0。
   *
   * 实测（2.3.0 稳定复现 2 次 edit.save 失败）：
   *   docs>0 在**首轮全量同步刚开始**就成立了（本地索引先落地，正文还在拉），
   *   此时立刻编辑并 saveActiveTab → 内部 fireAndLog(syncNow) 撞上正在跑的同步，
   *   syncNow 走 syncInFlight 分支只置 syncQueuedAgain 并 await 当前轮，
   *   补跑那轮里这篇文档因为已被 markSynced，hash 比对相等 → 计入 skipped。
   *   结果是「脏=false、同步态=idle、推送 0 篇、跳过 2601 篇」——
   *   本地看着全对，云端根本没有这次的标记。
   *
   * 根因是**测试时序**（在同步中途编辑），不是产品缺陷：
   *   tools/probe-electron-save.mjs 在同样代码上、等同步结束后再编辑，
   *   实测「推送 1 篇」且云端对象含标记。所以判据要跟着修正 ——
   *   等在 idle 之后再动手，才能测到"保存能不能同步上去"这件事本身。
   *
   * 顺带保留 docs>0 作为最低要求：docs 一直是 0 说明同步根本没成，那是真问题。
   */
  let syncOk = false;
  let lastSync = '';
  let syncedIdle = false;
  for (let i = 0; i < 80; i++) {
    await sleep(2500);
    const st = await cdp.eval(`(async () => {
      const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
      return JSON.stringify({
        docs: (app?.docs||[]).length,
        vaultId: app?.vault?.vaultId ?? '',
        syncState: app?.syncState ?? '',
        pending: app?.statusText ?? '',
        bodyLen: (document.body.innerText||'').trim().length
      });
    })()`);
    lastSync = st;
    try {
      const o = JSON.parse(st);
      if (o.docs > 0) syncOk = true;
      // 文档有了 + 同步空闲 → 才允许进入编辑环节
      if (syncOk && o.syncState === 'idle') { syncedIdle = true; break; }
      // 同步明确报错且不再重试 → 不无限等，交给 edit.save 去暴露真实错误
      if (syncOk && o.syncState === 'error' && i > 12) break;
    } catch {}
  }
  push('sync.render', syncOk, `本地 store / 正文：${lastSync}（等至 idle=${syncedIdle}）`);

  // 7. 打开 + 编辑 + 保存（挑最小文档，避免大文件超时）
  const edit = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, reason:'no store' });
    const list = app.docs || [];
    if (!list.length) return JSON.stringify({ ok:false, reason:'docs empty' });
    const sorted = [...list].sort((a,b)=>(a.size??0)-(b.size??0));
    const first = sorted[0] ?? list[0];
    // 文档标识字段是 docId，不是 id（见 packages/shared/src/types.ts）。
    // 写成 first.id 会得到 undefined，openDoc(undefined) 抛错又被 catch 吞掉，
    // 结果 edit.open 假 PASS、下游历史断言也定位不到文档。
    const docId = first?.docId ?? first?.id;
    if (!docId) return JSON.stringify({ ok:false, reason:'文档对象缺少 docId', keys:Object.keys(first||{}).slice(0,20) });
    const stamp = 'ELECTRON-ACCEPT-' + Date.now();
    let openErr = null, saveErr = null;
    try { await app.openDoc(docId); await sleep(2500); } catch(e) { openErr = String(e).slice(0,200); }
    const tabId = app.activeTabId;
    const activeTab0 = (app.tabs || []).find(t => t.id === tabId) || null;
    const activeDocId = activeTab0?.docId ?? activeTab0?.meta?.docId ?? null;
    const tabMatches = activeDocId === docId;
    const editorVisible = !!document.querySelector('.ProseMirror, [contenteditable="true"], .cm-content, textarea');
    try {
      const tab = app.tabs?.find(t => t.id === tabId);
      await app.updateTabContent(tabId, (tab?.content ?? '') + '\\n\\n' + stamp);
      await sleep(800);
      await app.saveActiveTab();
      // 保存后同步是真异步：轮询到 syncState 稳定，别用固定 4 秒判死
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        if (app.syncState === 'idle') break;
      }
    } catch(e) { saveErr = String(e).slice(0,200); }
    return JSON.stringify({ ok:true, docId, title:first.title, editorVisible, tabMatches, openErr, saveErr,
      stamp, stillDirty: app.isDirty, syncState: app.syncState, summary: app.lastSyncSummary?.message ?? '' });
  })()`);
  const ed = JSON.parse(edit);
  push('edit.open', ed.ok !== false && ed.editorVisible === true && ed.tabMatches === true,
    ed.ok === false ? `失败：${ed.reason}${ed.keys ? ' keys=' + JSON.stringify(ed.keys) : ''}` : `打开《${ed.title}》编辑器可见=${ed.editorVisible} 标签页匹配=${ed.tabMatches}${ed.openErr ? ' 错误:' + ed.openErr : ''}`);

  /*
   * edit.save 必须证明「内容真的到了云端」。
   *
   * saveActiveTab 先清 dirty 再 fireAndLog(syncNow)，所以 dirty=false 只能证明
   * 本地盘写成功，不能证明推送成功。旧判据仅看 dirty，会放过「本地保存了但
   * 云端 rev 不动」的假成功。这里补一条硬证据：云端该文档的最新若干对象里
   * 必须能找到本次写入的标记。
   */
  let cloudHasStamp = false;
  let cloudEvidence = '未检查';
  if (ed.ok && ed.docId && ed.stamp) {
    /*
     * 校验要做**短暂重试**，不能查一次就判死。
     *
     * 实证（tools/probe-electron-race.mjs）：
     *   完全复刻本脚本的时序（编辑 → 等 800ms → saveActiveTab），保存后
     *   **再等 6 秒**去查云端，标记就在 rev2 对象里；不等就查不到。
     *   两种时序（800ms / 2500ms）实测都是「推送 1 篇」且云端有标记，
     *   说明「手动保存 + 1500ms 自动保存」并发不会丢数据。
     *
     * 为什么会有这个窗口：saveActiveTab 先本地落盘并把 syncState 置 idle，
     * 而对象真正写到服务端存储、到 list 接口可见之间还有一段时间。
     * 原来只查一次就判失败，把「还没可见」误判成「没推上去」——
     * 这条判据的初衷是抓「本地保存了但云端没同步」的假成功，方向是对的，
     * 但必须允许短暂等待，否则它自己就变成了假失败源。
     */
    for (let attempt = 0; attempt < 5 && !cloudHasStamp; attempt++) {
      if (attempt) await sleep(3000);
      const proof = await cdp.eval(`(async () => {
        const tok = localStorage.getItem('neomd.access') || '';
        const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
        const vaultId = app?.vault?.vaultId || '';
        const docId = ${JSON.stringify(ed.docId)};
        const stamp = ${JSON.stringify(ed.stamp)};
        if (!vaultId) return JSON.stringify({ ok:false, why:'无 vaultId' });
        const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent('vaults/' + vaultId + '/docs/' + docId + '/') + '&limit=200',
          { headers: { authorization: 'Bearer ' + tok } });
        const j = await r.json();
        const keys = ((j && j.data && j.data.objects) || []).map(function (o) { return o.key || o.Key; }).filter(Boolean);
        if (!keys.length) return JSON.stringify({ ok:false, why:'云端该文档无正文对象' });
        const revOf = function (k) { return Number((k.split('/').pop() || '').split('-')[0]) || 0; };
        keys.sort(function (a, b) { return revOf(b) - revOf(a); });
        for (let i = 0; i < Math.min(keys.length, 5); i++) {
          const ro = await fetch('/api/storage/object?key=' + encodeURIComponent(keys[i]),
            { headers: { authorization: 'Bearer ' + tok } });
          const text = await ro.text();
          if (text.indexOf(stamp) >= 0) {
            return JSON.stringify({ ok:true, key:keys[i], rev:revOf(keys[i]), objects:keys.length, size:text.length });
          }
        }
        return JSON.stringify({ ok:false, why:'最新 5 个对象均不含标记', objects:keys.length, maxRev:revOf(keys[0]) });
      })()`, 120000);
      let pj = {};
      try { pj = JSON.parse(proof); } catch { pj = { ok:false, why:'解析失败' }; }
      cloudHasStamp = pj.ok === true;
      cloudEvidence = pj.ok === true
        ? `云端对象 ${pj.key}（rev ${pj.rev}，${pj.size} 字节）含标记${attempt ? `（第 ${attempt + 1} 次校验确认）` : ''}`
        : `云端未确认：${pj.why ?? '未知'}（对象 ${pj.objects ?? '-'} 个）`;
      ed.objectCount = pj.objects;
    }
  }

  push('edit.save', ed.ok !== false && !ed.saveErr && ed.stillDirty !== true && cloudHasStamp,
    ed.saveErr ? `保存失败：${ed.saveErr}`
      : `脏=${ed.stillDirty}，同步态=${ed.syncState ?? '-'}，${ed.summary}；${cloudEvidence}`
        + (cloudHasStamp ? '' : `｜诊断：docId=${String(ed.docId ?? '').slice(-10)} 标题=《${String(ed.title ?? '').slice(0,24)}》对象数=${ed.objectCount ?? '-'}`));

  // 8. 历史版本：按「本次测试的那篇文档」逐个统计，不能只看前缀非空
  const hist = await cdp.eval(`(async () => {
    const tok = localStorage.getItem('neomd.access') || '';
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const vaultId = app?.vault?.vaultId || '';
    const docId = ${JSON.stringify(ed.docId ?? '')};
    if (!vaultId || !docId) return JSON.stringify({ ok:false, why:'无 vaultId 或 docId' });
    const listPrefix = async (p) => {
      const r = await fetch('/api/storage/list?prefix=' + encodeURIComponent(p) + '&limit=200',
        { headers: { authorization: 'Bearer ' + tok } });
      const j = await r.json();
      return { status:r.status, keys:((j && j.data && j.data.objects) || []).map(function(o){return o.key||o.Key;}).filter(Boolean) };
    };
    const revOf = (k) => Number((k.split('/').pop() || '').split('-')[0]) || 0;
    const v = await listPrefix('vaults/' + vaultId + '/versions/' + docId + '/');
    const d = await listPrefix('vaults/' + vaultId + '/docs/' + docId + '/');
    return JSON.stringify({ ok: v.status === 200 && d.status === 200,
      versionCount:v.keys.length, docCount:d.keys.length,
      maxVerRev: v.keys.length ? Math.max.apply(null, v.keys.map(revOf)) : 0,
      prefix:'vaults/' + vaultId + '/versions/' + docId + '/' });
  })()`);
  const h = JSON.parse(hist);
  push('history.list', h.ok === true && h.versionCount > 0 && h.docCount > 0,
    h.ok !== true ? `失败：${h.why ?? '非 200'}`
      : `《${ed.title ?? ed.docId}》历史 ${h.versionCount} 个对象（最高 rev ${h.maxVerRev}）、正文 ${h.docCount} 个对象`);

  /*
   * 历史版本要能「每保存一次多一条」，只看云端有没有对象不够。
   *
   * 有测试者新建空文档、首次保存后立刻查 listDocVersions 得到空列表，
   * 于是报「保存后历史版本为空」。实测（tools/probe-history-220.mjs）证明功能正常：
   * 旧文档保存前 1 -> 保存后 2；新文档首次保存 2 -> 再保存 3。
   * 空列表是时序问题（归档还没落盘），不是归档坏了。
   *
   * 所以判据用**增量**：新建文档 -> 存一次取基线 -> 再改再存 -> 版本数必须增加。
   * 用新建文档而不是复用上一步的标签，因为 tab 对象是快照，
   * 改过内容后旧引用的 content 不再更新，拿它拼内容会导致"没变化"的假失败。
   */
  const histGrow = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no app store' });
    if (typeof app.listDocVersions !== 'function') return JSON.stringify({ ok:false, why:'无 listDocVersions' });

    await app.createDoc({ title: 'electron-hist-' + Date.now(), content: '历史增量基线' });
    await sleep(2500);
    const tabId = app.activeTabId;
    const tabNow = () => app.tabs?.find(t => t.id === tabId);
    const docId = tabNow()?.docId ?? tabNow()?.meta?.docId;
    if (!docId) return JSON.stringify({ ok:false, why:'新建文档没有 docId' });

    const count = async () => {
      try { const v = await app.listDocVersions(docId); return Array.isArray(v) ? v.length : -1; }
      catch { return -2; }
    };

    await app.saveActiveTab?.();
    await sleep(18000);
    const before = await count();

    app.updateTabContent?.(tabId, (tabNow()?.content ?? '') + '\\n\\n' + 'EG-' + Date.now());
    await sleep(800);
    await app.saveActiveTab?.();
    await sleep(18000);
    const after = await count();

    return JSON.stringify({ ok:true, docId: docId.slice(-8), before, after, grew: before >= 0 && after > before });
  })()`, 420000);
  const hg = JSON.parse(histGrow);
  push('history.grow', hg.ok === true && hg.grew === true,
    hg.ok !== true ? `历史增量检查失败：${hg.why ?? '未知'}`
      : hg.grew ? `文档 ${hg.docId} 再保存一次：版本 ${hg.before} -> ${hg.after}（每次保存新增一条）`
        : `保存后版本数未增加（${hg.before} -> ${hg.after}），历史归档异常`);

  // 9. 管理后台导航
  const nav = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const before = location.pathname;
    history.pushState({}, '', '/admin');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(2500);
    const onAdmin = location.pathname === '/admin';
    const adminLen = (document.body.innerText||'').trim().length;
    history.pushState({}, '', '/app');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(2500);
    const backEditor = location.pathname === '/app';
    const editorLen = (document.body.innerText||'').trim().length;
    return JSON.stringify({ before, onAdmin, adminLen, backEditor, editorLen });
  })()`);
  const nv = JSON.parse(nav);
  push('nav.admin', nv.onAdmin && nv.adminLen > 50, `进入 /admin：${nv.onAdmin}（正文 ${nv.adminLen} 字）`);
  push('nav.backEditor', nv.backEditor && nv.editorLen > 50, `返回 /app：${nv.backEditor}（正文 ${nv.editorLen} 字）`);

  /*
   * 快捷键：不能只看"按键被接住了"，要证明「按了真的做对事」。
   *
   * 教训来自 2.2.0 实测：Ctrl+E 曾被 editor.code 与 app.toggleMode 双重绑定，
   * 匹配取第一条导致模式永远切不了，而事件本身是 defaultPrevented=true 的，
   * 只看"有没有处理器响应"会得出完全错误的结论。
   * 所以这里同时断言：快捷键表无重复绑定、Ctrl+E 能把模式切走。
   */
  const sc = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let st = null;
    for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
    const shortcuts = st?.settings?.shortcuts ?? [];
    const owner = new Map();
    const dups = [];
    for (const s of shortcuts) {
      for (const k of (s.keys || [])) {
        const norm = String(k).toLowerCase();
        if (owner.has(norm)) dups.push(norm + ' -> ' + owner.get(norm) + ' & ' + s.command);
        else owner.set(norm, s.command);
      }
    }
    const tab = () => app.tabs?.find(t => t.id === app.activeTabId);
    const before = tab()?.mode ?? null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'e', code:'KeyE', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(1600);
    const after = tab()?.mode ?? null;
    return JSON.stringify({ total: shortcuts.length, dups, before, after, changed: before !== after });
  })()`, 120000);
  const sco = JSON.parse(sc);
  push('shortcut.noConflict', Array.isArray(sco.dups) && sco.dups.length === 0,
    sco.dups && sco.dups.length ? `重复绑定：${sco.dups.slice(0, 4).join('; ')}` : `快捷键 ${sco.total} 条，无重复绑定`);
  push('shortcut.ctrlE', sco.changed === true,
    sco.changed ? `Ctrl+E 切换视图模式：${sco.before} -> ${sco.after}` : `Ctrl+E 未能切换视图模式（仍是 ${sco.after}）`);

  /*
   * 设置：草稿 + 保存两段式，必须走完整链路才算数。
   * 只改草稿就看 store 会误判成"设置无效"（该设计下 store 本就不该立刻变）。
   */
  const setRes = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s;
    let st = null;
    for (const [, v] of stores) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
    const ls = () => { try { return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}'); } catch { return {}; } };
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');

    document.dispatchEvent(new KeyboardEvent('keydown', { key:',', code:'Comma', ctrlKey:true, bubbles:true, cancelable:true }));
    await sleep(2500);
    const hasSettingsTab = (app.tabs || []).some(t => t.title === '设置');

    const navs = Array.from(document.querySelectorAll('.settings__nav-item'));
    for (const n of navs) { if (/编辑器/.test(n.innerText || '')) { n.click(); await sleep(1200); break; } }
    const el = Array.from(document.querySelectorAll('.settings input[type="number"]'))
      .find(x => /字号/.test(x.getAttribute('aria-label') || ''));
    if (!el) return JSON.stringify({ ok:false, why:'找不到字号控件', hasSettingsTab });

    const from = Number(el.value);
    const to = from >= 26 ? from - 2 : from + 2;
    el.focus();
    el.value = String(to);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    const draftOnly = (st?.settings?.appearance?.fontSize ?? null) === from;

    const btns = Array.from(document.querySelectorAll('.settings-savebar button, .settings-savebar__actions button'));
    const saveBtn = btns.find(b => /^保存$/.test((b.innerText || '').trim())) || btns.find(b => /保存/.test(b.innerText || ''));
    if (!saveBtn) return JSON.stringify({ ok:false, why:'找不到保存按钮', hasSettingsTab, draftOnly });
    saveBtn.click();
    await sleep(6000);

    const storeAfter = st?.settings?.appearance?.fontSize ?? null;
    const lsAfter = ls()?.appearance?.fontSize ?? null;
    return JSON.stringify({ ok:true, hasSettingsTab, from, to, draftOnly, storeAfter, lsAfter,
      committed: storeAfter === to && lsAfter === to,
      lsKeys: Object.keys(ls()).slice(0, 6) });
  })()`, 180000);
  const sr = JSON.parse(setRes);
  push('settings.open', sr.hasSettingsTab === true, `Ctrl+, 打开设置标签页=${sr.hasSettingsTab}`);
  push('settings.persist', sr.ok === true && Array.isArray(sr.lsKeys) && sr.lsKeys.length > 0,
    sr.ok === true ? `持久化键 [${(sr.lsKeys || []).join(',')}]` : `失败：${sr.why ?? '未知'}`);
  push('settings.apply', sr.ok === true && sr.committed === true,
    sr.ok === true
      ? `字号 ${sr.from} -> ${sr.to}：改草稿不立即写库=${sr.draftOnly}，保存后 store=${sr.storeAfter}、localStorage=${sr.lsAfter}${sr.committed ? '（已生效）' : '（**未生效**）'}`
      : `设置生效检查失败：${sr.why ?? '未知'}`);

  /*
   * 性能与稳定性（与 shell-ui-accept.mjs 的 perf.* 三项对齐，判据一致）。
   *
   * 目标原文要求「性能与稳定性」「性能最佳」，而此前 Electron 这 21 项也
   * 全是功能正确性，没有任何性能断言。阈值与四壳保持一致，便于横向比较；
   * 同样只兜数量级退化，不做精细基准（跨机器必然抖动）。
   */
  const perf = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('app');
    if (!app) return JSON.stringify({ ok:false, why:'no store' });
    const list = app.docs || [];
    if (!list.length) return JSON.stringify({ ok:false, why:'docs empty' });
    const out = { docCount: list.length };

    const biggest = [...list].sort((a,b)=>(b.size??0)-(a.size??0))[0] ?? list[0];
    out.biggest = { docId: biggest.docId, size: biggest.size ?? 0 };
    const t0 = performance.now();
    await app.openDoc(biggest.docId);
    let shown = false;
    for (let i = 0; i < 120; i++) {
      if (document.querySelector('.ProseMirror, .cm-content, [contenteditable="true"], textarea')) { shown = true; break; }
      await sleep(100);
    }
    out.openMs = Math.round(performance.now() - t0);
    out.editorShown = shown;

    const tabId = app.activeTabId;
    const tab = (app.tabs||[]).find(t => t.id === tabId);
    const t1 = performance.now();
    await app.updateTabContent(tabId, (tab?.content ?? '') + '\\n\\n' + 'PERF-' + Date.now());
    await sleep(400);
    await app.saveActiveTab();
    let synced = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (app.syncState === 'idle') { synced = true; break; }
    }
    out.saveMs = Math.round(performance.now() - t1);
    out.synced = synced;

    // 打字延迟用**小文档**测（大文档会把"字符串拼接"算进来，见四壳同项的注释）
    const small = [...list].sort((a,b)=>(a.size??0)-(b.size??0))[0] ?? list[0];
    await app.openDoc(small.docId);
    await sleep(1200);
    const smallTabId = app.activeTabId;
    const smallTab = (app.tabs||[]).find(t => t.id === smallTabId);
    out.typingDoc = { docId: small.docId, size: small.size ?? 0 };
    if (smallTab) {
      const base = smallTab.content ?? '';
      for (let i = 0; i < 10; i++) await app.updateTabContent(smallTabId, base + 'w' + i);
      const t2 = performance.now();
      for (let i = 0; i < 200; i++) await app.updateTabContent(smallTabId, base + 'x'.repeat(i % 40));
      out.typingMs = Math.round(performance.now() - t2);
      out.typingAvgMs = Math.round((out.typingMs / 200) * 100) / 100;
    }
    return JSON.stringify(out);
  })()`, 420000);
  let pf = {};
  try { pf = JSON.parse(perf); } catch { pf = { ok:false, why:'解析失败' }; }
  const OPEN_LIMIT = 12000;
  const SAVE_LIMIT = 40000;
  const TYPING_AVG_LIMIT = 30;
  push('perf.open',
    pf.ok !== false && pf.editorShown === true && typeof pf.openMs === 'number' && pf.openMs <= OPEN_LIMIT,
    pf.ok === false ? `性能测量失败：${pf.why}`
      : `打开最大文档（${Math.round((pf.biggest?.size ?? 0)/1024)} KB，共 ${pf.docCount} 篇）耗时 ${pf.openMs} ms（上限 ${OPEN_LIMIT} ms），编辑器可见=${pf.editorShown}`);
  push('perf.save',
    pf.ok !== false && pf.synced === true && typeof pf.saveMs === 'number' && pf.saveMs <= SAVE_LIMIT,
    pf.ok === false ? `性能测量失败：${pf.why}`
      : `保存+同步完成耗时 ${pf.saveMs} ms（上限 ${SAVE_LIMIT} ms），同步达 idle=${pf.synced}`);
  push('perf.typing',
    pf.ok !== false && typeof pf.typingAvgMs === 'number' && pf.typingAvgMs <= TYPING_AVG_LIMIT,
    pf.ok === false ? `性能测量失败：${pf.why}`
      : `连续输入 200 次（空文档 ${Math.round((pf.typingDoc?.size ?? 0)/1024)} KB）共 ${pf.typingMs} ms，平均 ${pf.typingAvgMs} ms/次（上限 ${TYPING_AVG_LIMIT} ms/次）`);

  // 10. 控制台异常
  const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const errs = cdp.events.filter(
    (e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error',
  );
  push('console.clean', thrown.length === 0, `未捕获异常 ${thrown.length} 个，console.error ${errs.length} 条`);

  // 11. 窗口按钮真实可用
  const winBtn = await cdp.eval(`(async () => {
    const before = await window.NeoMD.bridge.win.isMaximized();
    await window.NeoMD.bridge.win.toggleMaximize();
    await new Promise(r => setTimeout(r, 900));
    const after = await window.NeoMD.bridge.win.isMaximized();
    await window.NeoMD.bridge.win.toggleMaximize();
    await new Promise(r => setTimeout(r, 900));
    const restored = await window.NeoMD.bridge.win.isMaximized();
    return JSON.stringify({ before, after, restored, works: before !== after });
  })()`);
  const wb = JSON.parse(winBtn);
  push('window.controls', wb.works === true, `isMaximized ${wb.before} → ${wb.after} → ${wb.restored}`);

  ws.close();
  finish(proc);
})();

function finish(proc) {
  const pass = report.filter((r) => r.ok).length;
  const total = report.length;
  const failed = report.filter((r) => !r.ok).map((r) => r.name);
  console.log(`\nelectron  ${pass}/${total} 通过${failed.length ? '  失败：' + failed.join(',') : ''}`);
  try {
    fs.mkdirSync(path.join(process.cwd(), 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), 'reports', 'electron-accept.json'),
      JSON.stringify({ shell: 'electron', release: VERSION, pass, total, report }, null, 2),
      'utf8',
    );
  } catch {}
  killAll();
  process.exit(failed.length ? 1 : 0);
}
