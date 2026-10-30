/**
 * [F] 设置项无重复
 * =============================================================================
 * 缺陷6：设置里部分选项重复出现（正文字体在「编辑」和「主题」两个页签都出现）。
 *
 * 统计单位的选择（这是本节最容易写错的地方，首轮跑测踩过两次）：
 *
 *  1. **不能按 label 字符串计数**。同一个控件往往同时有 `aria-label` 和相邻的
 *     可视 label 文本（`aria-label="编辑器正文字号"` + 可见「正文字号（px）」），
 *     按字符串数会把一个控件算成两项 -> 假重复。
 *     => 先按「控件 DOM 路径」去重，一个控件只算一次。
 *
 *  2. **不能把页签导航容器算进去**。`.settings__nav` 自身的
 *     `aria-label="设置分类"` 会被每个页签重复采到，但它不是设置项。
 *     => 采集时排除 `closest('.settings__nav')`。
 *
 *  3. **不能按控件统计"设置项"**。一个设置项里合法地可以有多个控件 ——
 *     「主色调」是 5 个色板按钮、「AI 命名提示词」是 textarea + 恢复默认按钮，
 *     它们共享同一个 label 是正常的。
 *     => 判断"选项重复出现"的统计单位是 `.field` 容器（= 一个设置项）。
 *
 * 语义归一：不同页签里同义不同名的标签必须算同一项
 * （正文字体/正文字体族、正文字号/编辑器正文字号、正文行高/编辑器正文行高）。
 */

import {
  check,
  fmt,
  newSession,
  openSettings,
  openWorkbench,
  section,
  shot,
  THRESHOLD,
  defaultSeed,
} from './common.mjs';

/**
 * 语义归类表：把「同义不同名」的设置项映射到同一个 key。
 * 这是「正文字体/正文字体族」两处重复能被抓到的关键。
 */
const SEMANTIC_KEYS = [
  { key: 'font-family', re: /字体|font-?family/i },
  { key: 'font-size', re: /字号|font-?size/i },
  { key: 'line-height', re: /行高|line-?height/i },
  { key: 'page-width', re: /页宽|页面宽度|page-?width/i },
  { key: 'line-numbers', re: /行号|line-?number/i },
  { key: 'spellcheck', re: /拼写|spell/i },
  { key: 'typewriter', re: /打字机|typewriter/i },
  { key: 'zoom', re: /缩放|zoom/i },
];

function semanticKeyOf(label) {
  const text = String(label || '').trim();
  if (!text) return null;
  const hit = SEMANTIC_KEYS.find((s) => s.re.test(text));
  return hit ? hit.key : null;
}

/** 依次点击每个页签并执行采集 */
async function forEachTab(page, tabs, collect) {
  const out = [];
  for (const tab of tabs) {
    await page.evaluate((label) => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find(
        (e) => (e.textContent || '').trim() === label,
      );
      el?.click();
    }, tab);
    await page.waitForTimeout(460);
    out.push({ tab, ...(await collect(tab)) });
  }
  return out;
}

