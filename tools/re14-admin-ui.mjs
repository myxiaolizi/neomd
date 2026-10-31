/**
 * Neo MD 1.4 · 后台组 T2 浏览器实拍与 UI 断言。
 *
 * 验证的是**真实渲染出来的后台界面**（不是接口 JSON），因此能抓住接口对了但 UI 接错的问题：
 *   - 插件市场：20/页分页 UI、翻页回顶部、页码进 URL、编辑弹窗、校验拦截、保存反馈
 *   - 客户端分发：当前版本徽标 == package.json 版本、大小/时间/下载次数/可下载性列都在
 *   - 用户管理：批量操作条、封禁弹窗、登录记录 tab、数据概览卡片、导出按钮
 *
 * 截图统一落 `docs/shots-140/`。
 *
 * ## 关于 API 转发（重要）
 *
 * 3200 上的 API 进程是 `node src/server.js`（**没有 --watch**），本组新代码不会热生效；
 * 而任务要求「绝不重启、绝不占用 3200」。因此：
 *   - 前端 dev 5178 照常使用（不要重启它）；
 *   - 用 Playwright 的 route 拦截，把发给 5178 的 `/api/**` 请求**转发到临时 3211 实例**；
 *   - 截图与断言因此反映的是「5178 前端 + 3211 新后端」的真实组合。
 *
 * 报告里凡引用本脚本的数据，都必须注明是 3211 实例。
 *
 * 用法：
 *   node tools/re14-admin-ui.mjs
 *   API_BASE=http://127.0.0.1:3211 WEB_BASE=http://127.0.0.1:5178 node tools/re14-admin-ui.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const shots = path.join(repo, 'docs', 'shots-140');
fs.mkdirSync(shots, { recursive: true });

const WEB_BASE = (process.env.WEB_BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const BROWSER = process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '6655';

let pass = 0;
const failures = [];

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${extra ? `  [${extra}]` : ''}`);
  }
}

function section(t) {
  console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);
}

/** 读 services/api/package.json 的 version —— 需求4 断言的唯一期望值 */
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repo, 'services', 'api', 'package.json'), 'utf8')).version;

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  // 本机无头 Chrome 无 --disable-gpu 时约 30s 就崩（1.3.1 期间的踩坑记录）
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

/*
 * 把 /api/** 转发到临时 3211 实例（3200 无 --watch，新代码不生效）。
 *
 * 注意匹配方式：**不能用 glob `**\/api/**`** —— 它会连同 Vite 的模块请求
 * `/src/api/client.ts` 一起拦下来，导致整个前端白屏（本项目实测踩过：
 * 表现为登录页 0 个 input、控制台 503）。必须按 pathname 精确判断「以 /api/ 开头」。
 */
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const target = `${API_BASE}${url.pathname}${url.search}`;
    const headers = { ...req.headers() };
    delete headers.host;
    try {
      const res = await context.request.fetch(target, {
        method: req.method(),
        headers,
        data: req.postData() ?? undefined,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const buf = await res.body();
      await route.fulfill({
        status: res.status(),
        headers: res.headers(),
        body: buf,
      });
    } catch (e) {
      await route.fulfill({ status: 599, body: JSON.stringify({ ok: false, error: { message: String(e) } }) });
    }
  },
);

const page = await context.newPage();
const jsErrors = [];
/** 记录所有 4xx/5xx 响应（含 URL），便于把「控制台 404」定位到具体资源 */
const httpErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') jsErrors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
});

async function shot(name) {
  const file = path.join(shots, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`        截图 → docs/shots-140/${name}`);
  return file;
}

/** 打开后台并切到指定页签（用侧栏 data-tab 定位，稳定不依赖文案） */
async function openTab(tab) {
  await page.click(`[data-testid="admin-nav"] [data-tab="${tab}"]`);
  await page.waitForTimeout(900);
}

