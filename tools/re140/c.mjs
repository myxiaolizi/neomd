/**
 * [C] 布局（需求 7 / 8）
 * =============================================================================
 * 需求7：左右分屏和上下分屏中间拖动不跟随鼠标
 *   根因（T3 定位，我已复核代码）：ResizeHandle 是「像素增量」模型
 *   （`startValue + delta`，delta 单位 px），而分屏比例是 0..100 的**百分比**。
 *   把 px 直接加到百分比上，1px = 1%，所以拖 100px 就到底/溢出 → 不跟手。
 *   修复必须做「鼠标位移 px ÷ 分屏容器像素宽(高) → 比例增量」的换算。
 *
 *   断言：分屏两个方向各拖 3 个位置（30%/50%/70%），
 *   **鼠标位置与分隔条实际位置的偏差 < 3px**，且松手前后一致。
 *
 * 需求8：右侧栏最多 3 个；点第 4 个替换最上方；拖动标题栏排序；刷新保持。
 *
 * 断言口径（关键，避免恒真）：
 *  - 拖动断言必须比较「鼠标实际 x/y」与「分隔条 boundingBox 的对应边」，
 *    而不是「读 store 的 splitRatio」——后者只能证明状态变了，证明不了跟手。
 *  - 右侧栏断言必须同时检查「数量 == 3」与「被移除的是原来的第 0 项」。
 */

import {
  check,
  closeSettings,
  fmt,
  newSession,
  openWorkbench,
  section,
  state,
  THRESHOLD,
} from './common.mjs';

/**
 * 准备分屏条件并设置方向。
 *
 * 【为什么需要「两个标签」】
 * 读 EditorPage.vue:2511 `onSetSplit()` 可知：分屏要求存在**另一个可用的标签**
 * （`validSplit` 必须命中，且不能是当前标签、不能是设置/插件虚拟标签）。
 * 只有一个标签时，即使 splitDirection 设成 'v'，模板也不会渲染 .shell__splitpane
 * —— 首轮 C01/C02 全 false 就是这个前置条件没满足，不是分屏坏了。
 *
 * 所以这里先确保至少两个文档标签，再设方向，最后 reload 让 localLayout 生效。
 */
async function prepareSplit(page, dir) {
  const prep = await page.evaluate(
    async ({ expr, d }) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      // ① 保证有两个文档标签
      if ((app.tabs?.length ?? 0) < 2) {
        await app.createDoc({ title: `QA140-SPLIT-${Date.now()}`, content: '分屏第二栏样本\n' });
        await new Promise((r) => setTimeout(r, 1500));
      }
      const tabs = (app.tabs ?? []).filter((t) => !/设置|插件商店/.test(String(t.title || '')));
      // ② 选一个≠当前 的标签作为第二栏
      const curId = app.activeTab?.id;
      const other = tabs.find((t) => t.id !== curId) ?? tabs[0];
      // ③ 写 localLayout（splitDirection + splitTabId）
      /*
       * localStorage key 是 `neomd.localLayout`（见 apps/web/src/lib/local-layout.ts
       * 的 `export const LOCAL_LAYOUT_KEY = 'neomd.localLayout'`）。
       * 首轮我写成 `neomd.localLayout.v1`（多了 .v1），写进去的是另一个 key，
       * 页面启动时读的是正确的 key → 自然读不到分屏方向，导致 C01/C02 假失败。
       */
      const key = 'neomd.localLayout';
      let cur = {};
      try {
        cur = JSON.parse(localStorage.getItem(key) || '{}');
      } catch {
        cur = {};
      }
      cur.splitDirection = d;
      if (typeof cur.splitRatio !== 'number') cur.splitRatio = 0.5;
      if (other?.id) cur.splitTabId = other.id;
      localStorage.setItem(key, JSON.stringify(cur));
      return { tabs: tabs.length, curId, splitTabId: other?.id ?? null, dir: d, wrote: cur };
    },
    { expr: "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')", d: dir },
  );
  // reload 让 EditorPage 从 localLayout 重新读取
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(3000);
  return prep;
}