export async function sectionF(chromium) {
  section('F', '设置项无重复（遍历全部页签：控件级去重 + 语义去重 + 字段容器去重）');

  const { browser, page, jsErrors } = await newSession(chromium, { seedSettings: defaultSeed() });
  try {
    await openWorkbench(page);
    await openSettings(page);
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim()),
    );

    /* ---------- 采集 1：控件级（排除导航容器，按 DOM 路径去重） ---------- */
    const perTab = await forEachTab(page, tabs, () =>
      page.evaluate(() => {
        const pane = document.querySelector('.settings');
        if (!pane) return { controls: [] };
        const candidates = Array.from(
          pane.querySelectorAll(
            'input, select, textarea, button[aria-label], [role="switch"], [aria-pressed], [role="slider"]',
          ),
        ).filter((el) => !el.closest('.settings__nav'));
        const seen = new Set();
        const controls = [];
        for (const el of candidates) {
          const parts = [];
          let cur = el;
          while (cur && cur !== pane) {
            const parent = cur.parentElement;
            if (!parent) break;
            parts.unshift(`${cur.tagName}:${Array.prototype.indexOf.call(parent.children, cur)}`);
            cur = parent;
          }
          const key = parts.join('/');
          if (seen.has(key)) continue;
          seen.add(key);
          const aria = String(el.getAttribute('aria-label') || '').trim();
          const field = el.closest('.field, .row-between, .field--row') ?? el.parentElement;
          const visible = String(field?.querySelector('.nm-label, label')?.textContent || '').trim();
          controls.push({ key, tag: el.tagName, aria, visible });
        }
        return { controls };
      }),
    );
    await shot(page, 'F-settings-tabs');

    /* ---------- F1：aria-label 不得被两个不同控件共用 ---------- */
    const ariaIndex = new Map();
    for (const t of perTab) {
      for (const c of t.controls) {
        if (!c.aria) continue;
        const list = ariaIndex.get(c.aria) ?? [];
        if (!list.some((x) => x.key === c.key)) list.push({ key: c.key, tab: t.tab });
        ariaIndex.set(c.aria, list);
      }
    }
    const ariaDupes = [...ariaIndex.entries()].filter(([, v]) => v.length > 1);
    const ariaTotal = [...ariaIndex.values()].reduce((n, v) => n + v.length, 0);
    check(
      'F1 设置控件的 aria-label 不被两个不同控件共用',
      '0 个 aria-label 被 >=2 个不同控件使用（已排除页签导航容器 .settings__nav）',
      ariaDupes.length
        ? `${ariaDupes.length} 个共享：${fmt(ariaDupes)}`
        : `0 个（共 ${ariaTotal} 个控件带 aria-label / ${tabs.length} 个页签）`,
      ariaDupes.length === 0,
      { repro: '打开设置 -> 逐页签收集 [aria-label]（排除 .settings__nav）-> 按控件 DOM 路径去重后统计' },
    );

    /* ---------- F2：同一语义项不得跨页签重复 ---------- */
    const semantic = new Map();
    for (const t of perTab) {
      for (const c of t.controls) {
        const key = semanticKeyOf(`${c.aria} ${c.visible}`);
        if (!key) continue;
        const list = semantic.get(key) ?? [];
        if (!list.some((x) => x.key === c.key)) list.push({ key: c.key, tab: t.tab, label: c.aria || c.visible });
        semantic.set(key, list);
      }
    }
    const semanticDupes = [...semantic.entries()].filter(([, v]) => new Set(v.map((x) => x.tab)).size > 1);
    const semanticSummary = Object.fromEntries([...semantic.entries()].map(([k, v]) => [k, v.map((x) => `${x.tab}/${x.label}`)]));
    check(
      'F2 语义去重：字体/字号/行高 等设置项不得跨页签重复',
      '每个语义项（font-family / font-size / line-height / page-width / line-numbers / spellcheck / typewriter / zoom）只出现在**一个**页签',
      semanticDupes.length
        ? `${semanticDupes.length} 项跨页签重复：${fmt(semanticDupes.map(([k, v]) => [k, v.map((x) => x.tab)]))}`
        : `0 项跨页签重复：${fmt(semanticSummary)}`,
      semanticDupes.length === 0,
      {
        repro: '设置 -> 主题 与 设置 -> 编辑器 两个页签都能看到字体/字号/行高控件（修复前）',
        note: '用户反馈「设置里选项重复出现」的落点；按控件路径去重，避免 aria-label 与可视 label 被算两次',
      },
    );

    /* ---------- F3：字体/字号/行高 各恰好 1 个控件（既不多也不少） ---------- */
    const counts = {};
    for (const key of THRESHOLD.uniqueFontControls) counts[key] = (semantic.get(key) ?? []).length;
    check(
      'F3 正文字体 / 字号 / 行高 各恰好 1 个控件',
      'font-family = 1、font-size = 1、line-height = 1（既不多也不少，防止「全删了」也算通过）',
      fmt(counts),
      THRESHOLD.uniqueFontControls.every((k) => counts[k] === 1),
      { repro: '同上；统计各语义项的控件数量' },
    );

    /* ---------- F4：同一页签内不得出现两个语义相同的控件 ---------- */
    const inTabDupes = [];
    for (const t of perTab) {
      const bySemantic = new Map();
      for (const c of t.controls) {
        const key = semanticKeyOf(`${c.aria} ${c.visible}`);
        if (!key) continue;
        bySemantic.set(key, (bySemantic.get(key) ?? 0) + 1);
      }
      for (const [k, n] of bySemantic) if (n > 1) inTabDupes.push({ tab: t.tab, semantic: k, count: n });
    }
    check(
      'F4 同一页签内无重复语义控件（页内不重复）',
      '0 个页签出现同一语义项的 2 个控件',
      inTabDupes.length ? fmt(inTabDupes) : '0 个',
      inTabDupes.length === 0,
      { repro: '设置 -> 编辑器：字体与排版区块原先出现两次（⑤ 字体与排版 / 字体、字号与排版）' },
    );

    /* ---------- 采集 2：设置项容器级（.field） ---------- */
    const fieldPerTab = await forEachTab(page, tabs, () =>
      page.evaluate(() => {
        const pane = document.querySelector('.settings');
        if (!pane) return { fields: [] };
        return {
          fields: Array.from(pane.querySelectorAll('.field, .field--row, .row-between'))
            .filter((el) => !el.parentElement?.closest('.field, .field--row, .row-between'))
            .map((el) => ({
              label: String(el.querySelector('.nm-label, label')?.textContent || '').trim(),
              hasControl: Boolean(
                el.querySelector('input, select, textarea, button[aria-label], .toggle-btn, [role="switch"]'),
              ),
            }))
            .filter((f) => f.label && f.hasControl),
        };
      }),
    );

    /* ---------- F5：设置项（字段容器）不重名 ---------- */
    const fieldIndex = new Map();
    for (const t of fieldPerTab) {
      for (const f of t.fields) {
        const list = fieldIndex.get(f.label) ?? [];
        list.push(t.tab);
        fieldIndex.set(f.label, list);
      }
    }
    const fieldDupes = [...fieldIndex.entries()].filter(([, v]) => v.length > 1);
    check(
      'F5 设置项（字段容器）不重名：同一标签不得出现在两个设置项里',
      '0 个设置项标签被 >=2 个不同设置项使用',
      fieldDupes.length
        ? `${fieldDupes.length} 个重名：${fmt(fieldDupes)}`
        : `0 个（共 ${fieldIndex.size} 个设置项，覆盖 ${tabs.length} 个页签）`,
      fieldDupes.length === 0,
      {
        repro: '逐页签收集 .field 容器与其 .nm-label 文本 -> 统计重名',
        note: '同一 .field 内多个控件（色板组、字段+重置按钮）共享 label 属正常，按字段容器计',
      },
    );

    check(
      'F6 设置页遍历过程无 JS 运行时错误',
      '0 条 pageerror',
      jsErrors.length ? jsErrors.slice(0, 3) : '0 条',
      jsErrors.length === 0,
    );
  } finally {
    await browser.close();
  }
}
