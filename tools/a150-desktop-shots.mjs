/**
 * A150 桌面端 · 第三轮：截图证据 + 收尾核实
 * ============================================================================
 * 目的：产出报告要用的 PNG 证据，并核实第二轮遗留项（printToPdf 通道位置写错了，
 * 实际在 bridge.printToPdf 而不是 window.NeoMD.printToPdf）。
 *
 * 纪律：
 *  - **不调用 browser.close()**：Playwright 的 close 会关闭 CDP 连接所指的浏览器，
 *    连带把桌面端进程杀掉（前两轮就是这样把 app 弄没的）。这里只断开、不关闭。
 *  - 不 reload（reload 会让窗口销毁 → window-all-closed → 整个应用退出）。
 *  - 截图用 Playwright page.screenshot，写到 docs/AUDIT-150/shots/。
 *
 * 用法：node tools/a150-desktop-shots.mjs [--port=9420]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(ROOT, 'docs', 'AUDIT-150', 'shots');
const RAW = path.join(ROOT, 'docs', 'AUDIT-150', 'raw');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

const PORT = (() => {
  const a = process.argv.find((x) => x.startsWith('--port='));
  return a ? Number(a.slice(7)) : 9420;
})();

async function loadChromium() {
  const candidates = [
    'playwright-core',
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
  ];
  for (const c of candidates) {
    try {
      const mod = await import(/^[A-Za-z]:/.test(c) ? `file://${c.replace(/\\/g, '/')}` : c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* try next */
    }
  }
  throw new Error('无法加载 playwright-core');
}

const out = { meta: { kind: 'a150-desktop-shots', at: new Date().toISOString(), port: PORT }, steps: {}, errors: [] };
const rec = (k, v) => {
  out.steps[k] = v;
  console.log(`  [ok] ${k}`, typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v);
};

async function main() {
  const chromium = await loadChromium();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages[0];
  if (!page) throw new Error('没有页面');

  await page.waitForTimeout(2500);

  // 主界面截图
  await page.screenshot({ path: path.join(SHOTS, 'desktop-main.png') });
  rec('shot_main', 'desktop-main.png');

  // 窗口/界面事实
  rec('window', {
    title: await page.title(),
    url: page.url(),
    viewport: page.viewportSize(),
  });

  // 更正第二轮：printToPdf 在 bridge 下面
  const channels = await page.evaluate(() => {
    const b = window.NeoMD.bridge;
    return {
      printToPdf_top: typeof window.NeoMD.printToPdf,
      printToPdf_bridge: typeof b.printToPdf,
      secretsEncrypt: typeof b.secrets.encrypt,
      secretsDecrypt: typeof b.secrets.decrypt,
      safeStorageActuallyUsedByApp: null,
    };
  });
  rec('channelLocations', channels);

  // 标题栏运行时标记 + 拖拽区（桌面端独有的系统集成是否真的生效）
  const chrome = await page.evaluate(() => {
    const html = document.documentElement;
    const drag = document.querySelector('.nm-drag');
    const cs = drag ? getComputedStyle(drag) : null;
    return {
      dataRuntime: html.dataset.runtime || null,
      hasDragRegion: !!drag,
      dragAppRegion: cs ? cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') : null,
      titlebarH: getComputedStyle(html).getPropertyValue('--titlebar-h').trim() || null,
    };
  });
  rec('desktopChrome', chrome);

  // 菜单 / 快捷键线索：主进程没有 Menu，此处确认渲染层是否自行绑了快捷键
  const keys = await page.evaluate(() => {
    // 仅读取，不触发
    return {
      hasGlobalShortcutApi: typeof window.NeoMD.bridge.globalShortcut,
      menuBarVisibleHint: 'autoHideMenuBar=true（主进程），无自定义 Menu',
    };
  });
  rec('menuShortcut', keys);

  // 离线截图（CDP 模拟，不 reload）
  try {
    const ctx = page.context();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-offline.png') });
    const alive = await page.evaluate(() => ({
      mounted: !!document.querySelector('#app')?.children.length,
      textLen: (document.body.innerText || '').length,
    }));
    rec('offlineShot', alive);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  } catch (e) {
    out.errors.push('offlineShot: ' + e.message);
  }

  // 注意：不断开浏览器（browser.close 会杀掉桌面端）。直接退出进程即可。
  fs.writeFileSync(path.join(RAW, 'desktop-shots.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n[done] 截图已写入 docs/AUDIT-150/shots/');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    out.errors.push('fatal: ' + e.message);
    fs.writeFileSync(path.join(RAW, 'desktop-shots.json'), JSON.stringify(out, null, 2), 'utf8');
    console.error('[fail]', e.message);
    process.exit(1);
  });
