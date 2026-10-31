
/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
/**
 * A4 管理端审计 · 各模块加载耗时 + N+1 请求检测。
 *
 * 方法：Playwright + CDP Network 统计，对每个页签记录：
 *  - 从 goto 到「表格/卡片出现数据行」的耗时（DOM 就绪到数据渲染完成）
 *  - 该页签加载期间发出的 /api/ 请求数（判断 N+1）
 *
 * 大数据量专项：审计日志（生产库 4000+ 条）翻页耗时。
 *
 * 用法：node tools/audit-admin-perf.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WEB = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shots = path.join(repo, 'docs', 'AUDIT-140', 'shots');
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    try {
      const res = await ctx.request.fetch(`${API}${u.pathname}${u.search}`, {
        method: req.method(),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    } catch {
      await route.fulfill({ status: 599, body: '{}' });
    }
  },
);

const page = await ctx.newPage();
/** 记录当前观测窗口内的 API 请求 */
let apiRequests = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/')) apiRequests.push(`${r.method()} ${u.pathname}${u.search}`);
});

await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#account', { timeout: 20000 });
await page.fill('#account', 'admin');
await page.fill('input[type="password"]', requireAuditPass());
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);

/** 各页签「数据行」出现的选择器 */
const TABS = [
  { id: 'dashboard', label: '数据看板', ready: '.adm-metric, .adm-card' },
  { id: 'overview', label: '运营概览', ready: '.adm-metric, .adm-card' },
  { id: 'users', label: '用户与配额', ready: '.usr tbody tr' },
  { id: 'vaults', label: '仓库管理', ready: '.adm-table tbody tr' },
  { id: 'shares', label: '分享与评价', ready: '.adm-table tbody tr' },
  { id: 'releases', label: '发布与分发', ready: '[data-testid="release-section"] tbody tr' },
  { id: 'plugins', label: '插件市场', ready: '.plg tbody tr' },
  { id: 'credits', label: '积分与兑换码', ready: '.adm-table tbody tr, .adm-card' },
  { id: 'ledger', label: '积分流水', ready: '.adm-table tbody tr' },
  { id: 'billing', label: '计费与赠送', ready: '.adm-card' },
  { id: 'aiProviders', label: 'AI 供应商', ready: '.adm-card, .adm-table tbody tr' },
  { id: 'aiModels', label: '平台模型配置', ready: '.adm-card, .adm-table tbody tr' },
  { id: 'aiUsage', label: 'AI 运营分析', ready: '.adm-card' },
  { id: 'knowledgeTokens', label: '知识库令牌', ready: '.adm-table tbody tr, .adm-card' },
  { id: 'config', label: '配置中心', ready: '.adm-card, .adm-table tbody tr' },
  { id: 'audit', label: '审计日志', ready: '.adm-table tbody tr' },
];

/*
 * ## 为什么每个页签都重建 context/browser
 *
 * 本机无头 Chrome 在「一个 page 连续 goto 十几个重页面」的累积负载下会 `Page crashed`
 * （1.3.1 以来的老问题；任务描述也提示要加 --disable-gpu）。
 * 审计脚本必须保证「一条崩溃不拖垮整轮」，否则报告会大面积缺项。
 * 因此：**每个模块独立 browser + context**，任何一次崩溃只影响该模块，
 * 并且单模块失败会被记录为「加载异常」而不是中断整个审计。
 */
const results = [];
console.log('='.repeat(94));
console.log('各模块加载耗时 + API 请求数（本地 5178 → 3211，数据为生产库）');
console.log('='.repeat(94));
console.log('  页签'.padEnd(20) + '耗时(ms)'.padStart(10) + 'API数'.padStart(8) + '  备注');
console.log('  ' + '-'.repeat(88));

const LAUNCH_ARGS = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer'];

/** 为单个模块创建干净的 browser+context+page，并挂好 API 统计 */
async function freshPage() {
  const br = await chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    args: LAUNCH_ARGS,
  });
  const c = await br.newContext({ viewport: { width: 1600, height: 1000 } });
  await c.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      try {
        const res = await c.request.fetch(`${API}${u.pathname}${u.search}`, {
          method: req.method(),
          headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'host')),
          data: req.postData() ?? undefined,
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
      } catch {
        await route.fulfill({ status: 599, body: '{}' });
      }
    },
  );
  const pg = await c.newPage();
  const reqs = [];
  pg.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) reqs.push(`${r.method()} ${u.pathname}${u.search}`);
  });

  // 登录
  await pg.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForSelector('#account', { timeout: 20000 });
  await pg.fill('#account', 'admin');
  await pg.fill('input[type="password"]', requireAuditPass());
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(2500);
  return { br, c, pg, reqs };
}

