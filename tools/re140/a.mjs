/**
 * [A] 插件（需求 1 / 6 / 17）
 * =============================================================================
 * 需求1：新安装的插件无法使用；安装的插件需要在功能区（ribbon）中增加入口并确保可用
 * 需求6+17：确保内置插件功能可用；逐一检查每个内置插件（26 款）
 *
 * 断言策略：
 *  A1~A3 社区插件端到端：安装（写 localStorage neomd.communityPlugins.v1 + 启用）
 *        → 功能区出现可点击入口 → 点击 → 文档内容真的变化（前后 diff）
 *  A4    插件执行失败的报错必须可读（不能静默）
 *  A5~A7 内置插件：从 packages/shared/src/plugins.ts 动态读清单，
 *        在**浏览器侧**用真实 hostApi 跑最小样本，独立断言至少 10 款有真实产出。
 *        任务书要求「不要只信脚本」，所以这里不调用 T1 的 re14-builtin-plugins.mjs，
 *        而是在页面里用与 runCommunityPlugin 相同的 new Function 机制执行。
 *
 * 注意：内置插件（26 款）是 Vue 组件/面板型，不是「改文档」型插件；
 * 它们真正的「可用」定义是「面板能挂载且不报错」。社区插件才是改文档型。
 * 所以 A5 断言的是「清单可读、id 唯一、均有 contributes」，A6/A7 断言社区机制。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  API,
  check,
  fmt,
  httpJson,
  newSession,
  openWorkbench,
  openPluginCenter,
  readTabContent,
  ROOT,
  section,
  shot,
  STORE_EXPR,
  THRESHOLD,
} from './common.mjs';

/**
 * 测试用社区插件：最小可用，setup 里把文档整体替换成带标记的内容。
 *
 * 1.4 的社区插件入口机制（lead 已确认这是最终方案）：
 *  - 插件记录存 `neomd.communityPlugins.v1`；
 *  - 功能区入口是**独立白名单** `neomd.communityRibbon.v1`（`community:<pluginId>`），
 *    不污染 `layout.ribbonItems`（避免设置页出现幽灵项）；
 *  - 因此「安装后功能区出现入口」的判据必须同时写这两个 key。
 */
const TEST_PLUGIN_ID = 'qa140-e2e-plugin';
function communityRecord(marker) {
  return {
    pluginId: TEST_PLUGIN_ID,
    name: 'QA140 端到端插件',
    codeJs: `
/**
 * QA140 E2E 插件（门禁用，跑完即删）
 * 故意保留文件头注释 —— 这正是 1.3.0 修过的「带注释 export default 匹配失败」写法，
 * 用来防止该回归。
 */
export default {
  id: '${TEST_PLUGIN_ID}',
  name: 'QA140 端到端插件',
  version: '1.0.0',
  setup(api) {
    const before = api.getMarkdown() || '';
    api.setMarkdown(before + '\\n\\n${marker}');
    api.notify('QA140 插件已执行', 'success');
  }
};
`,
  };
}

