/**
 * 诊断：设置页关闭后，编辑器正文容器的真实选择器。
 *
 * ## 为什么需要
 *
 * `re14-settings-audit.mjs` 的「正文实际渲染跟随设置」这条断言在
 * verify-140 的 D01 里报 `未找到正文容器`。我加了 `ensureDocTab()` 兜底仍然失败，
 * 说明我假设的选择器（`.nm-content` / `.ProseMirror` / `.cm-content`）在当前
 * 页面状态下可能都不存在 —— 需要先把真实 DOM 打出来，再决定修断言还是修兜底逻辑。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import fs from 'node:fs';

const { chromium } = playwright;
const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER = process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_EXPR =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const launch = () =>
  chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    args: ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'],
  });

async function main() {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();

  const snap = async (label) => {
    const info = await page.evaluate((expr) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      const sels = [
        '.nm-content',
        '.ProseMirror',
        '.cm-content',
        '.wysiwyg',
        '.shell__doc',
        '.shell__main',
        '.shell__content',
        '.tabbar .tab',
        '.editorbar',
      ];
      const counts = {};
      for (const s of sels) counts[s] = document.querySelectorAll(s).length;
      const tabs = Array.from(document.querySelectorAll('.tabbar .tab')).map((t) => ({
        text: (t.textContent || '').trim().slice(0, 24),
        cls: String(t.className).slice(0, 60),
      }));
      return {
        counts,
        tabs,
        activeTabId: app?.activeTabId ?? null,
        activeTitle: app?.activeTab?.title ?? null,
        tabCount: (app?.tabs ?? []).length,
        docCount: (app?.docs ?? []).length,
        activePane: app?.activePane ?? null,
      };
    }, APP_EXPR);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(info, null, 1));
    return info;
  };

  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4500);
    await snap('初始进入 /app');

    // 打开设置
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await snap('打开设置页后');

    // 关闭设置
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tabbar .tab'));
      const st = tabs.find((t) => (t.textContent || '').trim().includes('设置'));
      const closeBtn = st?.querySelector('[class*="close"]');
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1500);
    await snap('关闭设置页后');

    // 尝试显式激活一个文档标签
    await page.evaluate(async (expr) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      const tabs = app?.tabs ?? [];
      const docTab = tabs.find((t) => !/设置|插件商店/.test(String(t.title || '')));
      if (docTab) app.activeTabId = docTab.id;
      await new Promise((r) => setTimeout(r, 900));
    }, APP_EXPR);
    await page.waitForTimeout(1600);
    await snap('显式激活文档标签后');

    await page.screenshot({ path: 'docs/shots-140/re140-diag-editor-container.png' });
    console.log('\n截图：docs/shots-140/re140-diag-editor-container.png');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