try {
  /* ---------------- 登录 ---------------- */
  section('0. 登录并进入后台');
  await page.goto(`${WEB_BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // 登录页的账号框是 `#account`（LoginPage.vue:86），密码框 type=password
  await page.waitForSelector('#account', { timeout: 20000 });
  await page.fill('#account', ADMIN_USER);
  await page.fill('input[type="password"]', ADMIN_PASS);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);
  await page.goto(`${WEB_BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const navCount = await page.locator('[data-testid="admin-nav-item"]').count();
  check(navCount >= 16, '0a 后台侧栏渲染完整（≥16 个页签）', `count=${navCount}`);

  /* ---------------- 需求4：客户端分发 ---------------- */
  section('1. 需求4 · 客户端分发显示当前版本（== package.json）');
  await openTab('releases');
  await page.waitForTimeout(1500);
  check(await page.locator('[data-testid="release-section"]').count() > 0, '1a 客户端分发区块存在');

  const curVerText = (await page.locator('[data-testid="current-version"]').innerText().catch(() => '')).trim();
  check(curVerText.includes(pkgVersion), '1b 页面显示当前版本 == services/api/package.json', `页面="${curVerText}" pkg=${pkgVersion}`);

  // 表头必须含 大小/时间/下载次数/可下载性/存放位置
  const headers = await page.locator('[data-testid="release-section"] thead th').allInnerTexts();
  const headerText = headers.join('|');
  check(headerText.includes('大小'), '1c 有「大小」列');
  check(headerText.includes('更新时间'), '1d 有「更新时间」列');
  check(headerText.includes('下载次数'), '1e 有「下载次数」列');
  check(headerText.includes('可下载性'), '1f 有「可下载性」列');
  check(headerText.includes('存放位置'), '1g 有「存放位置」列（区分 OSS/本地）');
  check(headerText.includes('版本'), '1h 有「版本」列');

  // 汇总指标
  const metrics = (await page.locator('[data-testid="release-metrics"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/可下载/.test(metrics) && /OSS/.test(metrics) && /本地/.test(metrics), '1i 汇总指标含可下载/OSS/本地', metrics.slice(0, 90));

  // 当前版本行必须有「当前」徽标，且版本列 == pkgVersion
  const badgeCount = await page.locator('[data-testid="release-section"] .adm-badge--accent').count();
  check(badgeCount >= 1, '1j 当前版本条目有「当前」徽标', `count=${badgeCount}`);

  await shot('releases-current-version.png');

  // 「只看异常」筛选：应能筛出仅在 OSS / 仅在本地的差异条目
  await page.locator('[data-testid="release-section"] input[type="checkbox"]').first().check();
  await page.waitForTimeout(700);
  const issueRows = await page.locator('[data-testid="release-section"] tbody tr').count();
  check(issueRows >= 1, '1k 「只看异常」能筛出 OSS/本地不一致的条目', `rows=${issueRows}`);
  await shot('releases-only-issues.png');
  await page.locator('[data-testid="release-section"] input[type="checkbox"]').first().uncheck();
  await page.waitForTimeout(500);

  /* ---------------- 需求2 + 3：插件市场编辑与分页 ---------------- */
  section('2. 需求2/3 · 插件市场编辑 + 20/页分页');
  await openTab('plugins');
  await page.waitForTimeout(1500);

  const rowCount = await page.locator('.plg tbody tr').count();
  check(rowCount === 20, '2a 每页渲染 20 条', `rows=${rowCount}`);

  const totalText = (await page.locator('.plg .adm-toolbar__count').innerText().catch(() => '')).trim();
  check(/共 \d+ 款/.test(totalText), '2b 工具栏显示总条数', totalText);
  const totalNum = Number(/共 (\d+) 款/.exec(totalText)?.[1] ?? 0);
  check(totalNum > 20, '2c 总数 > 20（确认有第 2 页可翻）', `total=${totalNum}`);

  const pagerVisible = await page.locator('[data-testid="plugin-pager"]').count();
  check(pagerVisible === 1, '2d 分页组件已渲染');
  const pagerText = (await page.locator('[data-testid="plugin-pager"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/每页 20 条/.test(pagerText) && /共 \d+ 条/.test(pagerText), '2e 分页条显示「每页 20 条」与总数', pagerText.slice(0, 80));

  await shot('plugins-page1.png');

  // 翻到第 2 页：断言滚动回顶部 + URL 带 pluginPage=2 + 内容变化
  const firstIdP1 = await page.locator('.plg tbody tr').first().innerText();
  // 先滚到页面下方，验证翻页会回顶部
  await page.evaluate(() => document.querySelector('.adm-body')?.scrollTo({ top: 99999 }));
  await page.waitForTimeout(400);
  const scrollBefore = await page.evaluate(() => document.querySelector('.adm-body')?.scrollTop ?? 0);
  await page.locator('[data-testid="plugin-pager"] button').last().click(); // 「下一页」
  await page.waitForTimeout(1600);
  const scrollAfter = await page.evaluate(() => document.querySelector('.adm-body')?.scrollTop ?? 0);
  check(scrollBefore > 0, '2f 翻页前确实处于滚动状态（前置条件成立）', `scrollTop=${scrollBefore}`);
  check(scrollAfter < 60, '2g 翻页后滚动位置回到顶部', `scrollTop=${scrollAfter}`);

  const urlAfter = page.url();
  check(/pluginPage=2/.test(urlAfter), '2h 页码写入 URL query（刷新不丢）', urlAfter.slice(-60));
  const firstIdP2 = await page.locator('.plg tbody tr').first().innerText();
  check(firstIdP1 !== firstIdP2, '2i 第 2 页内容与第 1 页不同');
  const rowsP2 = await page.locator('.plg tbody tr').count();
  check(rowsP2 > 0 && rowsP2 <= 20, '2j 第 2 页条数在 1~20 之间', `rows=${rowsP2}`);
  await shot('plugins-page2.png');

  // 刷新后页码保持（页签 + 页码都在 URL 里，1.4.0 新增页签同步）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const urlAfterReload = page.url();
  check(/pluginPage=2/.test(urlAfterReload), '2k 刷新后 URL 页码仍在', urlAfterReload.slice(-50));
  check(/tab=plugins/.test(urlAfterReload), '2l 刷新后仍停留在插件市场页签（页签同步到 URL）', urlAfterReload.slice(-50));
  const rowsAfterReload = await page.locator('.plg tbody tr').count();
  check(rowsAfterReload > 0, '2m 刷新后第 2 页仍正常渲染', `rows=${rowsAfterReload}`);
  const pagerAfterReload = (await page.locator('[data-testid="plugin-pager"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/第 2 页/.test(pagerAfterReload), '2n 刷新后页码控件停在「第 2 页」', pagerAfterReload.slice(0, 60));

  // 回到第 1 页做编辑
  await page.locator('[data-testid="plugin-pager"] button').first().click();
  await page.waitForTimeout(1500);

  /* ------- 编辑弹窗 ------- */
  await page.locator('[data-testid="plugin-edit"]').first().click();
  await page.waitForTimeout(1600);
  check(await page.locator('[data-testid="edit-name"]').count() === 1, '2m 编辑弹窗打开（含名称输入框）');
  for (const sel of ['edit-version', 'edit-category', 'edit-tags', 'edit-description', 'edit-readme', 'edit-code']) {
    check(await page.locator(`[data-testid="${sel}"]`).count() === 1, `2n 编辑弹窗含 ${sel}`);
  }

  const origName = await page.inputValue('[data-testid="edit-name"]');
  await shot('plugins-edit-dialog.png');

  // 校验拦截：写一段语法错误的代码 → 应出现 issue 且保存按钮禁用
  await page.fill('[data-testid="edit-code"]', 'export default { name: "坏代码" ');
  await page.waitForTimeout(600);
  const issuesVisible = await page.locator('[data-testid="edit-issues"]').count();
  check(issuesVisible === 1, '2o 语法错误时显示校验问题列表');
  const saveDisabled = await page.locator('[data-testid="edit-save"]').isDisabled();
  check(saveDisabled === true, '2p 校验未通过时保存按钮禁用');
  const issueText = (await page.locator('[data-testid="edit-issues"]').innerText()).replace(/\s+/g, ' ');
  check(/语法错误|无法保存/.test(issueText), '2q 问题文案明确指出语法错误', issueText.slice(0, 80));
  await shot('plugins-edit-invalid.png');

  // 危险标识符也要拦
  await page.fill('[data-testid="edit-code"]', 'const cp = require("child_process"); export default { cp };');
  await page.waitForTimeout(600);
  const denyText = (await page.locator('[data-testid="edit-issues"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/require|child_process/.test(denyText), '2r 危险标识符被前端拦截', denyText.slice(0, 90));

  // 恢复合法内容 → 校验通过
  const origCode = await page.inputValue('[data-testid="edit-code"]');
  await page.fill('[data-testid="edit-name"]', origName);
  await page.waitForTimeout(500);

  // 关闭弹窗（有未保存修改会弹 confirm，自动接受）
  page.once('dialog', (d) => d.accept());
  await page.locator('.modal__close').first().click().catch(async () => {
    await page.keyboard.press('Escape');
  });
  await page.waitForTimeout(900);

  check(
    jsErrors.filter((e) => !/favicon|ResizeObserver|Failed to load resource/i.test(e)).length === 0,
    '2s 插件市场交互过程无 JS 运行时异常',
    jsErrors.filter((e) => !/favicon|ResizeObserver|Failed to load resource/i.test(e)).slice(0, 2).join(' | ') || '无',
  );

  /* ------- 通过真实 UI 完成「改 → 存 → 客户端可见 → 改回」 ------- */
  section('2b. 真实 UI 编辑保存往返（改 → 存 → 客户端可见 → 改回 → 清理）');

  // 通过 API 建一个临时插件（属测试数据，最后删除；不碰真实插件）
  const stamp = Date.now();
  const tmpPluginId = `re14uitmp-${stamp}`;
  const tmpPluginSeedCode = `export default {\n  id: '${tmpPluginId}',\n  name: 'UI 验证插件',\n  version: '1.0.0',\n  setup(api) { api.notify('原始'); }\n};`;
  /*
   * 直接用 3211 的接口造/清测试数据。
   *
   * 注意必须带 Bearer 令牌：`POST /api/plugins` 走的是 `app.authenticate`
   * （读 `Authorization` 头），而浏览器里的令牌存在 localStorage 的 `neomd.access`
   * （见 api/client.ts 的 TOKEN_KEY），**不是 cookie**。
   * 早前版本漏了这个头，POST 静默 401、`createdId` 为 null，后面一连锁判断全歪。
   */
  const accessToken = await page.evaluate(() => localStorage.getItem('neomd.access'));
  const apiCall = async (method, p, body) => {
    /*
     * content-type 只在**有 body** 时才设。
     * Fastify 的 JSON 解析器对「声明了 application/json 但 body 为空」的请求会直接回
     * 400 `请求体不是合法的 JSON` —— DELETE 因此会被误拒。
     * 前端 `api()` 正是这么做的（见 api/client.ts：`if (!formData && body !== undefined)`），
     * 这里与它保持一致。
     */
    const res = await context.request.fetch(`${API_BASE}${p}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      data: body === undefined ? undefined : JSON.stringify(body),
      failOnStatusCode: false,
    });
    const json = await res.json().catch(() => null);
    if (res.status() >= 400) console.log(`        (apiCall ${method} ${p} → HTTP ${res.status()}: ${json?.error?.message ?? ''})`);
    return { status: res.status(), json };
  };

  let createdId = null;
  try {
    const cr = await apiCall('POST', '/api/plugins', {
      pluginId: tmpPluginId,
      name: 'UI 验证插件',
      version: '1.0.0',
      category: 'writing',
      description: '这是 UI 端到端验证用的临时插件。',
      codeJs: tmpPluginSeedCode,
    });
    createdId = cr.json?.data?.plugin?.id ?? null;
    check(Boolean(createdId), '2t 建好 UI 端到端用的临时插件', `id=${createdId}`);

    // 回到插件市场并搜索到它
    await openTab('plugins');
    await page.waitForTimeout(1200);
    await page.fill('.plg .adm-toolbar__search', tmpPluginId);
    await page.locator('.plg .adm-toolbar button').first().click();
    await page.waitForTimeout(1500);
    const foundRows = await page.locator('.plg tbody tr').count();
    // 精确命中时只有 1 行且该行是真实插件（带「编辑」按钮）；无结果时是 1 行占位空行
    const hasEditBtn = await page.locator('[data-testid="plugin-edit"]').count();
    check(foundRows === 1 && hasEditBtn === 1, '2u 搜索精确定位到该临时插件', `rows=${foundRows} editBtn=${hasEditBtn}`);

    // 打开编辑，改名 + 改描述，保存
    await page.locator('[data-testid="plugin-edit"]').first().click();
    await page.waitForTimeout(1500);
    await page.fill('[data-testid="edit-name"]', 'UI 验证插件（已改）');
    await page.fill('[data-testid="edit-description"]', '这段描述由真实 UI 编辑保存流程改写，用于验证保存后客户端立即可见。');
    await page.waitForTimeout(500);
    const saveEnabled = await page.locator('[data-testid="edit-save"]').isEnabled();
    check(saveEnabled, '2v 有未保存修改且校验通过时保存按钮可用');
    await page.locator('[data-testid="edit-save"]').click();
    await page.waitForTimeout(2200);

    // 保存反馈：变更摘要 + 顶部通知
    const savedBox = await page.locator('[data-testid="edit-saved"]').count();
    check(savedBox === 1, '2w 保存后弹窗内出现「已保存生效」变更摘要');
    const savedText = (await page.locator('[data-testid="edit-saved"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/名称/.test(savedText), '2x 变更摘要列出了「名称」变更', savedText.slice(0, 90));
    const banner = (await page.locator('.adm-banner--ok').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/已保存并生效/.test(banner), '2y 页面顶部出现「保存成功」明确反馈', banner.slice(0, 90));
    await shot('plugins-edit-saved.png');

    // 客户端市场立即可见（直接问服务端，绕过 UI 缓存）
    const mk = await apiCall('GET', `/api/plugins/market?search=${encodeURIComponent(tmpPluginId)}`);
    const mkItem = (mk.json?.data?.items ?? [])[0];
    check(mkItem?.name === 'UI 验证插件（已改）', '2z 客户端市场立即看到 UI 保存的新名称', mkItem?.name);
    check(String(mkItem?.description ?? '').includes('真实 UI 编辑保存流程'), '2aa 客户端市场立即看到新描述');

    // 改回原值 → 再次断言
    await apiCall('PUT', `/api/admin/plugins/${createdId}`, {
      name: 'UI 验证插件',
      description: '这是 UI 端到端验证用的临时插件。',
    });
    const mk2 = await apiCall('GET', `/api/plugins/market?search=${encodeURIComponent(tmpPluginId)}`);
    check((mk2.json?.data?.items ?? [])[0]?.name === 'UI 验证插件', '2ab 已改回原值');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } finally {
    // 清理临时插件（绝不删真实插件）
    if (createdId) await apiCall('DELETE', `/api/plugins/${encodeURIComponent(tmpPluginId)}`);
    const after = await apiCall('GET', `/api/admin/plugins?page=1&pageSize=20&search=${encodeURIComponent(tmpPluginId)}`);
    check((after.json?.data?.items ?? []).length === 0, '2ac 临时插件已清理（未残留）', `剩余=${(after.json?.data?.items ?? []).length}`);
  }

  /* ---------------- 需求5：用户管理 ---------------- */
  section('3. 需求5 · 用户管理增强 UI');
  await openTab('users');
  await page.waitForTimeout(1800);

  // 列头：最后活跃
  const uHeaders = (await page.locator('.usr thead th').allInnerTexts()).join('|');
  check(uHeaders.includes('最后活跃'), '3a 用户列表含「最后活跃」列', uHeaders.slice(0, 100));

  // 导出按钮
  check(await page.locator('[data-testid="export-csv"]').count() === 1, '3b 有「导出 CSV」按钮');

  // 批量条：勾选一个后出现
  check(await page.locator('[data-testid="batch-bar"]').count() === 0, '3c 未选中时不显示批量操作条');
  await page.locator('[data-testid="select-one"]').first().check();
  await page.waitForTimeout(600);
  check(await page.locator('[data-testid="batch-bar"]').count() === 1, '3d 勾选后出现批量操作条');
  const batchBarText = (await page.locator('[data-testid="batch-bar"]').innerText()).replace(/\s+/g, ' ');
  check(/已选 1 位用户/.test(batchBarText), '3e 批量条显示已选数量', batchBarText);
  await shot('users-batch-bar.png');

  // 批量弹窗
  await page.click('[data-testid="batch-open"]');
  await page.waitForTimeout(900);
  check(await page.locator('[data-testid="batch-action"]').count() === 1, '3f 批量操作弹窗含操作类型选择');
  const batchOptions = await page.locator('[data-testid="batch-action"] option').allInnerTexts();
  check(batchOptions.length >= 4, '3g 批量操作支持 ≥4 种动作', batchOptions.join('/'));
  // 切到「批量发放积分」应出现金额输入
  await page.selectOption('[data-testid="batch-action"]', 'grant');
  await page.waitForTimeout(500);
  check(await page.locator('[data-testid="batch-amount"]').count() === 1, '3h 选择发放积分后出现金额输入');
  await shot('users-batch-dialog.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await page.locator('[data-testid="select-all"]').first().uncheck().catch(() => {});
  await page.waitForTimeout(500);

  // 封禁弹窗
  await page.locator('[data-testid="ban-btn"]').first().click();
  await page.waitForTimeout(1000);
  check(await page.locator('[data-testid="ban-reason"]').count() === 1, '3i 封禁弹窗含「封禁原因」输入');
  check(await page.locator('[data-testid="ban-preset"]').count() === 1, '3j 封禁弹窗含「封禁时长」选择（含到期）');
  const presets = await page.locator('[data-testid="ban-preset"] option').allInnerTexts();
  check(presets.some((p) => /永久/.test(p)) && presets.some((p) => /小时|天/.test(p)), '3k 时长选项含限时与永久', presets.join('/'));
  // 原因为空时提交按钮禁用
  const banSubmitDisabled = await page.locator('[data-testid="ban-submit"]').isDisabled();
  check(banSubmitDisabled === true, '3l 未填原因时「确认封禁」禁用（前端校验）');
  await shot('users-ban-dialog.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // 详情弹窗：概览 + 登录记录
  await page.locator('.usr tbody tr').first().locator('.adm-rowbtn', { hasText: '详情' }).first().click();
  await page.waitForTimeout(2000);
  check(await page.locator('[data-testid="tab-overview"]').count() === 1, '3m 详情弹窗有「数据概览」tab');
  check(await page.locator('[data-testid="tab-logins"]').count() === 1, '3n 详情弹窗有「登录记录」tab');
  check(await page.locator('[data-testid="overview-grid"]').count() === 1, '3o 数据概览卡片已渲染');
  const ovText = (await page.locator('[data-testid="overview-grid"]').innerText()).replace(/\s+/g, ' ');
  for (const kw of ['仓库', '分享', 'AI 调用', '积分余额', '配额使用']) {
    check(ovText.includes(kw), `3p 概览含「${kw}」`, '');
  }
  await shot('users-overview.png');

  await page.locator('[data-testid="tab-logins"]').click();
  await page.waitForTimeout(1800);
  const loginSum = (await page.locator('[data-testid="login-summary"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/成功/.test(loginSum) && /失败/.test(loginSum), '3q 登录记录显示成功/失败统计', loginSum.slice(0, 80));
  await shot('users-logins.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  section('4. 收尾');
  /*
   * 只把「真正的 JS 运行时异常」算作失败。
   *
   * 浏览器控制台里的 `Failed to load resource: 404` 不区分资源类型，
   * 常见来源是 favicon、Vite 的 HMR 探测、或后台里指向外部域名的下载链接 —— 都不是本功能缺陷。
   * 因此这里以 `pageerror`（未捕获的 JS 异常）为准，网络类错误单独列出但不判失败，
   * 避免用「全绿」掩盖真问题、也避免被无关噪声假红。
   */
  const realErrors = jsErrors.filter((e) => !/favicon|ResizeObserver|Failed to load resource/i.test(e));
  check(realErrors.length === 0, '4a 全流程无 JS 运行时异常', realErrors.slice(0, 3).join(' | ') || '无');
  const noisyHttp = httpErrors.filter((u) => !/favicon/i.test(u));
  if (noisyHttp.length) {
    console.log(`        提示：观察到 ${noisyHttp.length} 个 4xx/5xx 响应（不判失败，供排查参考）`);
    for (const u of noisyHttp.slice(0, 5)) console.log(`          ${u}`);
  } else {
    console.log('        提示：未观察到 4xx/5xx 响应');
  }
  console.log(`\n  截图目录：docs/shots-140/`);
} finally {
  await context.close();
  await browser.close();
}

section('结果汇总');
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(failures.length === 0 ? '\n全部通过' : '\n有失败项');
process.exit(failures.length === 0 ? 0 : 1);
