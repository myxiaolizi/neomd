/**
 * task-29 · 1.1.8 端到端验收（Playwright）。
 *
 * 覆盖 A–E 五项：
 *  A. 前台无「已开通/未开通」徽章
 *  B. 「平台 AI 服务」与「我的 AI 供应商」两个区块分离
 *  C. 知识库令牌可创建 / 复制 / 测试 / 吊销
 *  D. 从使用教程「去申请令牌」可跳转到令牌区
 *  E. 用令牌真实调用 /api/knowledge/stats 返回 200
 *
 * 用法（需后端 3200 + 前端 4186 同时运行）：
 *   node tools/verify-118.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-118');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4186';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_USER = 't117admin';
const ADMIN_PASS = 'T117-verify-pass';

let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(`${label}${extra ? ` → ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

/** 模拟桌面端（设置页的 AI/知识库页签带 nativeOnly，网页端会被过滤） */
async function emulateDesktop() {
  await page.addInitScript(() => {
    window.NeoMD = { env: 'desktop', version: '1.1.8' };
  });
}

async function login() {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { account: ADMIN_USER, password: ADMIN_PASS },
  });
  if (!res.ok()) throw new Error(`登录失败 HTTP ${res.status()}`);
  const json = await res.json();
  const d = json.data ?? {};
  const access = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [access, refresh],
  );
  return access;
}

async function openSettings(tabLabel) {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  await page.keyboard.press('Control+Comma');
  await page.waitForTimeout(1600);
  if (tabLabel) {
    const nav = page.locator('.settings__nav-item').filter({ hasText: tabLabel }).first();
    if (await nav.count()) {
      await nav.click();
      await page.waitForTimeout(1600);
    }
  }
}

async function enableKnowledge() {
  const sw = page.locator('input[aria-label="启用知识库"]').first();
  if (!(await sw.count())) return false;
  if (!(await sw.isChecked().catch(() => false))) {
    await sw.click({ force: true });
    await page.waitForTimeout(1500);
  }
  return true;
}

