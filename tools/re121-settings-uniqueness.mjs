/**
 * 1.2.1 缺陷6 验收：设置项唯一性断言（Playwright 真实浏览器）。
 *
 * ## 断言口径
 *
 * 「设置项重复」不是只看字体那三项 —— 必须**遍历所有页签、统计全页每一个
 * 控件标签的出现次数**，任何一个 > 1 都算重复。这里统计三类：
 *
 *   1. `aria-label`（无障碍名，控件真正的语义标识；改文案也不会变）
 *   2. `.nm-label` 文本（用户看到的字段标题）
 *   3. 已登记的 `data-testid`（防止同一控件在两处挂了同一个 testid）
 *
 * 例外：`label` 里有少数**允许重复的组标题**（例如多个页签都有「主题」「应用范围」
 * 这类小标题，或同一页签内重复的按钮文字）。这些在 ALLOW_DUPLICATE 里显式列明，
 * 且**必须在报告里打印出来**，避免用白名单掩盖真正的重复。
 *
 * ## 复用到 QA
 *
 * 选择器与期望都写在文件头的 SELECTORS 常量里，QA 可直接引用；
 * 退出码 0 = 无重复，1 = 有重复（可直接挂 CI）。
 *
 * 用法：node tools/re121-settings-uniqueness.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-121-settings');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.RE121_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

/**
 * 供 QA 复用的选择器契约。
 *
 * 页签导航：`.settings__nav [role="tab"]`（文本 = 页签名）
 * 控件标签：`.pane .nm-label`
 * 无障碍名：`.pane [aria-label]`
 * 测试钩子：`.pane [data-testid]`
 */
const SELECTORS = {
  navTabs: '.settings__nav [role="tab"]',
  pane: '.pane',
  label: '.pane .nm-label',
  ariaLabel: '.pane [aria-label]',
  testId: '.pane [data-testid]',
};

/**
 * 允许重复的标签（组标题 / 按钮文案 / 选项值）。
 *
 * 这些**不是设置项本身**：例如「主题」在「通用」页签是分段按钮的组标题，
 * 在「主题」页签是页面标题；「恢复默认」这类按钮在不同区块出现也是合理的。
 * 白名单必须保持很短，且每一项都要能说清为什么合理。
 */
const ALLOW_DUPLICATE = new Set([
  // 组标题：不同页签各自的小标题，语义上属于不同页面
  '主题',
  '外观',
  '边框',
  '正文背景',
  '正文文字',
  '界面背景',
  '强调色',
  '明暗基调',
  '位置',
  '服务商',
  '地域',
  '模型',
  'Base URL',
  'AccessKey ID',
  'AccessKey Secret',
  // 按钮文案（不是设置项）
  '恢复默认字体',
  '取消',
  '导入',
  '开',
  '关',
  '删除',
]);

/**
 * `data-testid` 的统计口径与 label 不同 —— 这里显式排除「列表渲染的模板复用」。
 *
 * ## 为什么必须排除（写给后来人，避免被误判成回归）
 *
 * label / aria-label 标识的是「**一个设置项**」，同一名字出现两次就是缺陷
 * （用户在两个地方看到同一项，改哪个都不确定）。
 *
 * 但 `data-testid` 还挂在**列表行内的元素**上。例如「仓库」页签的仓库列表：
 * 每一行都由同一个模板渲染，所以 `vm-row` / `vm-delete` / `vm-sync` 这些 testid
 * 会随仓库数量出现 N 次（本次实测 6 个仓库 → 每个出现 6 次）。
 * 这是「一个控件模板渲染 N 行」，**不是**「同一个设置项在两个位置各有一个入口」，
 * 因此不属于缺陷6，必须排除在「重复项」判定之外，否则每次仓库数量一变这个断言就红。
 *
 * 排除方式：按 testid 前缀识别列表行元素（见 LIST_ROW_TESTID），
 * 被排除的项**仍然完整打印在报告里**（列为「列表行内 testid」），
 * 只是不计入 blocking —— 既不掩盖问题，也不制造噪声。
 */
const LIST_ROW_TESTID = /^(vm-|vault-|row-|item-|list-)/;