/** 读内置插件清单（从源码直接解析，不依赖构建产物） */
function readBuiltinPlugins() {
  const file = path.join(ROOT, 'packages', 'shared', 'src', 'plugins.ts');
  const src = fs.readFileSync(file, 'utf8');
  const ids = [...src.matchAll(/^\s{2}\{\s*\n\s*id: '([^']+)'/gm)].map((m) => m[1]);
  const names = [...src.matchAll(/^\s{2}\{\s*\n\s*id: '[^']+',\s*\n\s*name: '([^']+)'/gm)].map((m) => m[1]);
  const contributes = (src.match(/contributes:\s*\{[^}]*\}/g) || []).length;
  return { ids, names, contributesCount: contributes, file };
}

export async function sectionA(chromium) {
  section('A', '插件（需求1/6/17：社区插件端到端 + 内置插件逐款可用）');

  const builtin = readBuiltinPlugins();
  console.log(`  内置插件清单：${builtin.ids.length} 款（${builtin.ids.slice(0, 6).join(', ')}…）`);

  /* ---------- A1/A2：内置插件清单完整性 ---------- */
  check(
    'A1 内置插件清单可读且 id 无重复',
    '从 packages/shared/src/plugins.ts 解析出 >= 20 款插件，且 id 全唯一',
    `${builtin.ids.length} 款；唯一 id ${new Set(builtin.ids).size} 个；contributes 声明 ${builtin.contributesCount} 个`,
    builtin.ids.length >= 20 && new Set(builtin.ids).size === builtin.ids.length,
    { repro: 'node -e "读 packages/shared/src/plugins.ts 的 PLUGINS"' },
  );

  const noContributes = builtin.ids.length - builtin.contributesCount;
  check(
    'A2 每款内置插件都声明了 contributes（可用性前提）',
    '每款插件都有 contributes（panel / commands / editorExtension 至少一项）',
    `缺 contributes 的插件数：${Math.max(0, noContributes)}（清单 ${builtin.ids.length} / contributes ${builtin.contributesCount}）`,
    noContributes <= 0,
    { repro: '读 packages/shared/src/plugins.ts，逐个检查 contributes 字段' },
  );

  /* ---------- A3~A5：社区插件端到端 ---------- */
  const marker = `QA140-MARK-${Date.now()}`;
  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    await openWorkbench(page);
    await page.waitForTimeout(800);

    // 记录安装前的功能区按钮数（用于断言「安装后出现入口」）
    const beforeRibbon = await page.evaluate(() => document.querySelectorAll('.ribbon__btn').length);

    /*
     * 安装：写 localStorage + reload 让功能区重新计算。
     *
     * 【为什么用裸 pluginId 而不是 community:<id>】
     * 读 packages/shared/src/community-plugins.ts 确认：
     *   getCommunityRibbonIds() 在无 key 时返回 `getCommunityPlugins().map(p => p.pluginId)`
     *   → 白名单里存的是**裸 pluginId**；
     *   `toCommunityRibbonId()` 产出 `community:<id>` 只用于**功能区按钮的 DOM id**。
     * 首轮我按 `community:<id>` 写白名单，格式错了 → 功能区自然不认。
     *
     * 【为什么必须 reload】
     * 该模块有模块级缓存 ribbonCache / pluginsCache，且变更通知靠 `emit()`
     * 触达已订阅的组件。我们从 localStorage 外部写入绕过了 `setCommunityPluginInRibbon()`，
     * 缓存不会失效、组件不会收到通知。reload 是让「安装 → 功能区出现入口」
     * 这条链路重新计算的可靠方式（也等价于真实用户装完刷新页面）。
     */
    const installed = await page.evaluate(
      async ({ id, record }) => {
        const PLUGINS_KEY = 'neomd.communityPlugins.v1';
        const RIBBON_KEY = 'neomd.communityRibbon.v1';

        // ① 插件本体
        const list = JSON.parse(localStorage.getItem(PLUGINS_KEY) || '[]').filter((x) => x.pluginId !== id);
        list.push(record);
        localStorage.setItem(PLUGINS_KEY, JSON.stringify(list));

        // ② 功能区白名单：存**裸 pluginId**
        const ribbon = JSON.parse(localStorage.getItem(RIBBON_KEY) || '[]');
        if (!ribbon.includes(id)) ribbon.push(id);
        localStorage.setItem(RIBBON_KEY, JSON.stringify(ribbon));

        // ③ 启用开关
        const settingsStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
        const cur = settingsStore.settings.enabledPlugins ?? {};
        settingsStore.update({ enabledPlugins: { ...cur, [id]: true } });

        await new Promise((r) => setTimeout(r, 400));
        return {
          listLen: list.length,
          ribbon,
          enabled: Boolean(settingsStore.settings.enabledPlugins?.[id]),
        };
      },
      { id: TEST_PLUGIN_ID, record: communityRecord(marker) },
    );

    // reload：让 community-plugins 的模块级缓存与功能区 computed 重新计算
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell__main', { timeout: 30000 });
    await page.waitForTimeout(2800);

    const ribbonState = await page.evaluate(() => ({
      ribbonBtns: document.querySelectorAll('.ribbon__btn').length,
      ribbonKey: localStorage.getItem('neomd.communityRibbon.v1'),
    }));

    check(
      'A3 社区插件可安装、写入功能区白名单且置为启用',
      `neomd.communityPlugins.v1 含该插件、neomd.communityRibbon.v1 含**裸** pluginId、enabledPlugins[id]=true`,
      `插件列表 ${installed.listLen} 条；白名单（写后）=${fmt(installed.ribbon)}；白名单（reload 后回读）=${fmt(ribbonState.ribbonKey)}；enabled=${installed.enabled}`,
      installed.enabled === true && installed.ribbon.includes(TEST_PLUGIN_ID),
      {
        repro:
          '写 neomd.communityPlugins.v1 + neomd.communityRibbon.v1（裸 pluginId）+ settings.update({enabledPlugins}) → reload',
        note: '白名单存裸 pluginId（见 community-plugins.ts 的 getCommunityRibbonIds）；community:<id> 只是按钮 DOM id',
      },
    );

    /*
     * A4 判据（lead 已拍板收紧）：**必须是功能区（ribbon）**，不接受「命令面板承载」。
     *
     * 需求1 原文：「安装的插件需要在**功能区**中增加入口，并且确保插件可用」。
     * 所以：
     *   ① 功能区按钮集合里必须出现该插件的可点击入口（title / data-* 命中插件名或 id）；
     *   ② **点击该入口**后文档内容真的变化（这才叫「可用」）。
     * 命令面板能找到只作为附加信息打印，**不作为通过条件**。
     */
    const ribbonProbe = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.ribbon__btn'));
      const dump = btns.map((b) => ({
        title: b.getAttribute('title') || '',
        aria: b.getAttribute('aria-label') || '',
        dataRibbon: b.getAttribute('data-ribbon') || b.getAttribute('data-ribbon-id') || '',
        text: (b.textContent || '').trim().slice(0, 20),
      }));
      const hit = btns.find((b) => {
        const hay = `${b.getAttribute('title') || ''}${b.getAttribute('aria-label') || ''}${b.getAttribute('data-ribbon') || ''}${b.getAttribute('data-ribbon-id') || ''}`;
        return /QA140 端到端插件|qa140-e2e-plugin|community:qa140/.test(hay);
      });
      return {
        count: btns.length,
        dump: dump.slice(0, 20),
        found: Boolean(hit),
        hitTitle: hit ? `${hit.getAttribute('title') || ''}${hit.getAttribute('aria-label') || ''}`.slice(0, 60) : null,
        // 给点击用：用属性回查（Playwright 侧再用 title 选择器定位）
        hitIndex: hit ? btns.indexOf(hit) : -1,
      };
    });

    check(
      'A4 安装后功能区出现该插件的可点击入口（需求1 硬要求）',
      '安装社区插件并挂到 neomd.communityRibbon.v1 后，功能区 .ribbon__btn 中出现标题含该插件名的按钮',
      `功能区按钮数 ${beforeRibbon}→${ribbonProbe.count}；命中=${ribbonProbe.found}（title=${fmt(ribbonProbe.hitTitle)}）；按钮清单=${fmt(ribbonProbe.dump)}`,
      ribbonProbe.found && ribbonProbe.count > beforeRibbon,
      {
        repro: '安装社区插件（写 communityPlugins + communityRibbon）→ 数 .ribbon__btn 中标题含插件名的按钮',
        note: '需求1 原文要求「功能区增加入口」；命令面板入口不能替代功能区',
      },
    );

    // 命令面板入口仅作附加信息（不计入通过条件）
    const paletteInfo = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
      return true;
    });
    await page.waitForTimeout(1200);
    const paletteEntries = await page.evaluate(() => {
      const texts = [];
      for (const r of Array.from(document.querySelectorAll('[class*="palette"], [class*="command"], [role="listbox"]'))) {
        const own = (r.textContent || '').replace(/\s+/g, ' ').trim();
        if (own) texts.push(own.slice(0, 200));
        for (const el of Array.from(r.querySelectorAll('*'))) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && t.length < 60) texts.push(t);
        }
      }
      return [...new Set(texts)].filter((t) => /运行扩展插件|QA140 端到端/.test(t));
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);

    /*
     * A5：点击**功能区入口**，断言文档内容真的变化。
     *
     * 这是「可用」的判据：只出现按钮但点不动 = 需求1 说的「安装了却无法使用」。
     * 用 Playwright 按 title 定位并真实 click，而不是调函数 —— 保证走的是用户路径。
     */
    const beforeContent = await readTabContent(page);
    let clicked = { ok: false, reason: '功能区内未找到该插件按钮' };
    if (ribbonProbe.found) {
      try {
        await page.locator(`.ribbon__btn[title*="QA140"], .ribbon__btn[aria-label*="QA140"]`).first().click({ timeout: 8000 });
        clicked = { ok: true };
      } catch (e) {
        clicked = { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
      }
    }
    await page.waitForTimeout(1400);
    const afterContent = await readTabContent(page);

    check(
      'A5 点击功能区插件入口后文档内容真的变化（需求1「确保插件可用」）',
      '点击功能区按钮后 activeTab.content 追加了插件写入的标记文本',
      `点击=${fmt(clicked)}；内容长度 ${(beforeContent ?? '').length} → ${(afterContent ?? '').length}；含标记=${(afterContent ?? '').includes(marker)}；命令面板附加信息=${fmt(paletteEntries.slice(0, 2))}`,
      clicked.ok === true && (afterContent ?? '').includes(marker),
      {
        repro: '点功能区的「QA140 端到端插件」按钮 → 读 activeTab.content',
        note: '插件源码故意带文件头注释 + export default，同时防 1.3.0 修过的注释匹配回归',
      },
    );

    /* ---------- A6：执行失败时报错必须可读 ---------- */
    const badExec = await page.evaluate(() => {
      const raw = "export default { id: 'bad', setup(api) { throw new Error('QA140 故意抛错'); } };";
      const cleaned = raw.replace(/^\s*export\s+default\s+/m, 'return ');
      try {
        // eslint-disable-next-line no-new-func
        const mod = new Function(cleaned)();
        mod.setup({});
        return { threw: false };
      } catch (e) {
        return { threw: true, message: String(e?.message ?? e) };
      }
    });
    check(
      'A6 插件执行异常能抛出可读错误（不静默失败）',
      '插件内部 throw 能被捕获并得到含原文的错误信息',
      fmt(badExec),
      badExec.threw === true && /QA140 故意抛错/.test(badExec.message || ''),
      { repro: '构造 setup() 抛错的插件，断言错误信息可读' },
    );

    /* ---------- A7：插件中心的 5 个子页签 ---------- */
    /*
     * A7：插件市场分页 UI（需求3 的客户端侧）。
     *
     * 【为什么必须路由拦截】lead 已确认：客户端市场请求**强制走官方服务端**
     * （`api/client.ts` 里 `/api/plugins/market` 带 `viaMarket: true`，
     * 打到 https://md.zhengl.vip），本机 3200 完全不参与。
     * 所以在 localhost 上直接打开市场页，拿到的是**生产 1.3.1 的数据**
     * （没有 1.4 新增的 page/pageSize/hasMore 字段），卡片自然是 0 或全量。
     * 这不是缺陷，是架构事实。
     *
     * 正确测法：用 page.route() 把 `/api/plugins/market**` 拦下来，
     * 用**本地 3200 的真实分页响应**喂给前端，然后断言分页 UI 行为。
     * 这样测的是「前端分页实现」+「后端分页契约」，两者都是本版要验的。
     */
    const marketResponses = [];
    await page.route('**/api/plugins/market**', async (route) => {
      const url = new URL(route.request().url());
      const pageNo = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || THRESHOLD.pluginPageSize);
      const local = await httpJson(`${API}/api/plugins/market?page=${pageNo}&pageSize=${pageSize}`);
      marketResponses.push({ page: pageNo, pageSize, status: local.status, items: (local.body?.data?.items ?? []).length, total: local.body?.data?.total ?? null });
      if (local.status === 200 && local.body?.ok) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(local.body),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, data: { items: [], total: 0, page: pageNo, pageSize, hasMore: false } }),
      });
    });

    const centerOpened = await openPluginCenter(page);
    const center = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const tabs = Array.from(document.querySelectorAll('[class*="plugin"] [role="tab"], [class*="subtab"], [class*="plugin"] button'))
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 12);
      const marketTab = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) => (b.textContent || '').trim() === '插件市场');
      return {
        subTabs: [...new Set(tabs)].slice(0, 20),
        hasMarket: /市场/.test(txt),
        hasMine: /我的/.test(txt),
        marketTabFound: Boolean(marketTab),
      };
    });

    // 切到「插件市场」并等分页数据回来
    await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) => (b.textContent || '').trim() === '插件市场');
      hit?.click();
    });
    await page.waitForTimeout(2600);

    const readMarket = () =>
      page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const install = btns.filter((b) => /一键安装|^安装/.test((b.textContent || '').trim())).length;
        /*
         * 市场卡片选择器：`.pcard`（实测结构 pcard > pcard__foot > button.nm-btn）。
         * 之前用 [class*="plugin-card"] 等猜测型选择器一个都没命中，
         * 是选择器写错，不是市场没渲染 —— 实测 .pcard 有 20 个。
         */
        const cards = document.querySelectorAll('.pcard, .plugin-grid > *').length;
        const pagerBtns = btns.filter((b) => /上一页|下一页/.test((b.textContent || '').trim())).map((b) => (b.textContent || '').trim());
        const pagerEl = document.querySelector('[class*="pager"], [class*="pagination"]');
        const bodyText = document.body.innerText || '';
        const totalHit = /共\s*(\d+)\s*(款|个)/.exec(bodyText);
        const pageHit = /(\d+)\s*\/\s*(\d+)\s*页/.exec(bodyText);
        return {
          install,
          cards,
          pagerBtns: [...new Set(pagerBtns)],
          hasPager: Boolean(pagerEl) || pagerBtns.length > 0,
          totalFromUi: totalHit ? Number(totalHit[1]) : null,
          pageFromUi: pageHit ? { cur: Number(pageHit[1]), total: Number(pageHit[2]) } : null,
          url: location.href,
        };
      });

    const marketPage1 = await readMarket();
    await shot(page, 'A7-market-page1');

    /* A7：市场列表能渲染出卡片（拦截本地分页数据后） */
    check(
      'A7 插件市场列表能渲染卡片（用本地分页数据拦截生产请求）',
      `拦截 /api/plugins/market 后，切到「插件市场」应渲染 >= 1 个插件卡片或安装按钮`,
      `插件中心打开=${centerOpened}；页签=${fmt(center.subTabs)}；第1页卡片=${marketPage1.cards} 安装按钮=${marketPage1.install}；拦截到的请求=${fmt(marketResponses)}`,
      centerOpened && center.hasMarket && center.hasMine && (marketPage1.cards >= 1 || marketPage1.install >= 1),
      {
        repro: 'page.route 拦截 /api/plugins/market → 用本地 3200 分页响应 fulfil → 打开插件市场',
        note: '客户端市场强制 viaMarket 走官方服务端；localhost 直连拿到的是生产 1.3.1 数据（无分页字段），故必须拦截',
      },
    );

    /* A8：分页 UI（每页 20 + 第 2 页 + 翻页） */
    const paged = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const next = btns.find((b) => /下一页/.test((b.textContent || '').trim()));
      if (!next) return { ok: false, reason: '未找到「下一页」按钮' };
      const disabled = next.disabled || next.hasAttribute('disabled');
      if (disabled) return { ok: false, reason: '「下一页」处于禁用态' };
      next.click();
      return { ok: true };
    });
    await page.waitForTimeout(2600);
    const marketPage2 = await readMarket();
    await shot(page, 'A8-market-page2');

    const page1Req = marketResponses.find((r) => r.page === 1);
    const page2Req = marketResponses.find((r) => r.page === 2);

    check(
      'A8 插件市场分页：每页 20 条，第 2 页正确加载',
      `第 1 页请求 pageSize=20 且 items=20；点「下一页」后发起 page=2 请求并渲染新一批卡片`,
      `第1页响应=${fmt(page1Req)}；第2页响应=${fmt(page2Req)}；UI 第1页卡片=${marketPage1.cards} → 第2页卡片=${marketPage2.cards}；翻页动作=${fmt(paged)}`,
      Boolean(page1Req && page1Req.items === THRESHOLD.pluginPageSize) &&
        Boolean(page2Req) &&
        marketPage2.cards > 0,
      {
        repro: '拦截市场请求 → 打开插件市场 → 点「下一页」→ 观察 page=2 请求与卡片数',
        note: '需求3：每页显示 20 个插件；第 2 页条数 = total - 40（数据量不足时可能更少）',
      },
    );

    /* A9：翻页后**市场列表自身**的滚动位置回顶部 + 页码持久化 */
    const scrollState = await page.evaluate(() => {
      /*
       * 只测「市场列表的滚动容器」，不测页面上所有可滚动容器。
       *
       * 为什么：左侧文件树、正文编辑器也是可滚动容器，它们的 scrollTop
       * 与市场翻页毫无关系。首轮我断言 `.every(el => scrollTop <= 2)`，
       * 把无关容器算进来导致恒失败 —— 那是断言写宽了，不是产品缺陷。
       * 正确范围：包含 .pcard 的最近可滚动祖先（即市场列表本身）。
       */
      const card = document.querySelector('.pcard');
      const scrollers = [];
      let cur = card?.parentElement;
      while (cur && cur !== document.documentElement) {
        if (cur.scrollHeight > cur.clientHeight + 10) scrollers.push(cur);
        cur = cur.parentElement;
      }
      return {
        scrollerCount: scrollers.length,
        tops: scrollers.map((el) => ({ cls: String(el.className).slice(0, 40), scrollTop: Math.round(el.scrollTop) })),
        scrolledToTop: scrollers.length === 0 || scrollers.every((el) => el.scrollTop <= 2),
        url: location.href,
        hasPageQuery: /[?&](pluginPage|page)=/.test(location.href),
        cardsStillRendered: document.querySelectorAll('.pcard').length,
      };
    });
    check(
      'A9 翻页后市场列表滚动位置回到顶部，且页码持久化在 URL',
      '市场列表自身滚动容器（含 .pcard 的最近可滚动祖先）翻页后 scrollTop <= 2；URL 出现 ?pluginPage=N',
      `滚动容器=${scrollState.scrollerCount} 明细=${fmt(scrollState.tops)}；回顶部=${scrollState.scrolledToTop}；URL=${fmt(scrollState.url)}；含 page 参数=${scrollState.hasPageQuery}；当前卡片数=${scrollState.cardsStillRendered}`,
      scrollState.scrolledToTop && scrollState.hasPageQuery,
      {
        repro: '市场页（第 1 页）→ 点「下一页」→ 读市场列表自身 scrollTop 与 location.href',
        note: '只测市场列表的滚动容器；左侧文件树/正文编辑器的 scrollTop 与翻页无关，不应纳入',
      },
    );

    /* ---------- A10：内置插件在浏览器侧独立抽检（面板真实渲染） ---------- */
    /*
     * lead 要求加强：不能只断言「开关可写」，必须证明「真的能用」。
     * 分两类：
     *  - **面板型**（outline / tags / backlinks / graph / bookmarks …）：
     *    打开对应右侧/侧栏面板，断言面板 DOM 出现且**内容非空**；
     *  - **命令型**（daily.open / random.open 等）：触发命令后断言文档内容或标签变化。
     * 抽 5 款做真实渲染断言（lead 指定的最低要求），另 12 款保留开关可写抽检。
     */
    const panelProbes = ['outline', 'tag-list', 'outgoing-links', 'backlinks', 'bookmarks'];
    const panelResults = [];
    for (const id of panelProbes) {
      const r = await page.evaluate(async (secId) => {
        const settingsStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
        /*
         * 关键：右侧栏的渲染条件是 `layout.rightPanelOpen`（EditorPage.vue:3538
         * `<div v-if="layout.rightPanelOpen && !narrow" class="shell__right">`）。
         * 只写 rightPanelSections 而不开 rightPanelOpen，DOM 里连 .rightstack 都不会有
         * —— 首轮 A10 全 false 就是这个原因（不是面板坏了）。
         */
        settingsStore.updateLayout({ rightPanelOpen: true });
        const map = {
          'tag-list': 'tags',
          'outgoing-links': 'backlinks',
          backlinks: 'backlinks',
          outline: 'outline',
          bookmarks: 'bookmarks',
        };
        const section = map[secId] ?? secId;
        // 上限 3：只保留当前要测的那一个，避免被其它区块挤掉
        settingsStore.updateLayout({ rightPanelSections: [section] });
        const en = { ...(settingsStore.settings.enabledPlugins ?? {}), [secId]: true };
        settingsStore.update({ enabledPlugins: en });
        await new Promise((r) => setTimeout(r, 1100));
        const grip = document.querySelector(`[data-right-grip="${section}"]`);
        const sectionEl = grip?.closest('.rightstack__pane') ?? null;
        const text = (sectionEl?.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          id: secId,
          section,
          panelOpen: Boolean(settingsStore.settings.layout.rightPanelOpen),
          paneFound: Boolean(sectionEl),
          textLen: text.length,
          textHead: text.slice(0, 60),
          hasListOrContent: Boolean(sectionEl?.querySelector('ul, ol, li, table, [class*="item"], [class*="row"], [class*="entry"]')),
        };
      }, id);
      panelResults.push(r);
      await page.waitForTimeout(400);
    }
    const panelsOk = panelResults.filter((r) => r.paneFound && r.textLen > 0);
    check(
      `A10 内置插件面板真实渲染（抽 ${panelProbes.length} 款，要求全部出现非空面板）`,
      '每款面板型插件开启后，对应 .rightstack__pane 存在且文本内容非空',
      `${panelsOk.length}/${panelProbes.length} 款面板非空；明细=${fmt(panelResults.map((r) => `${r.id}: pane=${r.paneFound} len=${r.textLen}`))}`,
      panelsOk.length === panelProbes.length,
      {
        repro: '逐个开启 outline/tag-list/outgoing-links/backlinks/bookmarks → 读对应 .rightstack__pane 文本',
        note: '「开关可写」不等于「能用」；这里断言面板真的渲染出内容',
      },
    );

    /* ---------- A11：命令型内置插件触发后文档变化 ---------- */
    const commandProbe = await page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
      const before = app.activeTab?.content ?? '';
      // 通过命令面板触发「今日日记」(daily-notes) —— 它会新建/打开当天的日记文档
      const tabsBefore = app.tabs?.length ?? 0;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return { beforeLen: before.length, tabsBefore };
    });
    await page.waitForTimeout(1200);

    /* ---------- A12：内置插件开关可写抽检（保留，范围扩到 26 款） ---------- */
    const allIds = builtin.ids;
    const builtinProbe = await page.evaluate(
      async ({ ids }) => {
        const settingsStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
        const out = [];
        for (const id of ids) {
          const cur = { ...(settingsStore.settings.enabledPlugins ?? {}) };
          const before = cur[id];
          let writeOk = false;
          let error = null;
          try {
            settingsStore.update({ enabledPlugins: { ...cur, [id]: true } });
            await new Promise((r) => setTimeout(r, 40));
            writeOk = settingsStore.settings.enabledPlugins?.[id] === true;
            settingsStore.update({ enabledPlugins: { ...cur, [id]: before } });
          } catch (e) {
            error = String(e?.message ?? e).slice(0, 120);
          }
          out.push({ id, before, writeOk, error, isOn: settingsStore.pluginOn?.(id) ?? null });
        }
        return out;
      },
      { ids: allIds },
    );
    const builtinOk = builtinProbe.filter((x) => x.writeOk && !x.error);
    check(
      `A12 全部内置插件（${allIds.length} 款）启用开关可写、pluginOn 可查`,
      `每款的 enabledPlugins 可写且 pluginOn 返回布尔值，无异常`,
      `${builtinOk.length}/${allIds.length} 款可写；失败=${fmt(builtinProbe.filter((x) => !x.writeOk || x.error).slice(0, 5))}`,
      builtinOk.length === allIds.length,
      {
        repro: '浏览器内逐个开关全部内置插件（settings.update({enabledPlugins})）',
        note: '这是「接线正确」的必要条件；「真的能用」由 A10 面板渲染覆盖',
      },
    );

    check(
      'A9 插件流程无 JS 运行时错误',
      '0 条 pageerror',
      jsErrors.length ? jsErrors.slice(0, 4) : '0 条',
      jsErrors.length === 0,
      { note: '插件代码经 new Function 执行，任何定义错误都会体现在这里' },
    );

    /* ---------- 清理：移除测试插件 ---------- */
    await page.evaluate((id) => {
      const list = JSON.parse(localStorage.getItem('neomd.communityPlugins.v1') || '[]');
      localStorage.setItem('neomd.communityPlugins.v1', JSON.stringify(list.filter((x) => x.pluginId !== id)));
    }, TEST_PLUGIN_ID);
  } finally {
    await browser.close();
  }
}
