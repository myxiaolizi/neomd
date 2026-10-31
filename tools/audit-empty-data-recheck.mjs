
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
 * A4 管理端审计 · 关键复核：模块显示「0 数据」是真实为空，还是鉴权/取数失败？
 *
 * ## 为什么必须查这一条
 *
 * audit-log-coverage.mjs 复核时，这 4 个模块在 ~190ms 内渲染完成，但页面文本是：
 *   - 仓库管理：「仓库总数 0 / 文档总数 0 / 共 0 个仓库」
 *   - 积分流水：「共 0 条」
 *   - 配置中心：「共 0 项」
 * 而 DB 里明明有 4 个仓库、73 条流水、若干配置项。
 *
 * 两种可能，结论完全相反：
 *   (a) **接口真的返回空**（数据/权限问题，属高危）；
 *   (b) **页面还没加载完我就采样了**（脚本假阴性），或 route 转发/鉴权在子请求上失败。
 *
 * 本脚本用「同一个 ready 信号 + 明确等待数据或错误出现」的方式复测，
 * 并直接抓取页面发出的 API 响应体，逐个比对。
 *
 * 用法：node tools/audit-empty-data-recheck.mjs
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

const LAUNCH = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-software-rasterizer'];

const CHECKS = [
  { id: 'vaults', label: '仓库管理', api: '/api/admin/vaults', pick: (d) => `total=${d?.total} items=${(d?.items ?? []).length}` },
  { id: 'ledger', label: '积分流水', api: '/api/admin/ledger', pick: (d) => `total=${d?.total} items=${(d?.items ?? []).length}` },
  { id: 'config', label: '配置中心', api: '/api/admin/config', pick: (d) => `items=${(d?.items ?? []).length}` },
  { id: 'dashboard', label: '数据看板', api: '/api/admin/dashboard', pick: (d) => `users.total=${d?.metrics?.users?.total}` },
];

for (const c of CHECKS) {
  let br = null;
  console.log('');
  console.log('='.repeat(94));
  console.log(`${c.label}（tab=${c.id}）`);
  console.log('='.repeat(94));
  try {
    br = await chromium.launch({ executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined, args: LAUNCH });
    const ctx = await br.newContext({ viewport: { width: 1600, height: 1000 } });

    /** 收集页面实际收到的 API 响应 */
    const captured = [];
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
          const body = await res.body();
          let json = null;
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            json = null;
          }
          captured.push({ path: u.pathname + u.search, status: res.status(), json });
          await route.fulfill({ status: res.status(), headers: res.headers(), body });
        } catch (e) {
          captured.push({ path: u.pathname + u.search, status: 599, json: null, err: String(e) });
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
    await pg.waitForTimeout(3000);

    captured.length = 0;
    const t0 = Date.now();
    await pg.goto(`${WEB}/admin?tab=${c.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    /*
     * 关键：等待「数据或错误」明确出现，而不是只等 DOM 有内容。
     * 给到 12 秒，并轮询页面文本变化（空态文案 vs 有数据）。
     */
    await pg
      .waitForFunction(
        () => {
          const txt = (document.querySelector('.adm-body')?.textContent ?? '').replace(/\s+/g, ' ');
          // 出现"加载中"说明还没好；否则认为渲染已定
          return txt.length > 20 && !/加载中/.test(txt);
        },
        null,
        { timeout: 12000 },
      )
      .catch(() => {});
    const ms = Date.now() - t0;
    await pg.waitForTimeout(1200); // 再给异步请求一点时间落地

    const txt = (await pg.locator('.adm-body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`  渲染耗时：${ms}ms`);
    console.log(`  页面文本：${txt.slice(0, 150)}`);
    console.log('');
    console.log('  页面实际收到的 API 响应：');
    const target = captured.filter((x) => x.path.startsWith(c.api));
    if (!target.length) console.log(`    ⚠ 未捕获到 ${c.api} 请求`);
    for (const t of target) {
      console.log(`    ${t.path} → HTTP ${t.status}  ${c.pick(t.json?.data)}`);
      if (t.json && t.json.ok === false) console.log(`      错误：${JSON.stringify(t.json.error)}`);
    }
    const other = captured.filter((x) => !x.path.startsWith(c.api));
    if (other.length) {
      console.log('    其它请求：');
      for (const o of other.slice(0, 6)) console.log(`      ${o.path} → HTTP ${o.status}`);
    }

    console.log('');
    const hasData = target.some((t) => {
      const d = t.json?.data;
      if (!d) return false;
      if (Array.isArray(d.items)) return d.items.length > 0;
      if (typeof d.total === 'number') return d.total > 0;
      if (d.metrics) return Number(d.metrics?.users?.total ?? 0) > 0;
      return false;
    });
    console.log(`  判定：${hasData ? '✓ 接口有数据 → 页面空白是脚本采样过早（假阴性）' : '❌ 接口确实返回空/失败 → 真实缺陷'}`);
    await pg.screenshot({ path: path.join(shots, `admin-recheck2-${c.id}.png`) }).catch(() => {});
  } catch (err) {
    console.log(`  异常：${String(err.message).split('\n')[0].slice(0, 90)}`);
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

console.log('');
console.log('='.repeat(94));
console.log('说明');
console.log('='.repeat(94));
console.log('  若各模块接口均返回真实数据，则前一脚本的「0 数据」是**采样时机问题**，');
console.log('  不构成产品缺陷；真正的缺陷清单以本脚本与 audit-log-coverage 的结论为准。');

process.exitCode = 0;
