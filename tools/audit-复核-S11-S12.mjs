/**
 * 审计：S11 Wikilink / S12 排序 复核（排除测试假象）
 * =============================================================================
 * 两者都表现为「点击后无变化」，但第一版用的选择器可能没命中真实列表项。
 * 本脚本先摸清左栏文件列表的**真实 DOM 结构**，再用它做断言。
 *
 * 用法：node tools/audit-复核-S11-S12.mjs
 */
import {
  BASE,
  assertZeroWrites,
  beginScenario,
  diffCloudBaseline,
  fmt,
  installWriteGuard,
  loadChromium,
  login,
  newSession,
  scenarioSummary,
  sleep,
  snapshotCloudBaseline,
  writeScenarioJson,
} from './audit-场景-common.mjs';

const APP_STORE =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const s = beginScenario('RS', 'S11 Wikilink / S12 排序 复核', '排除「选择器没命中」造成的假缺陷');

  /* ---------- 1. 摸清左栏文件列表真实结构 ---------- */
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /文件列表|全部文件/.test(x.textContent || ''));
    b?.click();
  });
  await page.waitForTimeout(1800);

  const domMap = await page.evaluate(() => {
    const left = document.querySelector('.leftpanel, .shell__left, [class*="leftpanel"]');
    const info = (el) => ({
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 40),
      draggable: el.getAttribute('draggable'),
      title: (el.getAttribute('title') || '').slice(0, 50),
    });
    const hits = [];
    for (const sel of ['[class*="fileitem"]', '[class*="file-item"]', '[class*="filetree"] li', '.filelist li', 'li[class]', '[class*="tree__item"]', '[class*="docitem"]', '[class*="doc-item"]']) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) hits.push({ sel, count: els.length, items: els.slice(0, 5).map(info) });
    }
    return {
      leftPanelCls: left ? String(left.className).slice(0, 80) : null,
      hits,
      sortBtn: Array.from(document.querySelectorAll('button')).filter((e) => /排序方式/.test(e.getAttribute('title') || '')).length,
    };
  });
  console.log('\n=== 左栏文件列表 DOM ===');
  console.log(JSON.stringify(domMap, null, 1).slice(0, 3000));

  /* ---------- 2. 排序复核：用真实列表项读顺序 ---------- */
  const readOrder = async () =>
    page.evaluate(() => {
      // 用「文件项」的公共特征：含 .md 或 draggable=true 的项
      const cands = Array.from(document.querySelectorAll('*')).filter((e) => {
        const t = (e.textContent || '').trim();
        return t.length > 2 && t.length < 60 && /\.md|日记|文件夹/.test(t || '') && e.children.length <= 3;
      });
      // 取最内层（避免父子重复）
      const leaf = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
      return leaf.map((e) => (e.textContent || '').trim().slice(0, 30));
    });

  const order1 = await readOrder();
  console.log(`\n列表项（${order1.length} 个）：${fmt(order1.slice(0, 12))}`);

  const sortOptions = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((e) => /排序方式/.test(e.getAttribute('title') || ''));
    if (!btn) return [];
    btn.click();
    return Array.from(document.querySelectorAll('*'))
      .map((e) => ({ t: (e.textContent || '').trim(), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40) }))
      .filter((x) => x.t.length > 1 && x.t.length < 24 && /时间|字数|名称|升序|降序|类型|大小|标题/.test(x.t))
      .map((x) => x.t);
  });
  const uniqSort = [...new Set(sortOptions)];
  console.log(`排序选项（去重 ${uniqSort.length} 个）：${fmt(uniqSort)}`);

  s.step(
    '排序菜单存在且列出选项',
    '>= 4 种',
    `${uniqSort.length} 种：${fmt(uniqSort)}`,
    uniqSort.length >= 4,
    uniqSort.length > 0 && uniqSort.length < 6 ? `只有 ${uniqSort.length} 种，任务书要求 6 种` : '',
  );

  // 逐项点击并比较顺序
  const orders = [];
  for (const label of uniqSort.slice(0, 8)) {
    // 重新打开菜单（每次点击后会关闭）
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((e) => /排序方式/.test(e.getAttribute('title') || ''));
      btn?.click();
    });
    await page.waitForTimeout(700);
    const clicked = await page.evaluate((lbl) => {
      const els = Array.from(document.querySelectorAll('button, li, [role="menuitem"], div'));
      const hit = els.find((e) => (e.textContent || '').trim() === lbl && e.children.length <= 2);
      if (!hit) return false;
      hit.click();
      return true;
    }, label);
    await page.waitForTimeout(1000);
    const ord = await readOrder();
    orders.push({ label, clicked, order: ord.join('|'), n: ord.length });
    s.step(
      `排序「${label}」`,
      '点击生效（顺序变化或至少可选中）',
      `clicked=${clicked}, 项数=${ord.length}, 顺序=${JSON.stringify(ord.slice(0, 6))}`,
      clicked,
      clicked && ord.length <= 1 ? '列表只有 <=1 项，无法验证顺序变化（设计如此，非缺陷）' : '',
    );
  }
  const uniqOrders = new Set(orders.map((o) => o.order));
  s.step(
    '不同排序产生不同顺序',
    '唯一顺序数 >= 2（项数 >1 时）',
    `唯一顺序数=${uniqOrders.size}，各项数=${fmt(orders.map((o) => o.n))}`,
    uniqOrders.size >= 2,
    uniqOrders.size === 1 ? '所有排序结果顺序相同 —— 排序可能未接线，或列表项过少/排序字段相同' : '',
  );

  /* ---------- 3. Wikilink 复核：用 store 权威数据 ---------- */
  // 建 A，改名，看 B
  const mkDoc = async (title, body) => {
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(1500);
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    if (box) await page.mouse.click(box.x + 50, box.y + 24);
    await page.keyboard.type(body, { delay: 3 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2600);
    const st = await page.evaluate((expr) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      return { id: app?.activeTab?.id ?? '', title: app?.activeTab?.title ?? '', content: app?.activeTab?.content ?? '' };
    }, APP_STORE);
    if (st.id) tempDocs.add(st.id);
    return st;
  };

  const A = await mkDoc('A', `# 复核源${Date.now() % 10000}`);
  const nameA = A.content.replace(/^#\s*/, '').split('\n')[0].trim();
  const B = await mkDoc('B', `引用：[[${nameA}]]`);
  console.log(`\nA: title=${JSON.stringify(A.title)} nameA=${JSON.stringify(nameA)}`);
  console.log(`B 内容: ${JSON.stringify(B.content)}`);

  const newName = `改名后${Date.now() % 10000}`;
  const renameResult = await page.evaluate(
    async ({ expr, id, nn }) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      try {
        await app.renameDoc(id, nn);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e).slice(0, 140) };
      }
    },
    { expr: APP_STORE, id: A.id, nn: newName },
  );
  await page.waitForTimeout(4000);

  const after = await page.evaluate(
    async ({ expr, bId }) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      const tabs = app?.tabs ?? [];
      const bTab = tabs.find((t) => t.id === bId);
      // 也从 vault 读真实落盘内容
      let vaultContent = null;
      try {
        vaultContent = await app.vault.read(bId);
      } catch {
        vaultContent = null;
      }
      return {
        bTabContent: bTab?.content ?? null,
        bVaultContent: vaultContent,
        aTitles: tabs.filter((t) => t.id !== bId).map((t) => t.title).slice(0, 5),
      };
    },
    { expr: APP_STORE, bId: B.id },
  );

  console.log(`\n重命名结果: ${fmt(renameResult)}`);
  console.log(`B 的 store 内容: ${JSON.stringify(after.bTabContent)}`);
  console.log(`B 的落盘内容: ${JSON.stringify(after.bVaultContent)}`);
  console.log(`其他文档标题: ${fmt(after.aTitles)}`);

  const rewritten = (txt) => Boolean(txt) && !txt.includes(nameA) && txt.includes(newName);
  s.step(
    '重命名后用 renameDoc：B 的 Wikilink 是否重写',
    'B 内容含新名、不含旧名',
    `store=${JSON.stringify((after.bTabContent || '').slice(0, 80))}, vault=${JSON.stringify((after.bVaultContent || '').slice(0, 80))}`,
    rewritten(after.bTabContent) || rewritten(after.bVaultContent),
    !rewritten(after.bTabContent) && !rewritten(after.bVaultContent)
      ? `重命名成功（title 已变${fmt(after.aTitles)}）但 B 里的 [[${nameA}]] 未更新 → Wikilink 失效`
      : '',
  );

  s.end();
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
} finally {
  await unguard().catch(() => {});
  for (const id of tempDocs) {
    await page
      .evaluate(async ({ expr, id: d }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        try { await app.deleteDoc(d); return true; } catch { return false; }
      }, { expr: APP_STORE, id })
      .catch(() => {});
  }
  await page.waitForTimeout(2500);
  await browser.close().catch(() => {});
  assertZeroWrites('复核');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-review.json');
  scenarioSummary();
}
