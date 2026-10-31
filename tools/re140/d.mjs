/**
 * [D] 设置与主题（需求 11 / 12 / 13 / 14 / 15 / 16）
 * =============================================================================
 * 这是本版重灾区。7 项需求 + T4 的「保存按钮 / 草稿模式」大改造，
 * 断言必须能区分「不保存不生效」与「保存后生效」—— 否则就是恒真。
 *
 *  D1~D3  需求11：分割线在 5 套主题下对比度 >= 1.2（--border vs --bg）
 *  D4~D6  需求12：all / content / chrome 三档作用域语义正确
 *  D7~D8  需求13：颜色细化保存后生效
 *  D9~D10 需求14：全部设置项逐项有效果（无效 = 0）
 *  D11    需求15：设置页不得渲染正文工具栏（.editorbar）
 *  D12~D15 需求16：保存按钮语义（不改不保存→不生效；改+保存→生效且刷新保持）
 *
 * 【关键设计：保存语义怎么测才不恒真】
 * 「保存按钮」= 草稿模式。要证明它真的存在且生效，必须同时满足两个方向：
 *   (a) 改动但**不保存** → 关闭设置 → 重开 → 值回到改动前（草稿被丢弃）
 *   (b) 改动且**保存** → 关闭设置 → 重开（甚至刷新）→ 值保持（已落 store）
 * 只测 (b) 无法区分「有保存按钮」与「即时生效」——两者都会让 (b) 成立。
 * 只测 (a) 无法区分「草稿模式」与「设置根本没生效」。
 * 所以 (a)(b) 必须成对断言，且都挂在同一个设置项上。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  check,
  clickSettingsTab,
  closeSettings,
  colorClose,
  contrastRatio,
  fmt,
  httpJson,
  API,
  authHeaders,
  newSession,
  openSettings,
  openWorkbench,
  readCssVars,
  readSaveBar,
  restoreSettings,
  saveSettings,
  cancelSettings,
  escapeSettings,
  ROOT,
  section,
  settingsTabs,
  sh,
  shot,
  snapshotSettings,
  state,
  THRESHOLD,
} from './common.mjs';

const THEME_VARS = ['--border', '--border-strong', '--bg', '--content-bg', '--fg', '--table-border', '--content-fg'];
const SCOPE_VARS = ['--content-bg', '--content-fg', '--bg', '--fg', '--border', '--bg-sidebar'];

/** 读取当前主题下 5 套主题的分割线对比度 */
async function measureBordersPerTheme(page) {
  const results = [];
  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="theme-cards"] > *')).map((c) => ({
      idx: Array.prototype.indexOf.call(c.parentElement.children, c),
      label: (c.textContent || '').replace(/^Aa\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 16),
    })),
  );
  for (const card of cards) {
    await page.evaluate((idx) => {
      document.querySelectorAll('[data-testid="theme-cards"] > *')[idx]?.click();
    }, card.idx);
    await page.waitForTimeout(500);
    const v = await readCssVars(page, THEME_VARS);
    const border = v['--border']?.computed || '';
    const bg = v['--bg']?.computed || '';
    const contentBg = v['--content-bg']?.computed || '';
    const tableBorder = v['--table-border']?.computed || '';
    results.push({
      ...card,
      preset: v.__meta.preset,
      theme: v.__meta.theme,
      border,
      bg,
      contentBg,
      tableBorder,
      contrastVsBg: contrastRatio(border, bg),
      contrastVsContent: contrastRatio(border, contentBg),
      tableContrastVsContent: contrastRatio(tableBorder, contentBg),
    });
  }
  return results;
}

/** 设置页里「全部控件」的清单（需求14 用） */
async function collectControls(page) {
  const tabs = await settingsTabs(page);
  const out = [];
  for (const tab of tabs) {
    await clickSettingsTab(page, tab);
    const items = await page.evaluate(() => {
      const pane = document.querySelector('.settings');
      if (!pane) return [];
      const nodes = Array.from(
        pane.querySelectorAll('input, select, textarea, .toggle-btn, [role="switch"], [aria-pressed]'),
      ).filter((el) => !el.closest('.settings__nav'));
      const seen = new Set();
      const list = [];
      for (const el of nodes) {
        const field = el.closest('.field, .row-between, .field--row') ?? el.parentElement;
        const label = String(field?.querySelector('.nm-label, label')?.textContent || '').trim();
        const aria = String(el.getAttribute('aria-label') || '').trim();
        const key = `${tab}|${el.tagName}|${aria}|${label}`;
        if (!key.trim() || seen.has(key)) continue;
        seen.add(key);
        list.push({
          tab,
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          aria,
          label,
          key,
        });
      }
      return list;
    });
    out.push(...items);
  }
  return out;
}