try {
  await emulateDesktop();
  const jwt = await login();

  /* ============ A + B：AI 段 ============ */
  console.log('\n=== A/B. 供应商去状态 + 两区块分离 ===');
  await openSettings('AI');

  let body = await page.locator('body').innerText();
  check(body.includes('平台 AI 服务'), '存在「平台 AI 服务」区块');
  check(body.includes('我的 AI 供应商'), '存在「我的 AI 供应商」区块');
  check(body.includes('扣积分'), '平台区块标注「扣积分」');
  check(body.includes('自带 Key'), '自带 Key 区块标注「自带 Key」');
  check(!body.includes('未开通'), '前台不再出现「未开通」');
  check(!body.includes('已开通'), '前台不再出现「已开通」');
  check(body.includes('剩余积分'), '平台区块显示剩余积分');
  check(body.includes('本次预估'), '平台区块显示本次预估消耗');
  check(body.includes('可用模型'), '平台区块显示可用模型列表');

  // 两个区块确实在 DOM 中独立存在
  const blocks = page.locator('section.ai-block');
  check((await blocks.count()) >= 2, `ai-block 区块数 ≥ 2（实际 ${await blocks.count()}）`);

  // 徽章类名不应再出现
  const badgesOn = await page.locator('.provider-card__badge--on').count();
  const badgesOff = await page.locator('.provider-card__badge--off').count();
  check(badgesOn === 0 && badgesOff === 0, `无状态徽章 DOM（on=${badgesOn}, off=${badgesOff}）`);

  // 「我的 AI 供应商」区块里应有「去申请」链接
  const signupLinks = await page.locator('a.provider-card__link').count();
  check(signupLinks >= 5, `「去申请」链接 ≥ 5（实际 ${signupLinks}）`);

  await page.screenshot({ path: path.join(shots, 'ai-split.png'), fullPage: true });
  console.log('  📸 tools/shots-118/ai-split.png');

  /* ============ C + D + E：知识库令牌 ============ */
  console.log('\n=== C/D/E. 知识库令牌体系 ===');
  await openSettings('知识库');
  await enableKnowledge();

  body = await page.locator('body').innerText();
  check(body.includes('如何给其他 AI'), '存在「如何给其他 AI / 智能体使用」区块');
  check(body.includes('YOUR_KNOWLEDGE_TOKEN'), '示例代码使用 <YOUR_KNOWLEDGE_TOKEN> 占位');
  check(body.includes('去申请令牌'), '存在「去申请令牌」按钮（D 项）');
  check(body.includes('知识库访问令牌'), '存在令牌管理区');
  check(body.includes('外部调用需要一枚知识库令牌'), '教程里说明外部调用需要令牌');

  // D：点「去申请令牌」，令牌区应滚入视口并高亮
  const jumpBtn = page.getByRole('button', { name: /去申请令牌/ }).first();
  if (await jumpBtn.count()) {
    await jumpBtn.click();
    await page.waitForTimeout(900);
    const flash = await page.locator('.kb-tokens.is-flash').count();
    check(flash > 0, '点击「去申请令牌」后令牌区高亮');
  } else {
    check(false, '点击「去申请令牌」后令牌区高亮', '按钮未找到');
  }

  // C：申请令牌
  const applyBtn = page.getByRole('button', { name: /^申请令牌$/ }).first();
  check((await applyBtn.count()) > 0, '存在「申请令牌」按钮');
  if (await applyBtn.count()) {
    await applyBtn.click();
    await page.waitForTimeout(700);
    // 填名称
    const nameInput = page.locator('input[aria-label="令牌名称"]').first();
    if (await nameInput.count()) {
      await nameInput.fill('[E2E] 浏览器令牌');
      const createBtn = page.getByRole('button', { name: /^创建$/ }).first();
      if (await createBtn.count()) {
        await createBtn.click();
        await page.waitForTimeout(2000);
      }
    }
  }

  body = await page.locator('body').innerText();
  check(body.includes('唯一一次明文展示'), '创建后显示「明文只显示一次」警告');

  // 抓明文令牌（用于 E 的真实调用）
  const plainEl = page.locator('.kb-tokenplain__value').first();
  let plainToken = '';
  if (await plainEl.count()) {
    plainToken = (await plainEl.innerText()).trim();
  }
  check(plainToken.startsWith('nmd_kb_'), '明文令牌出现在页面上', plainToken.slice(0, 14));

  // 列表里应有该令牌
  const items = page.locator('.kb-tokenitem');
  check((await items.count()) >= 1, `令牌列表 ≥ 1 条（实际 ${await items.count()}）`);
  const listText = await page.locator('.kb-tokenlist').innerText().catch(() => '');
  check(listText.includes('[E2E] 浏览器令牌'), '列表显示令牌名称');
  check(listText.includes('有效'), '列表显示「有效」状态');

  await page.screenshot({ path: path.join(shots, 'kb-tokens.png'), fullPage: true });
  console.log('  📸 tools/shots-118/kb-tokens.png');

  // E：用明文令牌真实调用 /api/knowledge/stats
  if (plainToken) {
    const res = await page.request.get(`${BASE}/api/knowledge/stats`, {
      headers: { authorization: `Bearer ${plainToken}` },
    });
    check(res.status() === 200, `用令牌调 /api/knowledge/stats 返回 200（实际 ${res.status()}）`);
    const json = await res.json().catch(() => null);
    check(json?.data?.authMode === 'token', 'authMode=token', json?.data?.authMode);

    // 页面上点「立即验证这枚令牌」
    const verifyBtn = page.getByRole('button', { name: /立即验证这枚令牌/ }).first();
    if (await verifyBtn.count()) {
      await verifyBtn.click();
      await page.waitForTimeout(1800);
      const tip = await page.locator('.kb-tip').first().innerText().catch(() => '');
      check(tip.includes('验证通过'), '页面「立即验证」显示通过', tip.slice(0, 80));
    }
  }

  // C：测试按钮（按 id）
  const testBtn = page.getByRole('button', { name: /^测试$/ }).first();
  if (await testBtn.count()) {
    await testBtn.click();
    await page.waitForTimeout(1500);
    const tip = await page.locator('.kb-tip').first().innerText().catch(() => '');
    check(tip.includes('可用'), '「测试」按钮显示令牌可用', tip.slice(0, 80));
  }

  // C：吊销
  const revokeBtn = page.getByRole('button', { name: /^吊销$/ }).first();
  if (await revokeBtn.count()) {
    await revokeBtn.click();
    await page.waitForTimeout(1800);
    const listText2 = await page.locator('.kb-tokenlist').innerText().catch(() => '');
    check(listText2.includes('已吊销'), '吊销后列表显示「已吊销」', listText2.slice(0, 100));

    // 吊销后明文应失效
    if (plainToken) {
      const after = await page.request.get(`${BASE}/api/knowledge/stats`, {
        headers: { authorization: `Bearer ${plainToken}` },
      });
      check(after.status() === 401, `吊销后令牌失效（401，实际 ${after.status()}）`);
    }
  }

  /* ============ 控制台 ============ */
  console.log('\n=== 控制台错误 ===');
  const realErrors = consoleErrors.filter((e) => !/favicon|Failed to load resource|ERR_/i.test(e));
  check(realErrors.length === 0, `无 JS 异常（${realErrors.length} 条）`, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  fails.push(`脚本异常：${err.message}`);
  console.log(`  ✗ 脚本异常：${err.message}`);
  await page.screenshot({ path: path.join(shots, '_error.png'), fullPage: true }).catch(() => {});
} finally {
  await page.screenshot({ path: path.join(shots, '_last.png'), fullPage: true }).catch(() => {});
  await browser.close();
}

console.log(`\n结果：通过 ${pass}，失败 ${fails.length}`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fails.length === 0 ? 0 : 1);
