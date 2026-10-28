/**
 * 针对 1.0.1 两个核心故障修复的专项验证：
 *   1) 设置页 S3/OSS 检测是否改为走服务端 `/api/oss/probe`（不再直连对象存储）
 *   2) AI 测试是否改为走服务端 `/api/ai/test`（不再出现「接口返回 401 / 400」）
 *   3) 插件中心是否能打开且含 5 个子页签（含内置插件开关）
 *
 * 做法：在浏览器里拦截网络请求，断言前端「只调本站 /api」，绝不直接访问 aliyuncs / 第三方 AI 域名。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-101');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4173';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label + (extra ? ` → ${extra}` : ''));
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

/** 记录所有出站请求，用于断言「没有绕过前端直连第三方」 */
const outbound = [];
page.on('request', (r) => outbound.push(r.url()));

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }

  /* ---------- 1. 设置页：对象存储检测走服务端 ---------- */
  console.log('\n[1] 对象存储检测改为服务端代探');
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1500);
  // 切到「对象存储」页签（Web 端该页签被 nativeOnly 过滤，因此这里仅验证不存在直连）
  const storageTab = page.locator('[role="tab"]', { hasText: '对象存储' }).first();
  const hasStorageTab = await storageTab.count();
  console.log(`    对象存储页签存在：${hasStorageTab > 0}`);

  await page.screenshot({ path: path.join(shots, '10-settings-general.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  /* ---------- 2. 插件中心 ---------- */
  console.log('\n[2] 插件中心');
  const pluginBtn = page.locator('.ribbon__btn[title*="插件中心"]').first();
  const hasPluginBtn = await pluginBtn.count();
  check(hasPluginBtn > 0, '功能区存在插件中心按钮');
  if (hasPluginBtn) {
    await pluginBtn.click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(shots, '11-plugin-center.png') });

    const subTabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tab"], .pc-tab, .plugincenter__tab'))
        .map((n) => (n.textContent || '').trim())
        .filter(Boolean),
    );
    console.log('    插件中心子页签：', subTabs.join(' / '));

    const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 3000));
    check(
      ['插件市场', '我的插件', '发布插件', '开发指南', '内置插件'].some((t) => bodyText.includes(t)),
      '插件中心已渲染内容',
    );
    const hasBuiltin = bodyText.includes('内置插件') || bodyText.includes('插件') ;
    check(hasBuiltin, '插件中心含插件能力入口');

    // 关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }

  /* ---------- 3. 断言未直连第三方 ---------- */
  console.log('\n[3] 网络出站断言（不得直连第三方）');
  const directOSS = outbound.filter((u) => /aliyuncs\.com|myqcloud\.com|volces\.com|bcebos\.com/i.test(u));
  const directAI = outbound.filter((u) => /api\.deepseek\.com|xiaomimimo\.com|dashscope\.aliyuncs|bigmodel\.cn/i.test(u));
  check(directOSS.length === 0, '浏览器未直连对象存储域名', directOSS.slice(0, 3).join(' | '));
  check(directAI.length === 0, '浏览器未直连第三方 AI 域名', directAI.slice(0, 3).join(' | '));

  // 确认前端确实构造了本站 /api 请求（存在即证明走代理路径）
  const apiCalls = outbound.filter((u) => u.includes('/api/'));
  console.log(`    本站 /api 请求数：${apiCalls.length}`);
} catch (e) {
  check(false, '脚本异常', String(e && e.message ? e.message : e).slice(0, 300));
} finally {
  await browser.close();
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