export async function sectionD(chromium) {
  section('D', '设置与主题（需求11~16：分割线对比度/三档作用域/颜色细化/全项有效/无工具栏/保存语义）');

  /*
   * 【D 段采用「引用 Lead 审计脚本 + 本脚本最小断言」的混合口径】
   *
   * 为什么：需求11~16 的完整覆盖需要遍历 10 个页签的每个控件 + 10 套主题对比度
   * + 三档作用域 + 颜色细化 + 保存语义，Lead 已交付更成熟的独立脚本：
   *   tools/re14-settings-audit.mjs        （18/18 通过，覆盖需求11/12/13/14/16 核心）
   *   tools/re14-settings-save-verify.mjs  （15/15 通过，覆盖保存按钮语义）
   * 重复实现既慢又容易与产品实现脱节，因此 D 段：
   *   ① spawn 调用 Lead 的审计脚本，按退出码与输出断言（真实执行，不是抄结论）；
   *   ② 本脚本保留两条「门禁必须自己看见」的断言：设置页无正文工具栏、保存栏存在。
   * 这样既覆盖需求，又不写第二套可能过时的判据。
   */

  /* ---------- D1：调用 Lead 的设置审计脚本 ---------- */
  {
    const scriptPath = path.join(ROOT, 'tools', 're14-settings-audit.mjs');
    if (!fs.existsSync(scriptPath)) {
      check(
        'D1 设置全项审计（引用 tools/re14-settings-audit.mjs）',
        '该脚本存在并被成功执行',
        `脚本不存在：${scriptPath}`,
        false,
        { repro: 'node tools/re14-settings-audit.mjs', note: 'Lead 交付的独立审计脚本' },
      );
    } else {
      const r = sh('node', ['tools/re14-settings-audit.mjs'], { timeout: 900_000 });
      const out = r.out;
      /* 解析 `通过 N / 失败 M` 或 `N/M 通过` 形式的汇总 */
      const summaryHit =
        /通过\s*[:：]?\s*(\d+)\s*[/／]\s*(\d+)/.exec(out) ||
        /(\d+)\s*[/／]\s*(\d+)\s*通过/.exec(out) ||
        /共\s*(\d+)\s*项[，,]\s*通过\s*(\d+)/.exec(out);
      const passCount = summaryHit ? Number(summaryHit[1]) : -1;
      const totalCount = summaryHit ? Number(summaryHit[2]) : -1;
      const failLines = [...out.matchAll(/^\s*(?:\u2717|\u00d7|FAIL|失败)\s*[:：]?\s*(.+)$/gm)].map((m) => m[1].trim()).slice(0, 6);
      check(
        'D1 设置全项审计（引用 tools/re14-settings-audit.mjs，需求11/12/13/14/16）',
        '脚本 exit=0，且汇总显示 0 失败',
        `exit=${r.code}；汇总=${summaryHit ? `${passCount}/${totalCount}` : '未解析到汇总行'}；失败项=${fmt(failLines)}`,
        r.code === 0 && failLines.length === 0,
        {
          repro: 'node tools/re14-settings-audit.mjs',
          note: 'Lead 交付；覆盖三档作用域、10 套主题对比度、颜色细化、主色调归位、排版四项、不保存不生效',
        },
      );

      /* D2：保存按钮语义（Lead 的独立脚本） */
      const saveScript = path.join(ROOT, 'tools', 're14-settings-save-verify.mjs');
      if (fs.existsSync(saveScript)) {
        const rs = sh('node', ['tools/re14-settings-save-verify.mjs'], { timeout: 900_000 });
        const sFails = [...rs.out.matchAll(/^\s*(?:\u2717|\u00d7|FAIL|失败)\s*[:：]?\s*(.+)$/gm)].map((m) => m[1].trim()).slice(0, 6);
        check(
          'D2 设置保存按钮语义（引用 tools/re14-settings-save-verify.mjs，需求16）',
          '脚本 exit=0 且 0 失败（不保存不生效 / 保存后生效且刷新保持）',
          `exit=${rs.code}；失败项=${fmt(sFails)}`,
          rs.code === 0 && sFails.length === 0,
          { repro: 'node tools/re14-settings-save-verify.mjs', note: 'Lead 交付；15/15 覆盖保存语义' },
        );
      } else {
        check('D2 设置保存按钮语义（引用脚本）', 'tools/re14-settings-save-verify.mjs 存在', '脚本不存在', false, {
          repro: 'ls tools/re14-settings-save-verify.mjs',
        });
      }
    }
  }

  /* ---------- D3/D4：本脚本自己必须看见的两条（需求15 + 需求16 UI） ---------- */
  {
    const { browser, page, jsErrors } = await newSession(chromium);
    try {
      await openWorkbench(page);
      await openSettings(page, '通用');
      await page.waitForTimeout(900);

      const barInfo = await page.evaluate(() => {
        const bars = Array.from(document.querySelectorAll('.editorbar'));
        return {
          count: bars.length,
          details: bars.map((b) => {
            const r = b.getBoundingClientRect();
            return {
              visible: r.width > 0 && r.height > 0,
              w: Math.round(r.width),
              h: Math.round(r.height),
              btns: b.querySelectorAll('button').length,
            };
          }),
          activeTabIsSettings: /设置/.test(document.querySelector('.tab.is-active .tab__title')?.textContent || ''),
        };
      });
      check(
        'D3 设置标签页不渲染正文编辑工具栏（需求15）',
        '打开设置标签时 .editorbar 数量为 0 或全部不可见',
        `打开设置页时 .editorbar 数=${barInfo.count}；activeTabIsSettings=${barInfo.activeTabIsSettings}；明细=${fmt(barInfo.details)}`,
        barInfo.count === 0 || barInfo.details.every((d) => !d.visible),
        {
          repro: '打开设置标签 → 数 .editorbar 的数量与可见性',
          note: '需求15：设置界面还会出现正文工具栏',
        },
      );

      /* 反向断言：切回文档时工具栏必须还在（防「一刀切全局隐藏」） */
      const barOnDoc = await page.evaluate(async () => {
        const tabs = Array.from(document.querySelectorAll('.tab'));
        const doc = tabs.find((t) => !/设置|插件商店|后台/.test(t.textContent || ''));
        doc?.click();
        await new Promise((r) => setTimeout(r, 900));
        const bars = Array.from(document.querySelectorAll('.editorbar'));
        return { count: bars.length, visible: bars.filter((b) => b.getBoundingClientRect().width > 0).length };
      });
      check(
        'D4 文档标签页仍正常渲染工具栏（反向断言）',
        '切回文档标签后 .editorbar 存在且可见',
        `切回文档后 .editorbar 数=${barOnDoc.count}，可见=${barOnDoc.visible}`,
        barOnDoc.count >= 1 && barOnDoc.visible >= 1,
        { repro: '切回文档标签 → 数 .editorbar', note: '与 D3 成对，避免用全局隐藏绕过需求15' },
      );

      /* D5：保存栏存在（需求16 UI 层；语义由 D2 的独立脚本覆盖） */
      await openSettings(page, '通用');
      await page.waitForTimeout(600);
      const saveBar = await readSaveBar(page);
      check(
        'D5 设置页存在底部保存操作栏（需求16 UI）',
        'settings-save-bar 存在，含「保存」「取消」按钮',
        fmt(saveBar),
        saveBar.hasBar && saveBar.hasSave && saveBar.hasCancel,
        { repro: '打开设置页 → 查 [data-testid="settings-save-bar"] / settings-save / settings-cancel' },
      );

      check(
        'D6 设置操作过程无 JS 运行时错误',
        '0 条 pageerror',
        jsErrors.length ? jsErrors.slice(0, 3) : '0 条',
        jsErrors.length === 0,
      );
    } finally {
      await browser.close();
    }
  }
}

