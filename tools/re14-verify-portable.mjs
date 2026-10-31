/**
 * 1.4.0 PC 绿色版（免安装）本机实测。
 *
 * ## 方法学：为什么要用 CDP 而不是「驱动脚本入口」
 *
 * 打包后的 exe 入口固定在 `app.asar/main.cjs`，传脚本只会进 `process.argv`，
 * **无法用 `electron.exe driver.cjs` 注入驱动**（1.2.0 期间踩过）。
 * 因此这里用 `--remote-debugging-port` + CDP 连接 —— 启动的就是用户双击的
 * 那个 exe 本体，比注入驱动更接近真实使用。
 *
 * ## 覆盖
 *  A 静态：解压目录结构、exe 存在、asar 内有 main/preload、白名单无幽灵条目
 *  B GUI  ：主窗口加载、`window.NeoMD.bridge` API 齐全、env=desktop、
 *           `contextIsolation` 未回退（window.require / process 均 undefined）
 *  C 数据 ：本地仓库真读写（含中文文件名）
 *  D 新版 ：功能区/设置页关键元素（验证 1.4.0 改动确实进了产物）
 *
 * 用法：node tools/re14-verify-portable.mjs "<exe 所在目录>"
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const DIR = process.argv[2] || '';
if (!DIR || !fs.existsSync(DIR)) {
  console.error('用法：node tools/re14-verify-portable.mjs "<绿色版解压目录>"');
  process.exit(2);
}
const EXE = path.join(DIR, 'Neo MD.exe');
const PORT = 9411;

const results = [];
function check(name, expect, actual, pass, note = '') {
  results.push({ name, expect, actual, pass, note });
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}`);
  console.log(`        期望: ${expect}`);
  console.log(`        实测: ${actual}${note ? `  （${note}）` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`CDP 未就绪：${url}`);
}

/** 用 CDP WebSocket 执行一段页面脚本 */
async function evalInPage(wsUrl, expression) {
  const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const id = 1;
  const payload = JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  });
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), 30000);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          res(msg);
        }
      } catch {
        /* 忽略非 JSON 帧 */
      }
    });
    ws.send(payload);
  });
  ws.close();
  const r = result.result;
  if (r?.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.text || r.exceptionDetails.exception?.description || '页面脚本异常'));
  }
  return r?.result?.value;
}

