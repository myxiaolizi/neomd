/**
 * 只读诊断：找出在本机稳定存活 60s 的 Chrome 启动参数组合。
 * 背景：`--headless=new` 在空白页上约 30s 就崩（heap 仅 10MB，非内存不足）。
 * 依次尝试几种常见组合，报告每组能否撑过 60s。不登录、不写数据。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const COMBOS = [
  { name: 'headless=new (当前用法)', args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] },
  { name: 'headless=new + disable-gpu', args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
  { name: 'headless=old', args: ['--headless=old', '--no-sandbox', '--disable-dev-shm-usage'] },
  { name: 'headless=new + single-process', args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--single-process'] },
  {
    name: 'headless=new + 稳定性参数',
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-tools',
      '--no-first-run',
      '--js-flags=--max-old-space-size=256',
    ],
  },
];

for (const combo of COMBOS) {
  let ok = false;
  let detail = '';
  let browser = null;
  try {
    browser = await chromium.launch({ executablePath: BROWSER, args: combo.args });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let crashed = false;
    page.on('crash', () => {
      crashed = true;
    });
    await page.setContent('<h1>alive</h1>');
    // 分成 6 段各 10s，任一段崩就记录
    for (let i = 0; i < 6; i += 1) {
      await page.waitForTimeout(10_000);
      if (crashed) {
        detail = `第 ${(i + 1) * 10}s 崩溃`;
        break;
      }
    }
    ok = !crashed;
    if (ok) detail = '撑过 60s';
  } catch (e) {
    detail = `${e.message.split('\n')[0].slice(0, 80)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  console.log(`${ok ? '✓' : '✗'} ${combo.name} → ${detail}`);
}
