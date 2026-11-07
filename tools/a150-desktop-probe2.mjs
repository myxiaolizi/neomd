/**
 * A150 桌面端实机验证 · 第二轮（离线 / 多窗口 / 持久化 / 截图）
 * ============================================================================
 * 第一轮（a150-desktop-runtime.mjs）已验证：窗口开启、preload 暴露面、主进程安全基线、
 * 本地文件读写真的落盘、任意路径读可读（P0 证据）。
 *
 * 本轮避开第一轮踩到的坑：**不要用 page.reload() 做离线测试**（自定义协议 reload 会触发
 * 窗口销毁 → 主进程 window-all-closed → 应用整体退出，第一轮就是这样把进程弄没的）。
 * 改用 CDP `Network.emulateNetworkConditions` 真离线，页面不重载，测的是"断网后还能不能编辑"。
 *
 * 用法：node tools/a150-desktop-probe2.mjs [--port=9418]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'docs', 'AUDIT-150');
const SHOTS = path.join(OUT, 'shots');
const RAW = path.join(OUT, 'raw');

const argPort = process.argv.find((a) => a.startsWith('--port='));
const PORT = argPort ? Number(argPort.slice(7)) : 9418;

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

async function loadChromium() {
  const candidates = [
    'playwright-core',
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs'),
  ];
  const errs = [];
  for (const c of candidates) {
    try {
      const mod = await import(/^[A-Za-z]:/.test(c) ? `file://${c.replace(/\\/g, '/')}` : c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errs.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errs.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(`无法加载 Playwright：\n  - ${errs.join('\n  - ')}`);
}

const out = {
  meta: {
    kind: 'a150-desktop-probe2',
    generatedAt: new Date().toISOString(),
    cdpPort: PORT,
    note: '离线测试用 CDP 网络模拟，不 reload（reload 会杀窗口并让应用整体退出）',
  },
  steps: {},
  errors: [],
};
const rec = (k, v) => {
  out.steps[k] = v;
  console.log(`  [ok] ${k}`, typeof v === 'object' ? JSON.stringify(v).slice(0, 240) : v);
};

async function main() {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  rec('initialWindowCount', pages.length);
  const page = pages[0];
  if (!page) throw new Error('没有页面可驱动');
  const ctx = page.context();

  await page.waitForTimeout(1200);

  // ---- 实时界面基线（DOM 层面确认不是白屏） ----
  const dom = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      title: document.title,
      url: location.href,
      bodyTextLen: txt.length,
      bodyHead: txt.slice(0, 260),
      hasRuntimeFlag: document.documentElement.dataset.runtime || null,
      hasCodeMirror: !!document.querySelector('.cm-editor'),
      hasTextarea: !!document.querySelector('textarea'),
      hasContentEditable: !!document.querySelector('[contenteditable="true"]'),
      tabCount: document.querySelectorAll('[role="tab"], .nm-tab, [data-tab-id]').length,
      buttons: document.querySelectorAll('button').length,
    };
  });
  rec('dom', dom);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-main.png') });

  // ---- 编辑器可编辑性（离线前后各测一次） ----
  async function measureEditable() {
    return page.evaluate(() => {
      const cm = document.querySelector('.cm-content');
      const ta = document.querySelector('textarea');
      if (cm) {
        return {
          kind: 'codemirror',
          editable: cm.getAttribute('contenteditable') === 'true',
          textLen: (cm.textContent || '').length,
        };
      }
      if (ta) return { kind: 'textarea', editable: !ta.disabled && !ta.readOnly, textLen: (ta.value || '').length };
      return { kind: 'none', editable: false, textLen: 0 };
    });
  }
  const editableOnline = await measureEditable();
  rec('editableOnline', editableOnline);

  // ---- 离线：CDP 网络模拟（不 reload） ----
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await page.waitForTimeout(2500);

    // 离线状态下打一次外网请求，确认真的断网
    const offlineFetch = await page.evaluate(async () => {
      try {
        const r = await fetch('https://md.zhengl.vip/api/health', { cache: 'no-store' });
        return { reached: true, status: r.status };
      } catch (e) {
        return { reached: false, error: String(e && e.message ? e.message : e) };
      }
    });
    const editableOffline = await measureEditable();
    const stillAlive = await page.evaluate(() => ({
      appMounted: !!document.querySelector('#app')?.children.length,
      textLen: (document.body.innerText || '').length,
    }));
    rec('offline', { offlineFetch, editableOffline, stillAlive });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-offline.png') });

    // 恢复网络
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    rec('networkRestored', true);
  } catch (e) {
    out.errors.push(`offlineTest: ${e.message}`);
  }

  // ---- 设置 / 登录态持久化键（只记录键名与长度，不落凭据） ----
  try {
    const ls = await page.evaluate(() => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      const interesting = keys.filter((k) => /neomd|token|refresh|access|vault|tabs|settings|device|cred/i.test(k));
      return {
        totalKeys: keys.length,
        interesting,
        // 关键：token 是否明文存在 localStorage
        hasAccessTokenKey: keys.includes('neomd.access'),
        hasRefreshTokenKey: keys.includes('neomd.refresh'),
        accessLen: (localStorage.getItem('neomd.access') || '').length,
        refreshLen: (localStorage.getItem('neomd.refresh') || '').length,
        lastVault: localStorage.getItem('neomd.lastVault'),
      };
    });
    rec('localStorage', ls);
  } catch (e) {
    out.errors.push(`localStorage: ${e.message}`);
  }

  // ---- 多窗口：走真实 IPC（window:newWindow），再用 CDP 目标数验证 ----
  let beforeCount = out.steps.initialWindowCount;
  try {
    const newWin = await page.evaluate(async () => {
      try {
        const id = await window.NeoMD.bridge.win.newWindow(null, { fresh: false });
        return { ok: true, windowId: id };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });
    await page.waitForTimeout(3500);
    // 用 CDP HTTP 接口数页面（比 Playwright 的 contexts 更准）
    let targets = [];
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
    } catch {
      /* ignore */
    }
    rec('multiWindow', {
      ipcResult: newWin,
      beforeCount,
      afterPageTargets: targets.filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url })),
      afterCount: targets.filter((t) => t.type === 'page').length,
      grew: targets.filter((t) => t.type === 'page').length > beforeCount,
    });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-multiwindow.png') });
  } catch (e) {
    out.errors.push(`multiWindow: ${e.message}`);
  }

  // ---- 窗口控制 IPC 能否真的驱动窗口 ----
  try {
    const winCtl = await page.evaluate(async () => {
      const r = {};
      r.isMaximized = await window.NeoMD.bridge.win.isMaximized();
      r.toggle = await window.NeoMD.bridge.win.toggleMaximize();
      await new Promise((res) => setTimeout(res, 800));
      r.isMaximizedAfter = await window.NeoMD.bridge.win.isMaximized();
      return r;
    });
    rec('windowControl', winCtl);
  } catch (e) {
    out.errors.push(`windowControl: ${e.message}`);
  }

  // ---- 打印 PDF 能力是否存在（不实际写文件，仅确认通道在） ----
  try {
    const hasPrint = await page.evaluate(() => typeof window.NeoMD.printToPdf === 'function');
    rec('printToPdfAvailable', hasPrint);
  } catch (e) {
    out.errors.push(`printToPdf: ${e.message}`);
  }

  await browser.close().catch(() => null);
  const jsonPath = path.join(RAW, 'desktop-runtime2.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[write] ${path.relative(ROOT, jsonPath)}`);
  if (out.errors.length) {
    console.log('[warn]');
    for (const e of out.errors) console.log('  - ' + e);
  }
}

main().catch((e) => {
  out.errors.push(`fatal: ${e.message}`);
  fs.writeFileSync(path.join(RAW, 'desktop-runtime2.json'), JSON.stringify(out, null, 2), 'utf8');
  console.error('[fail]', e.message);
  process.exitCode = 1;
});