async function main() {
  console.log('='.repeat(72));
  console.log('1.4.0 PC 绿色版本机实测');
  console.log('='.repeat(72));
  console.log(`目录：${DIR}`);
  console.log(`exe ：${EXE}`);

  /* ---------- A 静态 ---------- */
  console.log('\n[A] 静态检查');
  check('绿色版 exe 存在', 'Neo MD.exe 可执行文件存在', fs.existsSync(EXE) ? '存在' : '缺失', fs.existsSync(EXE));

  const asarPath = path.join(DIR, 'resources', 'app.asar');
  check('app.asar 存在', 'resources/app.asar 存在', fs.existsSync(asarPath) ? `${fs.statSync(asarPath).size} 字节` : '缺失', fs.existsSync(asarPath));

  const webDist = path.join(DIR, 'resources', 'webdist');
  const hasWebdist = fs.existsSync(path.join(webDist, 'index.html'));
  check('前端产物已打包', 'resources/webdist/index.html 存在', hasWebdist ? '存在' : '缺失', hasWebdist);

  // exe 版本信息
  let fileVer = '';
  try {
    const { execFileSync } = await import('node:child_process');
    fileVer = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.FileVersion`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    fileVer = '(读取失败)';
  }
  check('exe 版本号为 1.4.0', 'FileVersion 含 1.4.0', fileVer, /1\.4\.0/.test(fileVer));

  // 目录不可写性（绿色版不应污染解压目录 —— 默认模式 userData 在 AppData）
  const probe = path.join(DIR, '.write-probe');
  let canWrite = true;
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch {
    canWrite = false;
  }
  check('解压目录未被写入探测文件（本次探测自清理）', '探测后目录无残留', canWrite ? '已写入并删除' : '不可写', true, '仅信息项');

  /* ---------- B/C/D GUI ---------- */
  console.log('\n[B~D] 启动 exe 并通过 CDP 验证');
  /*
   * ## 必须剔除 `ELECTRON_RUN_AS_NODE`
   *
   * 本机 shell 里存在 `ELECTRON_RUN_AS_NODE=1`（构建脚本为了让 `electron-builder`
   * 用系统 node 跑而设的）。它会让 **Electron 二进制以纯 Node 模式启动** ——
   * 于是 `require('electron')` 直接 `MODULE_NOT_FOUND`，应用在写第一行日志之前
   * 就退出（exit 0 / 无任何输出）。
   *
   * 实测表现：双击 exe 立刻消失、`neomd-main.log` 一个字节都不增、
   * 任务管理器里没有任何进程残留。极易误判成「打包产物坏了」。
   * 1.2.0 的旧产物同样启动不了 —— 说明这是**环境问题，不是版本问题**。
   *
   * 用干净 env 启动才是用户真实的双击场景。
   */
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    cwd: DIR,
    detached: false,
    stdio: 'ignore',
    env: { ...cleanEnv, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let targets = null;
  try {
    const json = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    targets = Array.isArray(json) ? json : [];
  } catch (e) {
    check('应用可启动（CDP 可连接）', 'CDP /json/list 返回页面列表', String(e.message).slice(0, 120), false);
  }

  if (targets && targets.length) {
    const page = targets.find((t) => /neomd:\/\//.test(t.url || '')) || targets.find((t) => t.type === 'page') || targets[0];
    check('主窗口已加载', '存在 neomd:// 或 page 类型目标', `${page.type} ${String(page.url).slice(0, 60)}`, Boolean(page));

    await sleep(3500);

    const info = await evalInPage(page.webSocketDebuggerUrl, `(() => {
      const b = window.NeoMD && window.NeoMD.bridge ? window.NeoMD.bridge : null;
      return {
        href: location.href,
        title: document.title,
        hasBridge: Boolean(b),
        bridgeKeys: b ? Object.keys(b).sort() : [],
        env: b && b.env ? b.env : (b ? b.platform : null),
        hasRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
        appMounted: Boolean(document.querySelector('#app') && document.querySelector('#app').children.length),
        ribbonBtnCount: document.querySelectorAll('.ribbon__btn').length,
        bodyText: (document.body.innerText || '').slice(0, 160)
      };
    })()`);

    console.log(`  href=${info.href}`);
    check('页面运行在自定义协议 neomd://', 'href 以 neomd:// 开头', info.href, /^neomd:\/\//.test(info.href || ''));
    check('window.NeoMD.bridge 已暴露', 'bridge 存在且 API 齐全', `${info.bridgeKeys.length} 项：${info.bridgeKeys.join(',')}`, info.hasBridge && info.bridgeKeys.length >= 6);
    check('contextIsolation 未回退', 'window.require 与 window.process 均为 undefined', `require=${info.hasRequire} process=${info.hasProcess}`, info.hasRequire === false && info.hasProcess === false);
    check('前端应用已挂载', '#app 有子节点', info.appMounted ? '已挂载' : '未挂载', info.appMounted);

    /* ---------- C 本地仓库真读写 ---------- */
    const rw = await evalInPage(page.webSocketDebuggerUrl, `(async () => {
      const app = document.querySelector('#app').__vue_app__;
      const store = app.config.globalProperties.$pinia._s.get('app');
      const title = 'QA140 中文文件名 测试 ' + Date.now();
      await store.createDoc({ title, content: '# QA140 绿色版实测\\n\\n这是本地读写验证。\\n' });
      await new Promise(r => setTimeout(r, 1800));
      const hit = (store.docs || []).find(d => (d.title || '').includes('QA140 中文文件名'));
      let content = '';
      if (hit) {
        const t = (store.tabs || []).find(x => x.docId === hit.docId);
        content = t ? (t.content || '') : '';
      }
      return { created: Boolean(hit), docId: hit ? hit.docId : null, title: hit ? hit.title : null, contentHead: content.slice(0, 40), docsCount: (store.docs||[]).length };
    })()`);

    check('本地仓库可创建含中文名的文档', '创建成功且能列出', `created=${rw.created} title=${JSON.stringify(rw.title)} docs=${rw.docsCount}`, rw.created === true);

    /* ---------- D 1.4.0 新版特征 ---------- */
    const feature = await evalInPage(page.webSocketDebuggerUrl, `(async () => {
      // 打开设置（Ctrl+,）并检查 1.4.0 的关键改动：保存栏 + 无正文工具栏
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 2200));
      const saveBar = document.querySelector('[data-testid="settings-save-bar"]');
      const saveBtn = document.querySelector('[data-testid="settings-save"]');
      const editorbars = document.querySelectorAll('.editorbar').length;
      const tabs = Array.from(document.querySelectorAll('.tabbar .tab')).map(t => (t.textContent||'').trim().slice(0,20));
      const hasLivePreview = Boolean(document.querySelector('[data-testid="live-preview-toggle"]'));

      /*
       * 主色调控件在「主题」页签（需求14 的归位）。设置页默认落在「通用」，
       * 必须先点「主题」页签，否则查到 0 个色块（这是断言漏了切页签，不是产品问题）。
       */
      const navItems = Array.from(document.querySelectorAll('.settings__nav-item'));
      const themeNav = navItems.find(e => (e.textContent || '').trim() === '主题');
      if (themeNav) themeNav.click();
      await new Promise(r => setTimeout(r, 1200));

      const accentSwatches = document.querySelectorAll('[data-testid="accent-swatches"] button').length;
      const hasThemeCards = document.querySelectorAll('[data-testid="theme-cards"] > *').length;
      const colorInputs = document.querySelectorAll('input[type="color"]').length;
      const navLabels = navItems.map(e => (e.textContent || '').trim());

      return { saveBar: Boolean(saveBar), saveBtn: Boolean(saveBtn), editorbars, tabs,
               accentSwatches, hasLivePreview, hasThemeCards, colorInputs, navLabels };
    })()`);

    check('【1.4.0】设置页有底部保存栏（需求16）', '存在 data-testid=settings-save-bar 与 settings-save', `bar=${feature.saveBar} btn=${feature.saveBtn} livePreview=${feature.hasLivePreview}`, feature.saveBar === true && feature.saveBtn === true);
    check('【1.4.0】设置页不渲染正文工具栏（需求15）', '.editorbar 数量为 0', `${feature.editorbars} 个`, feature.editorbars === 0);
    check('【1.4.0】主色调控件在主题页签（需求14）', '存在 accent-swatches 色板（5 色）', `${feature.accentSwatches} 个色块（主题卡片 ${feature.hasThemeCards}、颜色细化 ${feature.colorInputs} 个取色器）`, feature.accentSwatches >= 5);
    console.log(`        设置页签：${JSON.stringify(feature.navLabels)}`);
  }

  /* ---------- 收尾 ---------- */
  try {
    child.kill();
    await sleep(1200);
  } catch {
    /* ignore */
  }
  // 确保没有残留进程
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Name 'Neo MD' -ErrorAction SilentlyContinue | Stop-Process -Force`], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`合计：通过 ${pass} / 失败 ${fail.length} / 共 ${results.length}`);
  if (fail.length) {
    console.log('失败项：');
    for (const f of fail) console.log(`  \u2717 ${f.name} —— ${f.actual}`);
  } else {
    console.log('✓ PC 绿色版本机实测全部通过');
  }
  console.log('='.repeat(72));
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('实测脚本异常：', e);
  process.exit(3);
});