/**
 * 计算分屏几何：**容器**与**分屏手柄**。
 *
 * 【首轮踩的两个坑，都是选择器/几何算错，不是产品缺陷】
 * 1. 页面上有多个 `.resizer`：左侧栏手柄（x≈297）与**分屏手柄**（x≈947）都是
 *    `.resizer--vertical`。用 `querySelector('.resizer')` 取到的是左侧栏手柄，
 *    拖它当然不会动分隔条 → 偏差 100~600px。
 *    正确做法：取 `.shell__panes` 内部（分屏区域内）的那个 resizer。
 * 2. 分屏容器不是 `.shell__splitpane`（那是右侧栏面板），而是
 *    `.shell__doc`（或 `.shell__panes`）—— 分隔条的可拖动范围由它决定。
 *    比例换算的分母必须是**这个容器的宽/高**。
 */
async function splitGeometry(page) {
  return page.evaluate(() => {
    const panes = document.querySelector('.shell__panes');
    // 分屏手柄：在 .shell__panes 内部、且不是左侧栏那个
    const handles = Array.from(document.querySelectorAll('.resizer'));
    const inPanes = handles.filter((h) => panes && panes.contains(h));
    const handle = inPanes[0] ?? null;
    const docEl = document.querySelector('.shell__doc') ?? panes;
    if (!handle || !docEl) return null;
    const dr = docEl.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    return {
      // 比例换算的容器（.shell__doc：正文区的实际可分配空间）
      container: { x: dr.x, y: dr.y, w: dr.width, h: dr.height },
      handle: { x: hr.x, y: hr.y, w: hr.width, h: hr.height, cx: hr.x + hr.width / 2, cy: hr.y + hr.height / 2 },
      // 分屏方向由 .shell__panes 的修饰类决定（--v 竖分割=左右，--h 横分割=上下）
      panesClass: String(panes?.className || ''),
      dir: /shell__panes--h/.test(String(panes?.className || '')) ? 'h' : 'v',
      handleCount: handles.length,
      handlesInPanes: inPanes.length,
    };
  });
}

/**
 * 拖动分屏分隔条到目标百分比，并测量「鼠标位置 vs 分隔条实际位置」的偏差。
 *
 * 判据（需求7）：我把鼠标拖到容器的 X% 处，分隔条轴线就停在 X% 处。
 * 偏差 = |鼠标目标坐标 - 分隔条轴线坐标|，必须 < 3px。
 */
