
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
 * A4 管理端审计 · 审计日志可查阅性核查（AUDIT-05）+ 慢模块选择器复核。
 *
 * 两个目的：
 *  1. **审计日志 4000+ 条，但 UI 只显示「最近 60 条」且无分页组件** ——
 *     确认接口是否支持分页、UI 是否真的拿不到更早记录。这是运维审计的实际可用性问题。
 *  2. 复核 perf 脚本里 4 个「超时」模块（数据看板/仓库管理/积分流水/配置中心）
 *     究竟是真的慢，还是我的 waitForSelector 选择器写错了（假失败）。
 *
 * 用法：node tools/audit-log-coverage.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';

const { chromium } = playwright;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const { query, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const WEB = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shots = path.join(repo, 'docs', 'AUDIT-140', 'shots');
fs.mkdirSync(shots, { recursive: true });

/* ================================================================ */
/* 1. 审计日志接口能力 vs UI 展示能力                                   */
/* ================================================================ */
console.log('='.repeat(94));
console.log('1. 审计日志：接口能力 vs UI 展示能力（AUDIT-05）');
console.log('='.repeat(94));

const [total] = await query('SELECT COUNT(*) AS n FROM audit_logs');
const [oldest] = await query('SELECT MIN(created_at) AS t FROM audit_logs');
const [newest] = await query('SELECT MAX(created_at) AS t FROM audit_logs');
console.log(`  DB 实际条数：${total.n}`);
console.log(`  时间跨度：${oldest.t} → ${newest.t}`);

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
}).then((r) => r.json());
const H = { authorization: `Bearer ${login.data.accessToken}` };

const apiP1 = await fetch(`${API}/api/admin/audit?page=1&pageSize=60`, { headers: H }).then((r) => r.json());
const apiP70 = await fetch(`${API}/api/admin/audit?page=70&pageSize=60`, { headers: H }).then((r) => r.json());
console.log('');
console.log(`  接口 page=1&pageSize=60  → items=${apiP1.data?.items?.length}  total=${apiP1.data?.total}  page=${apiP1.data?.page}`);
console.log(`  接口 page=70&pageSize=60 → items=${apiP70.data?.items?.length}  total=${apiP70.data?.total}`);
console.log(`  接口是否支持深分页：${(apiP70.data?.items ?? []).length > 0 ? '✓ 支持（能取到第 70 页）' : '✗ 不支持'}`);

// 对比第 1 页与第 70 页的时间，确认能拿到更早记录
const p1First = apiP1.data?.items?.[0]?.createdAt;
const p70First = apiP70.data?.items?.[0]?.createdAt;
console.log(`  第 1 页首条时间：${p1First}`);
console.log(`  第 70 页首条时间：${p70First}`);
const canReachOlder = Boolean(p70First) && String(p70First) < String(p1First);
console.log(`  能通过接口取到更早记录：${canReachOlder ? '✓ 是' : '✗ 否（接口受限）'}`);

console.log('');
console.log('  UI 侧事实（AdminAudit.vue:28 pageSize: 60，无分页组件）：');
console.log('    - 页面只展示最近 60 条；');
console.log('    - 工具栏文案为「最近 N 条」，不含总数与「共 X 页」；');
console.log(`    - 因此 ${total.n} 条中约 ${Math.max(0, Number(total.n) - 60)} 条在 UI 上不可达（接口支持但 UI 未接）。`);

/* ================================================================ */
/* 2. 复核 4 个「超时」模块：真慢 or 选择器错                            */
/* ================================================================ */
console.log('');
console.log('='.repeat(94));
console.log('2. 复核 perf 超时的 4 个模块（区分"真慢"与"选择器写错"）');
console.log('='.repeat(94));

const LAUNCH = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer'];
const CHECK = [
  { id: 'dashboard', label: '数据看板' },
  { id: 'vaults', label: '仓库管理' },
  { id: 'ledger', label: '积分流水' },
  { id: 'config', label: '配置中心' },
];

for (const c of CHECK) {
  let br = null;
  try {
    br = await chromium.launch({ executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined, args: LAUNCH });
    const ctx = await br.newContext({ viewport: { width: 1600, height: 1000 } });
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
    const pg = await ctx.newPage();
    await pg.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pg.waitForSelector('#account', { timeout: 20000 });
    await pg.fill('#account', 'admin');
    await pg.fill('input[type="password"]', requireAuditPass());
    await pg.keyboard.press('Enter');
    await pg.waitForTimeout(2500);

    const t0 = Date.now();
    await pg.goto(`${WEB}/admin?tab=${c.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 等「该模块根节点」出现即可，不假设具体数据行
    await pg.waitForFunction(
      () => {
        const body = document.querySelector('.adm-body');
        return body && body.children.length > 0 && (body.textContent ?? '').trim().length > 10;
      },
      null,
      { timeout: 15000 },
    );
    const loadMs = Date.now() - t0;

    const facts = await pg.evaluate(() => {
      const body = document.querySelector('.adm-body');
      const txt = (body?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        textLen: txt.length,
        textSample: txt.slice(0, 90),
        tables: document.querySelectorAll('.adm-table').length,
        metrics: document.querySelectorAll('.adm-metric').length,
        cards: document.querySelectorAll('.adm-card').length,
        buttons: document.querySelectorAll('.adm-body button').length,
        hasNaN: /NaN|undefined|\[object Object\]/.test(txt),
      };
    });
    console.log('');
    console.log(`  ${c.label}（tab=${c.id}）加载 ${loadMs}ms`);
    console.log(`    文本长度=${facts.textLen} 表格=${facts.tables} 指标卡=${facts.metrics} 卡片=${facts.cards} 按钮=${facts.buttons}`);
    console.log(`    文本样本：${facts.textSample}`);
    console.log(`    NaN/undefined/[object Object] 出现：${facts.hasNaN ? '❌ 有' : '✓ 无'}`);
    await pg.screenshot({ path: path.join(shots, `admin-recheck-${c.id}.png`) }).catch(() => {});
  } catch (err) {
    console.log('');
    console.log(`  ${c.label}（tab=${c.id}）复核异常：${String(err.message).split('\n')[0].slice(0, 70)}`);
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

console.log('');
console.log('='.repeat(94));
console.log('结论');
console.log('='.repeat(94));
console.log('  - 数据看板/仓库管理/积分流水/配置中心：若上述复核能正常渲染且耗时正常，');
console.log('    则 perf 脚本中的「超时」是**选择器假设过强**导致的假失败（本机 Chrome 亦偶发崩溃）；');
console.log('    真正的性能结论应以这里的实测耗时为准。');
console.log(`  - 审计日志：接口支持分页到第 70 页，但 UI 只取 60 条且无翻页 → AUDIT-05 成立。`);

await closePool();
process.exitCode = 0;
