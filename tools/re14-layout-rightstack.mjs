/**
 * 1.4.0 需求8 验收：右侧栏「最多 3 个 + 超出替换最上方 + 拖动排序 + 刷新保持」。
 *
 * 改前状态（取证）：右侧区块是无上限多选开关，实测能开满 8 个，`.rightstack`
 * 溢出 1010px，末位被压死在 80px（扣掉 28px 标题栏只剩 52px 可见）。
 * 另外 `enabledRightSections` 强制按 `RIGHT_SECTIONS` 常量顺序输出，用户顺序被丢弃，
 * 所以「拖动排序」在改前根本不可能生效。
 *
 * 本脚本全程走真实 UI 点击 / 真实鼠标拖拽，断言：
 *   A. 开满 3 个后点第 4 个 → 数量仍为 3，且被关掉的是**原来的第 1 个（最上方）**；
 *   B. 替换时有可读提示（含「已自动关闭」与被关区块名）；
 *   C. 拖动标题栏/抓手换位 → DOM 顺序变化；
 *   D. 刷新页面后顺序仍保持（顺序写进 settings.layout.rightPanelSections）。
 *
 * 用法：node tools/re14-layout-rightstack.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BASE = 'http://127.0.0.1:5178';
const API = 'http://127.0.0.1:3200';
const SHOT_DIR = path.join(ROOT, 'docs', 'shots-140');
const TOKEN_CACHE = path.join(os.tmpdir(), 'neomd-re14-token.json');

/** 上限（与 lib/local-layout.ts 的 RIGHT_SECTION_LIMIT 对应，这里作为独立断言值写死） */
const LIMIT = 3;