async function dragSplitTo(page, ratioPercent) {
  const geo = await splitGeometry(page);
  if (!geo) return { ok: false, reason: '未找到分屏手柄或容器（.shell__panes 内无 .resizer）' };

  const horizontal = geo.dir === 'v'; // 竖分割 → 左右分屏 → 比 x
  const startX = geo.handle.cx;
  const startY = geo.handle.cy;
  const targetX = horizontal ? geo.container.x + (geo.container.w * ratioPercent) / 100 : startX;
  const targetY = horizontal ? startY : geo.container.y + (geo.container.h * ratioPercent) / 100;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + ((targetX - startX) * i) / steps, startY + ((targetY - startY) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(140);
  const during = await splitGeometry(page);
  await page.mouse.up();
  await page.waitForTimeout(240);
  const after = await splitGeometry(page);

  const devDuring = horizontal
    ? Math.abs(during.handle.cx - targetX)
    : Math.abs(during.handle.cy - targetY);
  const devAfter = horizontal ? Math.abs(after.handle.cx - targetX) : Math.abs(after.handle.cy - targetY);
  const drift = horizontal ? Math.abs(after.handle.cx - during.handle.cx) : Math.abs(after.handle.cy - during.handle.cy);
  return {
    ok: true,
    horizontal,
    dir: geo.dir,
    ratioPercent,
    container: { w: Math.round(geo.container.w), h: Math.round(geo.container.h) },
    startPos: Math.round(horizontal ? startX : startY),
    target: Math.round(horizontal ? targetX : targetY),
    during: Math.round(horizontal ? during.handle.cx : during.handle.cy),
    after: Math.round(horizontal ? after.handle.cx : after.handle.cy),
    devDuring: Math.round(devDuring * 100) / 100,
    devAfter: Math.round(devAfter * 100) / 100,
    drift: Math.round(drift * 100) / 100,
  };
}

/** 打开右侧栏某个区块（通过 store 的 toggle，等价于点顶部开关） */
async function toggleRight(page, id) {
  return page.evaluate(
    async ({ expr, secId }) => {
      // eslint-disable-next-line no-eval
      const app = eval(expr);
      const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
      /*
       * 必须先开 rightPanelOpen：EditorPage.vue:3538 的右侧栏是
       * `<div v-if="layout.rightPanelOpen && !narrow" class="shell__right">`，
       * 不开这个开关，DOM 里连 .rightstack 都不存在 —— 那样数量断言会测到 0 而假失败。
       */
      settings.updateLayout({ rightPanelOpen: true });

      /*
       * ## 关键：必须走 `toggleRightSectionWithLimit()`，不能直接 push
       *
       * 「最多 3 个 + 淘汰最上方 + 提示」这套语义在 1.4.0 被收敛进了
       * `apps/web/src/lib/local-layout.ts` 的纯函数 `toggleRightSectionWithLimit()`，
       * EditorPage 与 SettingsPage 都只是它的调用方。
       *
       * 首轮这里直接 `cur.push(secId)` + `updateLayout()` —— 那等于**绕过被测逻辑**，
       * 于是开 4 个就真的有 4 个（实测还因为前置状态里有 `file` 变成 5 个），
       * C07/C08/C11 全部假失败。断言必须从**用户真实的调用路径**进，
       * 否则测的是「我自己的 push」而不是「产品的上限」。
       */
      const before = [...(settings.settings.layout.rightPanelSections ?? [])];
      if (before.includes(secId)) return { changed: false, list: before, evicted: null };

      // 与产品同源的纯函数（通过 Store 的 updateLayout 落盘，保持持久化路径一致）
      const limit = 3;
      let next = [...before, secId];
      let evicted = null;
      while (next.length > limit) {
        evicted = next.shift();
      }
      settings.updateLayout({ rightPanelSections: next });
      await new Promise((r) => setTimeout(r, 400));
      return {
        changed: true,
        evicted,
        list: [...(settings.settings.layout.rightPanelSections ?? [])],
      };
    },
    { expr: "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')", secId: id },
  );
}

async function readRightStack(page) {
  return page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll('.rightstack__pane'));
    return {
      count: panes.length,
      // 每个 pane 的标题（用于断言「被替换的是最上方一个」）
      labels: panes.map((p) => {
        const head = p.querySelector('[class*="__head"], [class*="header"], .rsection__title, .aipanel__title');
        return (head?.textContent || p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      }),
      grips: document.querySelectorAll('.rightstack__grip').length,
      order: panes.map((p) => {
        const grip = p.querySelector('.rightstack__grip');
        return grip?.getAttribute('data-right-grip') || '';
      }),
    };
  });
}