const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 统计一个数组里的出现次数 */
function countBy(list) {
  const map = new Map();
  for (const item of list) {
    if (!item) continue;
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return map;
}

let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fails.push(`${label}${extra ? ` \u2192 ${extra}` : ''}`);
    console.log(`  \u2717 ${label}${extra ? ` \u2192 ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({
  executablePath: BROWSER,
  // `--disable-gpu` 必需：本机无头 Chrome 不带它约 30s 后崩溃（见 re121-settings-font-repro.mjs 注释）
  args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

try {
  /* ------------------------------ 登录 ------------------------------ */
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const d = (await loginRes.json()).data ?? {};
  const token = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [token, refresh],
  );
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  /* --------------------------- 打开设置页 --------------------------- */
  if (!(await page.locator('.settings-page').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForTimeout(1800);
  }
  check((await page.locator('.settings-page').count()) > 0, '设置页已打开');

  const tabs = await page.locator(SELECTORS.navTabs).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
  );
  console.log(`\n页签（${tabs.length} 个）：${tabs.join(' / ')}`);

  /* ---------------- 逐页签采集，再把所有页签的标签汇总 ---------------- */
  const collected = { labels: [], ariaLabels: [], testIds: [] };
  const perTab = [];

  for (const tabName of tabs) {
    const tab = page.locator(SELECTORS.navTabs).filter({ hasText: tabName }).first();
    if (!(await tab.count())) continue;
    await tab.click();
    await page.waitForTimeout(600);

    const labels = await page
      .locator(SELECTORS.label)
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    const ariaLabels = await page
      .locator(SELECTORS.ariaLabel)
      .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').trim()));
    const testIds = await page
      .locator(SELECTORS.testId)
      .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').trim()));

    const clean = (arr) => arr.map(normalize).filter(Boolean);
    collected.labels.push(...clean(labels));
    collected.ariaLabels.push(...clean(ariaLabels));
    collected.testIds.push(...clean(testIds));
    perTab.push({ tab: tabName, labels: clean(labels), ariaLabels: clean(ariaLabels), testIds: clean(testIds) });
    console.log(`  [${tabName}] label ${clean(labels).length} / aria-label ${clean(ariaLabels).length} / testid ${clean(testIds).length}`);
  }

  /* --------------------------- 统计与断言 --------------------------- */
  console.log('\n=== 全页统计（跨所有页签累加） ===');
  const report = {};
  for (const kind of ['labels', 'ariaLabels', 'testIds']) {
    const counts = countBy(collected[kind]);
    const dups = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    const isListRow = (name) => kind === 'testIds' && LIST_ROW_TESTID.test(name);
    const blocking = dups.filter(([name]) => !ALLOW_DUPLICATE.has(name) && !isListRow(name));
    const allowed = dups.filter(([name]) => ALLOW_DUPLICATE.has(name));
    const listRows = dups.filter(([name]) => isListRow(name));
    report[kind] = { total: collected[kind].length, unique: counts.size, dups, blocking, allowed, listRows };

    console.log(
      `\n${kind}：共 ${collected[kind].length} 处，去重后 ${counts.size} 个不同项，` +
        `重复 ${dups.length} 项（其中需修复 ${blocking.length} 项，白名单 ${allowed.length} 项，列表行 ${listRows.length} 项）`,
    );
    if (blocking.length) {
      console.log('  ✗ 需修复的重复项：');
      for (const [name, n] of blocking) {
        // 打印出它出现在哪些页签，便于定位
        const where = perTab
          .filter((t) => (kind === 'labels' ? t.labels : kind === 'ariaLabels' ? t.ariaLabels : t.testIds).includes(name))
          .map((t) => t.tab);
        console.log(`    - "${name}" 出现 ${n} 次，页签：${where.join(' / ')}`);
      }
    }
    if (listRows.length) {
      console.log(
        '  · 列表行内 testid（同一模板渲染 N 行，非设置项重复；按 LIST_ROW_TESTID 前缀排除，不判失败）：',
      );
      for (const [name, n] of listRows) console.log(`    - "${name}" 出现 ${n} 次`);
    }
    if (allowed.length) {
      console.log('  · 白名单内（组标题/按钮文案，非设置项）：');
      for (const [name, n] of allowed) console.log(`    - "${name}" 出现 ${n} 次`);
    }
  }

  check(report.labels.blocking.length === 0, `label 重复项为 0（发现 ${report.labels.blocking.length} 项）`);
  check(
    report.ariaLabels.blocking.length === 0,
    `aria-label 重复项为 0（发现 ${report.ariaLabels.blocking.length} 项）`,
  );
  check(report.testIds.blocking.length === 0, `data-testid 重复项为 0（发现 ${report.testIds.blocking.length} 项）`);
  /* ----------------- 重点核对：字体/排版类控件必须唯一 ----------------- */
  console.log('\n=== 关键控件唯一性核对（缺陷6 的三个重复项） ===');
  const KEY_LABELS = ['正文字体', '正文字号（px）', '正文行高', '正文缩放（50% - 300%）'];
  for (const key of KEY_LABELS) {
    const n = collected.labels.filter((l) => l === key).length;
    check(n === 1, `「${key}」全页出现 1 次`, `实际 ${n} 次`);
  }
  const KEY_ARIA = ['正文字体', '编辑器正文字号', '编辑器正文行高', '正文缩放比例', '显示正文行号', '拼写检查'];
  for (const key of KEY_ARIA) {
    const n = collected.ariaLabels.filter((a) => a === key).length;
    check(n === 1, `aria-label「${key}」全页出现 1 次`, `实际 ${n} 次`);
  }

  /* ------------- 主题页签不得再出现排版类控件（信息架构收敛） ------------- */
  console.log('\n=== 主题页签不应含排版控件 ===');
  const themeTab = perTab.find((t) => t.tab === '主题');
  if (themeTab) {
    for (const forbidden of ['正文字体', '正文字号（px）', '正文行高', '正文缩放（50% - 300%）']) {
      check(
        !themeTab.labels.includes(forbidden),
        `主题页签不含「${forbidden}」`,
        themeTab.labels.includes(forbidden) ? '仍然存在' : '',
      );
    }
  }

  await page.screenshot({ path: path.join(shots, 'settings-uniqueness.png'), fullPage: true });
  fs.writeFileSync(
    path.join(shots, 'settings-uniqueness.json'),
    JSON.stringify({ tabs, perTab, report: Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { total: v.total, unique: v.unique, dups: v.dups, blocking: v.blocking }])) }, null, 2),
  );
} catch (e) {
  fails.push(`脚本异常：${e?.message ?? e}`);
  console.log(`\n[ERROR] ${e?.stack ?? e}`);
} finally {
  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) {
    console.log('失败明细：');
    for (const f of fails) console.log(`  - ${f}`);
  }
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}