async function loadChromium() {
  const candidates = [
    'playwright',
    'playwright-core',
    pathToFileURL(path.join(ROOT, 'node_modules/playwright-core/index.mjs')).href,
    pathToFileURL(path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs')).href,
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const mod = await import(c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errors.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errors.push(`${c}: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  throw new Error(`无法加载 Playwright：\n  - ${errors.join('\n  - ')}`);
}

async function httpJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function getToken() {
  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    if (cached?.token && cached?.at && Date.now() - cached.at < 6 * 3600_000) {
      const probe = await httpJson(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${cached.token}` } });
      if (probe.status === 200 && probe.body?.ok) return { token: cached.token, user: cached.user, cached: true };
    }
  } catch {
    /* 无缓存 */
  }
  const r = await httpJson(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '6655' }),
  });
  if (r.status !== 200 || !r.body?.ok) throw new Error(`登录失败 ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const { accessToken, user } = r.body.data;
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: accessToken, user, at: Date.now() }), 'utf8');
  return { token: accessToken, user, cached: false };
}

/**
 * 新会话。
 *
 * 预置 `layout.rightPanelOpen = true` + 只开 1 个区块，让右侧栏从确定状态起步；
 * 设置接口换成进程内假云端，避免把 QA 的区块顺序写进真实管理员配置
 * （区块顺序走 settings.updateLayout() → 会真的 PUT /api/settings）。
 */
async function newSession(chromium, auth) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await ctx.addInitScript(
    ([a, u]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', '');
        localStorage.setItem('neomd.user.cache', u);
        localStorage.setItem('neomd.deviceId', 'qa-re14-rightstack');
        /*
         * 只在**首次**进站时预置一次布局。
         * 这个 initScript 每次导航/刷新都会重跑，若无条件写 rightPanelSections，
         * 刷新就会把用户（本例中是被测的拖动排序结果）的顺序冲回初始值 ——
         * 那样测的就不是 App 的持久化，而是测试脚本自己把数据覆盖了。
         */
        if (!localStorage.getItem('neomd.re14.seeded')) {
          const prev = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
          prev.layout = { ...(prev.layout || {}), rightPanelOpen: true, rightPanelSections: ['ai'] };
          localStorage.setItem('neomd.settings.v1', JSON.stringify(prev));
          localStorage.setItem('neomd.re14.seeded', '1');
        }
      } catch {
        /* ignore */
      }
    },
    [auth.token, JSON.stringify(auth.user)],
  );
  const fake = { payload: null, version: 0 };
  await ctx.route('**/api/settings**', async (route) => {
    const req = route.request();
    const url = req.url();
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    if (req.method() === 'PUT') {
      try {
        const body = JSON.parse(req.postData() || '{}');
        if (body.payload !== undefined) fake.payload = body.payload;
      } catch {
        /* ignore */
      }
      fake.version += 1;
      return ok({ version: fake.version, updatedAt: new Date().toISOString(), deviceId: null, platform: null });
    }
    if (req.method() === 'GET' && /\/api\/settings\/version/.test(url)) return ok({ version: fake.version });
    if (req.method() === 'GET') {
      return ok({ payload: fake.payload, sensitive: null, version: fake.version, updatedAt: null, deviceId: null, platform: null });
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function openWorkbench(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.shell__main', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i += 1) {
    if (await page.locator('.ProseMirror, .cm-content, .read-view').count()) break;
    await page.keyboard.press('Ctrl+n').catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** 当前右侧堆叠里各区块的 id 顺序（DOM 真实顺序，不是内存状态） */
async function paneOrder(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.rightstack .rightstack__pane')).map((el) => el.getAttribute('data-right-pane')),
  );
}

/** 点某个区块的开关按钮 */
async function clickTab(page, id) {
  const ok = await page.evaluate((sid) => {
    const btn = document.querySelector(`.righttabs__btn[data-right-tab="${sid}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, id);
  await page.waitForTimeout(420);
  return ok;
}

/** 读当前 toast 文本（可能为 null） */
async function toastText(page) {
  return page.evaluate(() => document.querySelector('.toast')?.textContent?.trim() ?? null);
}

/** 读 settings 里持久化的区块顺序（刷新后用来交叉验证） */
async function persistedSections(page) {
  return page.evaluate(() => {
    try {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s?.layout?.rightPanelSections ?? null;
    } catch {
      return null;
    }
  });
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re14-rightstack] 登录=${auth.cached ? '复用缓存 token' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const { browser, page } = await newSession(chromium, auth);
  const report = { limit: LIMIT, steps: {}, shots: [], failures: [] };
  const fail = (msg) => report.failures.push(msg);

  try {
    await openWorkbench(page);
    await page.waitForSelector('.rightstack', { timeout: 15000 });

    /* ---------- A. 依次开到 3 个 ---------- */
    const initial = await paneOrder(page);
    for (const id of ['file', 'outline']) {
      if (!(await clickTab(page, id))) fail(`找不到区块开关按钮 data-right-tab="${id}"`);
    }
    const three = await paneOrder(page);
    report.steps.openThree = { initial, after: three };
    if (three.length !== LIMIT) fail(`开满后应有 ${LIMIT} 个区块，实际 ${three.length}（${three.join(',')}）`);
    if (three[0] !== 'ai' || three[1] !== 'file' || three[2] !== 'outline') {
      fail(`前 3 个顺序应为 ai,file,outline，实际 ${three.join(',')}`);
    }
    report.shots.push(await shot(page, 're14-rightstack-three'));

    /* ---------- B. 点第 4 个：替换最上方 + 提示 ---------- */
    const beforeFourth = await paneOrder(page);
    const topMost = beforeFourth[0];
    await clickTab(page, 'tags');
    const afterFourth = await paneOrder(page);
    const toast = await toastText(page);
    report.steps.fourth = {
      before: beforeFourth,
      after: afterFourth,
      evictedExpected: topMost,
      toast,
      toastHasWording: typeof toast === 'string' && toast.includes('已自动关闭'),
    };
    if (afterFourth.length !== LIMIT) fail(`点第 4 个后数量应仍为 ${LIMIT}，实际 ${afterFourth.length}`);
    if (afterFourth.includes(topMost)) fail(`最上方的「${topMost}」应被自动关闭，但它仍在：${afterFourth.join(',')}`);
    if (!afterFourth.includes('tags')) fail(`新开的「tags」应已显示，实际 ${afterFourth.join(',')}`);
    if (!report.steps.fourth.toastHasWording) fail(`未见可读的替换提示，toast=${JSON.stringify(toast)}`);
    // 提示里应含被关区块的可读名（AI 助手 / 文件操作 / 大纲 …）
    const nameMap = { ai: 'AI 助手', file: '文件操作', outline: '大纲', tags: '标签' };
    if (typeof toast === 'string' && !toast.includes(nameMap[topMost] ?? topMost)) {
      fail(`提示里没有出现被关区块名「${nameMap[topMost] ?? topMost}」：${toast}`);
    }
    report.shots.push(await shot(page, 're14-rightstack-replace'));

    /* ---------- C. 拖动排序：把最后一个拖到最上面 ---------- */
    const beforeDrag = await paneOrder(page);
    const srcId = beforeDrag[beforeDrag.length - 1];
    const dstId = beforeDrag[0];
    /*
     * 优先从「标题栏抓手」（⋮⋮）起拖 —— AI 区块的标题栏在 AiPanel 内部（不在本任务
     * 写入范围），只有抓手能拖；RightSection 区块两种都支持。
     * Playwright 的 dragAndDrop 会派发完整的 HTML5 dragstart/dragover/drop 序列。
     */
    const srcHandle = page.locator(`[data-right-grip="${srcId}"]`);
    const dstPane = page.locator(`[data-right-pane="${dstId}"]`);
    const hasGrip = (await srcHandle.count()) > 0;
    if (!hasGrip) fail(`找不到「${srcId}」的拖动抓手，无法执行排序`);
    else {
      await srcHandle.dragTo(dstPane, {
        // 落在目标区块的**上半区**，dragover 判定为「插到它前面」
        targetPosition: { x: 40, y: 6 },
      });
      await page.waitForTimeout(500);
    }
    const afterDrag = await paneOrder(page);
    report.steps.drag = { before: beforeDrag, after: afterDrag, movedId: srcId, toBefore: dstId };
    if (afterDrag[0] !== srcId) fail(`拖动排序后「${srcId}」应排在第 1 位，实际顺序 ${afterDrag.join(',')}`);
    if (JSON.stringify(afterDrag) === JSON.stringify(beforeDrag)) fail('拖动后 DOM 顺序没有变化');
    report.shots.push(await shot(page, 're14-rightstack-dragged'));

    /* ---------- C2. AiPanel 区块（ai/file）也要能拖 ---------- */
    /*
     * `ai` / `file` 的标题栏在 AiPanel.vue 内部（不在本任务写入范围，属 T1），
     * 所以那两种区块**只能**靠 `.rightstack__grip` 抓手拖动。
     * 这里专门验证这条路径，否则「AI 助手窗口排不了序」会漏网。
     *
     * 前置：步骤 B 里 ai 刚好是被挤掉的最上方区块，这里重新把它开回来
     * （会再挤掉当前最上方的那个，属正常淘汰行为），然后把它拖到第 1 位。
     */
    await clickTab(page, 'ai');
    const orderBeforeAiDrag = await paneOrder(page);
    report.steps.reopenAi = { after: orderBeforeAiDrag };
    const aiGrip = page.locator('[data-right-grip="ai"]');
    let finalOrder = afterDrag;
    if (!orderBeforeAiDrag.includes('ai')) {
      fail(`重新开启后「ai」未出现在堆叠中：${orderBeforeAiDrag.join(',')}`);
    } else if (!(await aiGrip.count())) {
      fail('找不到「ai」区块的拖动抓手（AiPanel 区块将无法排序）');
    } else {
      // 拖到第 1 块的上半区 → 判定为「插到它前面」
      const firstId = orderBeforeAiDrag[0];
      const firstPane = page.locator(`[data-right-pane="${firstId}"]`);
      await aiGrip.dragTo(firstPane, { targetPosition: { x: 40, y: 5 } });
      await page.waitForTimeout(500);
      const orderAfterAiDrag = await paneOrder(page);
      finalOrder = orderAfterAiDrag;
      report.steps.dragAiPanel = { before: orderBeforeAiDrag, after: orderAfterAiDrag, movedId: 'ai', toBefore: firstId };
      if (orderAfterAiDrag[0] !== 'ai') {
        fail(`拖动抓手后「ai」应排在第 1 位，实际顺序 ${orderAfterAiDrag.join(',')}`);
      }
      if (JSON.stringify(orderAfterAiDrag) === JSON.stringify(orderBeforeAiDrag)) {
        fail('拖动 ai 抓手后 DOM 顺序没有变化');
      }
      // 悬停抓手截图：留一张「抓手可见」的证据图
      await aiGrip.hover().catch(() => {});
      await page.waitForTimeout(250);
      report.shots.push(await shot(page, 're14-rightstack-grip-hover'));
    }

    /* ---------- C3. RightSection 的**标题栏本身**也要能拖 ---------- */
    /*
     * 需求原文是「拖动标题栏可调整位置」，所以除了抓手，`.rsection__head`
     * 自身也必须是拖拽起点（RightSection.vue 在写入范围内，已加 draggable）。
     * 这里直接用标题栏起拖，验证这条用户最直觉的路径真的通。
     */
    const orderBeforeHeaderDrag = await paneOrder(page);
    const headerSrcId = orderBeforeHeaderDrag[orderBeforeHeaderDrag.length - 1];
    const header = page.locator(`[data-right-pane="${headerSrcId}"] .rsection__head`);
    if (!(await header.count())) {
      fail(`「${headerSrcId}」不是 RightSection 区块或找不到 .rsection__head`);
    } else {
      const firstId2 = orderBeforeHeaderDrag[0];
      const firstPane2 = page.locator(`[data-right-pane="${firstId2}"]`);
      await header.dragTo(firstPane2, { targetPosition: { x: 60, y: 5 } });
      await page.waitForTimeout(500);
      const orderAfterHeaderDrag = await paneOrder(page);
      finalOrder = orderAfterHeaderDrag;
      report.steps.dragByHeader = { before: orderBeforeHeaderDrag, after: orderAfterHeaderDrag, movedId: headerSrcId, toBefore: firstId2 };
      if (orderAfterHeaderDrag[0] !== headerSrcId) {
        fail(`拖标题栏后「${headerSrcId}」应排在第 1 位，实际顺序 ${orderAfterHeaderDrag.join(',')}`);
      }
      report.shots.push(await shot(page, 're14-rightstack-header-drag'));
    }

    /* ---------- C4. 标题栏可拖之后，关闭按钮的点击仍要生效 ---------- */
    /*
     * `draggable="true"` 加在 header 上会让「从按钮按下」也可能起一个原生拖拽，
     * 从而吞掉这一次 click。RightSection 的关闭按钮已显式 `draggable="false"`，
     * 这里实测点击是否真的关掉了那个区块 —— 这是「拖动排序」最容易引入的副作用。
     */
    const beforeClose = await paneOrder(page);
    /*
     * 优先挑一个 **RightSection** 区块（其标题栏在本次改动里被加了 draggable）。
     * ai / file 的标题栏属 AiPanel.vue（未改），拿它们测不出「可拖标题栏吞点击」的风险。
     */
    const closeTarget = [...beforeClose].reverse().find((id) => id !== 'ai' && id !== 'file') ?? beforeClose[beforeClose.length - 1];
    const closed = await page.evaluate((sid) => {
      const pane = document.querySelector(`[data-right-pane="${sid}"]`);
      // ai / file 走 AiPanel 的 .ai__close；其余区块走 RightSection 的 .rsection__close
      const btn = pane?.querySelector('.rsection__close, .ai__close');
      if (!btn) return false;
      btn.click();
      return true;
    }, closeTarget);
    await page.waitForTimeout(450);
    const afterClose = await paneOrder(page);
    report.steps.closeButton = { before: beforeClose, after: afterClose, closedId: closeTarget, found: closed };
    if (!closed) {
      fail(`找不到「${closeTarget}」的关闭按钮`);
    } else if (afterClose.includes(closeTarget)) {
      fail(`点击关闭按钮后「${closeTarget}」仍在：${afterClose.join(',')}（可拖标题栏吞掉了点击）`);
    } else {
      finalOrder = afterClose;
    }
    /* ---------- D. 刷新后是否保持 ---------- */
    const persistedBeforeReload = await persistedSections(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rightstack', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1100);
    const afterReload = await paneOrder(page);
    const persistedAfterReload = await persistedSections(page);
    report.steps.reload = {
      domBeforeReload: finalOrder,
      domAfterReload: afterReload,
      persistedBeforeReload,
      persistedAfterReload,
    };
    if (JSON.stringify(afterReload) !== JSON.stringify(finalOrder)) {
      fail(`刷新后顺序应保持 ${finalOrder.join(',')}，实际 ${afterReload.join(',')}`);
    }
    report.shots.push(await shot(page, 're14-rightstack-reload'));

    /* ---------- E. 上限在刷新后仍然成立 ---------- */
    if (afterReload.length > LIMIT) fail(`刷新后数量 ${afterReload.length} 超过上限 ${LIMIT}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = report.failures.length === 0;
  report.pass = pass;
  console.log(JSON.stringify(report, null, 2));

  console.log('\n=== 右侧栏验收摘要 ===');
  const s = report.steps;
  console.log(`开满 3 个:        ${(s.openThree?.after ?? []).join(' → ')}`);
  console.log(`点第 4 个后:      ${(s.fourth?.after ?? []).join(' → ')}（被替换：${s.fourth?.evictedExpected ?? '?'}）`);
  console.log(`替换提示:         ${JSON.stringify(s.fourth?.toast ?? null)}`);
  console.log(`拖动前:           ${(s.drag?.before ?? []).join(' → ')}`);
  console.log(`拖动后:           ${(s.drag?.after ?? []).join(' → ')}`);
  console.log(`拖 ai 抓手后:      ${(s.dragAiPanel?.after ?? []).join(' → ')}`);
  console.log(`拖标题栏后:        ${(s.dragByHeader?.after ?? []).join(' → ')}`);
  console.log(`点关闭按钮后:      ${(s.closeButton?.after ?? []).join(' → ')}（关掉：${s.closeButton?.closedId ?? '?'}）`);
  console.log(`刷新后 DOM:       ${(s.reload?.domAfterReload ?? []).join(' → ')}`);
  console.log(`刷新后持久化:     ${JSON.stringify(s.reload?.persistedAfterReload ?? null)}`);
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
  if (report.failures.length) console.log('失败明细：\n  - ' + report.failures.join('\n  - '));

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, 're14-layout-rightstack.json'), JSON.stringify(report, null, 2), 'utf8');
  process.exit(pass ? 0 : 1);
};

main().catch((e) => {
  console.error('[re14-rightstack] 失败：', e);
  process.exit(1);
});
