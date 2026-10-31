/** 诊断：颜色细化区实际有哪些按钮、点击主题卡后它们的状态。 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import fs from 'node:fs';

const { chromium } = playwright;
const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER = process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();

  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.settings__nav-item')).find(
      (e) => (e.textContent || '').trim() === '主题',
    );
    if (el) el.click();
  });
  await page.waitForTimeout(1200);

  const dump = async (label) => {
    const info = await page.evaluate(() => {
      const colors = Array.from(document.querySelectorAll('input[type="color"]')).map((e, i) => ({
        i,
        aria: e.getAttribute('aria-label'),
        value: e.value,
      }));
      const btns = Array.from(document.querySelectorAll('button'))
        .map((b) => ({
          text: (b.textContent || '').trim().slice(0, 18),
          disabled: b.disabled,
          testid: b.getAttribute('data-testid'),
        }))
        .filter((b) => b.text && b.text.length > 0);
      return { colors, btns };
    });
    console.log(`\n=== ${label} ===`);
    console.log('color inputs:', JSON.stringify(info.colors));
    console.log('buttons（前24个）:');
    for (const b of info.btns.slice(0, 24)) {
      console.log(`   ${b.disabled ? '[disabled]' : '[enabled ]'} "${b.text}" ${b.testid ? `testid=${b.testid}` : ''}`);
    }
  };

  await dump('打开主题页签');

  // 点第一张主题卡
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="theme-cards"] > *')[0]?.click();
  });
  await page.waitForTimeout(900);
  await dump('点第一张主题卡后');

  // 改第一个颜色输入
  await page.evaluate(() => {
    const el = document.querySelector('input[type="color"]');
    if (el) {
      el.value = '#00aa88';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await dump('改第一个颜色后');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
