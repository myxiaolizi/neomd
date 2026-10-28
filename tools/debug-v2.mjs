/**
 * 针对失败用例的最小复现脚本：右键菜单与 Ctrl+2。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
const { chromium } = playwright;

const BASE = 'https://md.zhengl.vip';
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--headless=new', '--no-sandbox'],
});
const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());

await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.fill('#account', 'admin');
await page.fill('#password', '6655');
await page.locator('.card__submit').click();
await page.waitForURL('**/app', { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(2500);
console.log('URL:', page.url());

// 打开一篇文档
const row = page.locator('.leftpanel__body .file-row').first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(1800);
} else {
  await page.locator('.leftpanel__actions .act[title*="新建"]').click();
  await page.waitForTimeout(1000);
  const inp = page.locator('.modal .nm-input');
  if (await inp.count()) {
    await inp.fill('调试文档');
    await page.locator('.modal .nm-btn--primary').click();
    await page.waitForTimeout(1600);
  }
}

/* --- Ctrl+2 调试 --- */
const editor = page.locator('.ProseMirror');
await editor.click();
await page.keyboard.type('第一行');
await page.keyboard.press('Enter');
await page.keyboard.press('Control+1');
await page.waitForTimeout(600);
console.log('after Ctrl+1 => h1:', await page.locator('.ProseMirror h1').count(), 'h2:', await page.locator('.ProseMirror h2').count());
await page.keyboard.press('Control+2');
await page.waitForTimeout(600);
console.log('after Ctrl+2 => h1:', await page.locator('.ProseMirror h1').count(), 'h2:', await page.locator('.ProseMirror h2').count());
const html = await editor.innerHTML();
console.log('editor html:', html.slice(0, 260).replace(/\n/g, ''));

/* --- 标签页右键调试 --- */
const tab = page.locator('.tab').first();
console.log('tab count:', await tab.count());
const box = await tab.boundingBox();
console.log('tab box:', JSON.stringify(box));
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(900);
}
console.log('tabmenu count after right click:', await page.locator('.tabmenu').count());

// 直接派发 contextmenu 事件再试
await page.evaluate(() => {
  const t = document.querySelector('.tab');
  t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 60 }));
});
await page.waitForTimeout(900);
console.log('tabmenu count after dispatch:', await page.locator('.tabmenu').count());

/* --- 文件列表右键调试 --- */
await page.mouse.move(100, 200);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(900);
console.log('docmenu count after right click:', await page.locator('.docmenu').count());

await browser.close();