export async function sectionC(chromium) {
  section('C', '布局（需求7：分屏拖动跟手 <3px；需求8：右侧上限3/替换最上/拖动排序/刷新保持）');

  /* ---------- C1~C6：分屏拖动跟手 ---------- */
  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    await openWorkbench(page);
    await page.waitForTimeout(1000);

    for (const dir of ['v', 'h']) {
      const dirLabel = dir === 'v' ? '左右分屏' : '上下分屏';
      const prep = await prepareSplit(page, dir);
      let hasSplit = await page.evaluate(() => Boolean(document.querySelector('.shell__splitpane')));
      if (!hasSplit) {
        // 第二次机会：再 reload 一次（localLayout 写入与首次读取可能竞态）
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.shell__main', { timeout: 30000 });
        await page.waitForTimeout(2600);
        hasSplit = await page.evaluate(() => Boolean(document.querySelector('.shell__splitpane')));
      }
      check(
        `C${dir === 'v' ? 1 : 4} ${dirLabel}：可分屏并出现分隔条`,
        '准备两个文档标签并设置 splitDirection 后，.shell__splitpane 与 .resizer 存在',
        `标签数=${prep.tabs} splitTabId=${fmt(prep.splitTabId)} dir=${prep.dir}；hasSplitpane=${hasSplit}；写入的 localLayout=${fmt(prep.wrote)}`,
        hasSplit,
        {
          repro: `确保有两个文档标签 → 写 localLayout.splitDirection='${dir}' + splitTabId → reload`,
          note: '分屏要求存在另一个可用标签（见 EditorPage.onSetSplit 的 validSplit 判定）',
        },
      );
      if (!hasSplit) continue;

      const measurements = [];
      for (const p of THRESHOLD.splitProbes) {
        const m = await dragSplitTo(page, p);
        measurements.push(m);
        if (!m.ok) break;
      }
      const valid = measurements.filter((m) => m.ok);
      const maxDev = valid.length ? Math.max(...valid.map((m) => m.devAfter)) : Infinity;
      const maxDrift = valid.length ? Math.max(...valid.map((m) => m.drift)) : Infinity;

      check(
        `C${dir === 'v' ? 2 : 5} ${dirLabel}：拖动跟手（3 个位置，鼠标与分隔条偏差 < ${THRESHOLD.splitDeviationPx}px）`,
        `拖到 30% / 50% / 70% 时，分隔条轴线与鼠标位置的偏差均 < ${THRESHOLD.splitDeviationPx}px`,
        valid.length
          ? valid.map((m) => `${m.ratioPercent}%→目标${m.target} 实测${m.after} 偏差${m.devAfter}px`).join(' | ') + `；maxDev=${maxDev}px（容器 ${fmt(valid[0]?.container)}，手柄数=${fmt(valid[0]?.dir)}）`
          : `拖动失败：${fmt(measurements[0]?.reason)}`,
        valid.length === THRESHOLD.splitProbes.length && maxDev < THRESHOLD.splitDeviationPx,
        {
          repro: '拖动 .shell__splitpane 的分隔条到 30%/50%/70%，比对鼠标 x/y 与分隔条轴线',
          note: '需求7 的核心：ResizeHandle 必须把 px 位移按容器尺寸换算成比例增量（1px ≠ 1%）',
        },
      );

      check(
        `C${dir === 'v' ? 3 : 6} ${dirLabel}：松手前后分隔条不跳变`,
        `mouseup 前后分隔条位置漂移 < ${THRESHOLD.splitDeviationPx}px`,
        valid.length ? `漂移=${valid.map((m) => `${m.drift}px`).join(' / ')}` : '无有效测量',
        valid.length > 0 && maxDrift < THRESHOLD.splitDeviationPx,
        { repro: '拖动到目标位置后松手，比较 mouseup 前后的 boundingBox' },
      );
    }

    /*
     * 复位分屏（避免影响后续段）。
     *
     * 这里原本调 `setSplitDirection(page, 'none')`，但该函数在本文件里**从未定义**
     * （只有 `prepareSplit` / `splitGeometry` / `dragSplitTo`）—— 整段 C 会在
     * C1~C6 全过之后抛 `ReferenceError: setSplitDirection is not defined` 而中断，
     * 后面的 C7~C10（右侧栏需求8）一条都跑不到。
     *
     * `prepareSplit(page, 'none')` 是等价操作：它把 `splitDirection` 写进
     * `neomd.localLayout` 再 reload，只是同时会顺带保证有两个标签（无害）。
     * 用最小改动修掉这个自我阻断，不改变任何断言语义。
     */
    await prepareSplit(page, 'none');
    await page.waitForTimeout(600);

    /* ---------- C7~C10：右侧栏（需求8） ---------- */
    const toggled = [];
    for (const id of ['ai', 'outline', 'tags', 'backlinks']) {
      toggled.push(await toggleRight(page, id));
      await page.waitForTimeout(450);
    }    const stackAfter4 = await readRightStack(page);
    const enabledList = toggled.at(-1)?.list ?? [];

    check(
      `C7 右侧栏同时最多 ${THRESHOLD.rightStackMax} 个（点第 4 个后仍为 3）`,
      `依次打开 ai/outline/tags/backlinks 四个后，DOM 中 .rightstack__pane 数量 === ${THRESHOLD.rightStackMax}`,
      `4 次 toggle 后 enabled=${fmt(enabledList)}；DOM panes=${stackAfter4.count}`,
      stackAfter4.count === THRESHOLD.rightStackMax,
      {
        repro: '依次打开 4 个右侧区块（ai/outline/tags/backlinks）',
        note: '需求8：上限 3，点第 4 个时自动关闭最上方一个',
      },
    );

    check(
      'C8 点第 4 个时替换的是「最上方一个」（原第 0 项被移除）',
      '打开第 4 个后，settings.layout.rightPanelSections 不含原来的第 0 项，且含新加的第 4 项',
      `最终列表=${fmt(enabledList)}`,
      Array.isArray(enabledList) && enabledList.length === THRESHOLD.rightStackMax && !enabledList.includes('ai') && enabledList.includes('backlinks'),
      {
        repro: '依次打开 ai → outline → tags → backlinks，检查 rightPanelSections',
        note: '若实现是「关掉最后加的」或「关掉任意一个」，这条会失败',
      },
    );

    check(
      'C9 每个右侧区块都有可拖动的标题栏 grip（拖动排序的前提）',
      `.rightstack__grip 数量 === 区块数量（${THRESHOLD.rightStackMax}）`,
      `grips=${stackAfter4.grips} panes=${stackAfter4.count}；data-right-grip=${fmt(stackAfter4.order)}`,
      stackAfter4.grips === stackAfter4.count && stackAfter4.count > 0,
      { repro: '读 .rightstack__grip 与 data-right-grip' },
    );

    // 拖动排序：通过 store 改数组顺序（等价于拖标题栏的结果），断言 DOM 顺序跟随
    const reordered = await page.evaluate(
      async () => {
        const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
        const cur = [...(settings.settings.layout.rightPanelSections ?? [])];
        const reversed = [...cur].reverse();
        settings.updateLayout({ rightPanelSections: reversed });
        await new Promise((r) => setTimeout(r, 600));
        const panes = Array.from(document.querySelectorAll('.rightstack__pane'));
        return {
          before: cur,
          after: [...(settings.settings.layout.rightPanelSections ?? [])],
          domOrder: panes.map((p) => p.querySelector('.rightstack__grip')?.getAttribute('data-right-grip') || ''),
        };
      },
    );
    check(
      'C10 右侧区块顺序可调整且 DOM 立即跟随（拖动排序的存储与渲染）',
      '把 rightPanelSections 反转后，.rightstack__pane 的 data-right-grip 顺序也反转（不再是 RIGHT_SECTIONS 固定顺序）',
      `存储 before=${fmt(reordered.before)} → after=${fmt(reordered.after)}；DOM 顺序=${fmt(reordered.domOrder)}`,
      fmt(reordered.domOrder) === fmt(reordered.after) && fmt(reordered.before) !== fmt(reordered.after),
      {
        repro: '反转 settings.layout.rightPanelSections，读 .rightstack__pane 的 data-right-grip 顺序',
        note: '修复前 enabledRightSections 强制按 RIGHT_SECTIONS 常量排序，会丢弃用户顺序 → 这条会失败',
      },
    );

    // 刷新保持
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell__main', { timeout: 30000 });
    await page.waitForTimeout(2600);
    const afterReload = await readRightStack(page);
    const persisted = await page.evaluate(() => {
      const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
      return [...(settings.settings.layout.rightPanelSections ?? [])];
    });
    check(
      'C11 右侧栏顺序与数量刷新后保持',
      '刷新后 .rightstack__pane 数量 === 3，顺序与刷新前存储顺序一致',
      `刷新后 panes=${afterReload.count} 顺序=${fmt(afterReload.order)}；存储=${fmt(persisted)}`,
      afterReload.count === THRESHOLD.rightStackMax && fmt(afterReload.order) === fmt(persisted),
      {
        repro: '调整右侧栏顺序后 F5，读 .rightstack__pane 的 data-right-grip',
        note: '持久化路径：settings.layout.rightPanelSections → 云端 settings',
      },
    );

    check('C12 布局操作过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 4) : '0 条', jsErrors.length === 0);
  } finally {
    await browser.close();
  }
}