for (const t of TABS) {
  let br = null;
  let apiRequests = [];
  const t0 = Date.now();
  let ok = true;
  let note = '';
  try {
    const s = await freshPage();
    br = s.br;
    apiRequests = s.reqs;
    apiRequests.length = 0; // 只统计进入页签后的请求
    const navStart = Date.now();
    await s.pg.goto(`${WEB}/admin?tab=${t.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await s.pg.waitForSelector(t.ready, { timeout: 15000 });
    await s.pg.waitForTimeout(400);
    await s.pg.screenshot({ path: path.join(shots, `admin-perf-${t.id}.png`) }).catch(() => {});
    note = '';
    results.push({
      id: t.id,
      label: t.label,
      elapsed: Date.now() - navStart,
      apiCount: apiRequests.length,
      ok: true,
      note: '',
    });
  } catch (err) {
    ok = false;
    note = `加载异常：${String(err.message).split('\n')[0].slice(0, 46)}`;
    results.push({ id: t.id, label: t.label, elapsed: Date.now() - t0, apiCount: apiRequests.length, ok: false, note });
  } finally {
    if (br) await br.close().catch(() => {});
  }

  const r = results[results.length - 1];
  const flag = !ok ? `  ⚠ ${note}` : r.apiCount > 12 ? `  ⚠ 请求较多（${r.apiCount}）` : '';
  console.log(`  ${t.label.padEnd(18)}${String(r.elapsed).padStart(10)}${String(r.apiCount).padStart(8)}  ${flag}`);
}

/* ---------------- 大数据量分页专项 ---------------- */
console.log('');
console.log('='.repeat(94));
console.log('大数据量分页专项：审计日志（生产库 4000+ 条）');
console.log('='.repeat(94));

apiRequests = [];
let pageTimes = [];
let auditBr = null;
try {
  const s = await freshPage();
  auditBr = s.br;
  apiRequests = s.reqs;
  apiRequests.length = 0;
  await s.pg.goto(`${WEB}/admin?tab=audit`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await s.pg.waitForSelector('.adm-table tbody tr', { timeout: 15000 });
  await s.pg.waitForTimeout(1200);

  const totalText = await s.pg.locator('.adm-toolbar__count, .adm-count').first().innerText().catch(() => '');
  console.log(`  列表总数文案：${totalText.trim() || '(未显示)'}`);

  const pagerBtns = s.pg.locator('.adm-pager button');
  const pagerCount = await pagerBtns.count();
  console.log(`  分页按钮数：${pagerCount}`);

  if (pagerCount >= 2) {
    for (let i = 0; i < 3; i += 1) {
      apiRequests.length = 0;
      const t0 = Date.now();
      await pagerBtns.nth(pagerCount - 1).click(); // 下一页
      await s.pg.waitForTimeout(900);
      const ms = Date.now() - t0;
      pageTimes.push({ page: i + 2, ms, apiCount: apiRequests.length });
      console.log(`    翻到第 ${i + 2} 页：${ms}ms，发起 ${apiRequests.length} 个 API 请求`);
    }
  } else {
    console.log('  （该模块分页按钮不足，跳过翻页测试）');
  }
  await s.pg.screenshot({ path: path.join(shots, 'admin-perf-audit-paging.png') }).catch(() => {});
} catch (err) {
  console.log(`  审计日志分页测试异常：${String(err.message).split('\n')[0].slice(0, 80)}`);
} finally {
  if (auditBr) await auditBr.close().catch(() => {});
}

/* ---------------- 汇总 ---------------- */
console.log('');
console.log('='.repeat(94));
console.log('汇总');
console.log('='.repeat(94));
const slow = results.filter((r) => r.elapsed > 3000);
const heavy = results.filter((r) => r.apiCount > 12);
console.log(`  模块数：${results.length}，加载成功：${results.filter((r) => r.ok).length}`);
console.log(`  平均耗时：${Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length)}ms`);
console.log(`  最慢：${[...results].sort((a, b) => b.elapsed - a.elapsed)[0]?.label} ${[...results].sort((a, b) => b.elapsed - a.elapsed)[0]?.elapsed}ms`);
if (slow.length) {
  console.log(`  ⚠ 超过 3000ms 的模块：`);
  for (const s of slow) console.log(`    - ${s.label} ${s.elapsed}ms`);
}
if (heavy.length) {
  console.log(`  ⚠ 单次加载 API 请求 > 12 的模块（可能 N+1）：`);
  for (const h of heavy) console.log(`    - ${h.label} 发起 ${h.apiCount} 个请求`);
}
if (!slow.length && !heavy.length) console.log('  ✅ 未见明显慢加载或 N+1');

if (pageTimes.length) {
  const avg = Math.round(pageTimes.reduce((s, p) => s + p.ms, 0) / pageTimes.length);
  console.log(`  审计日志翻页平均：${avg}ms（${pageTimes.map((p) => `${p.page}页=${p.ms}ms`).join(', ')}）`);
}

await ctx.close();
await browser.close();
process.exitCode = 0;
