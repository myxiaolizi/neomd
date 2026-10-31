/**
 * [C] PC 设置字体不被自动恢复
 * =============================================================================
 * 缺陷2：在设置里改正文字体，生效片刻后自己变回去。
 *
 * 复现条件（与线上一致）：
 *   云端仍是旧字体（另一台设备推过 / 上一次推送没成功），用户在本机把字体改成新值，
 *   随后 focus / visibilitychange 触发一次 pull。
 * 修复前的真实链路：push 因版本冲突失败 -> 30s 后的自动 pull 把云端旧 fontFamily
 * 合并回来 -> 用户看到「设置完一下就自己变回去」。
 * 因此本节让 PUT 恒返回 409、GET 恒返回旧值 —— 这正是缺陷的触发条件本身。
 *
 * 断言不变量：`appearance.fontFamily` 属于 GLOBAL_APPEARANCE_FIELDS（跨端强一致），
 * 但「本地显式改过且尚未推送成功」的值必须被保护，不得被云端旧值覆盖。
 *
 * 3 个字体值**并行**跑：每个都要等满 95s，串行需近 5 分钟；并行仍各自等满 95s，
 * 且三者互不共享 localStorage / 假云端，不会互相干扰。
 * 字体值从设置页真实 option 动态取（见 pickFontCandidates）。
 */

import {
  ARGS,
  backToDoc,
  check,
  fmt,
  newSession,
  openSettings,
  openWorkbench,
  section,
  shot,
  sleep,
} from './common.mjs';

/** 云端「旧」设置：模拟另一台设备/旧客户端推上去的旧字体 */
const STALE_CLOUD = {
  global: {
    appearance: {
      theme: 'system',
      themePresetId: 'daylight',
      accent: '#1677FF',
      fontFamily: 'SimHei, sans-serif',
      fontSize: 14,
      lineHeight: 1.2,
      pageWidth: 'full',
      showLineNumbers: false,
      spellcheck: false,
      editorColorScheme: 'white',
      customEditorBg: '#ffffff',
      customEditorFg: '#1f2329',
      zoom: 100,
      customThemes: [],
    },
  },
};

/**
 * 从设置页真实 option 列表里取 3 个字体值。
 *
 * 为什么不能硬编码：字体清单按平台动态生成（WEB_FONT_CANDIDATES /
 * DESKTOP_FONT_CANDIDATES），值里带引号与空格（如 `KaiTi, 'Kaiti SC', serif`）。
 * 首轮跑测就因为硬编码成不带引号的 `KaiTi, Kaiti SC, serif` 匹配不到任何 option，
 * value 变成空串 —— 那是**用例写错**，不是产品缺陷。
 */
async function pickFontCandidates(page) {
  await openSettings(page, '编辑器');
  const options = await page.evaluate(() => {
    const sel =
      document.querySelector('select[aria-label="正文字体"]') || document.querySelector('select[aria-label="正文字体族"]');
    if (!sel) return null;
    return Array.from(sel.options)
      .map((o) => ({ value: o.value, label: (o.textContent || '').trim() }))
      .filter((o) => o.value);
  });
  if (!options || !options.length) return null;
  // 排除「系统默认」这类等价于默认值的选项，避免「设了等于没设」测不出回滚
  const usable = options.filter((o) => o.value !== 'system-ui' && !/^system-ui,/.test(o.value));
  const pool = usable.length >= 3 ? usable : options;
  const picked = [];
  for (const p of pool) {
    if (picked.length >= 3) break;
    if (!picked.some((x) => x.value === p.value)) picked.push(p);
  }
  return { all: options, picked };
}

/** 归一化 font-family 字符串：浏览器会去引号、重排空格，直接比字符串会假失败 */
function normFont(s) {
  return String(s || '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function runOne(chromium, cand, idx) {
  const cloud = { payload: STALE_CLOUD, version: 3 };
  const { browser, page, jsErrors } = await newSession(chromium, {
    settingsMode: 'stale',
    stalePayload: STALE_CLOUD,
    cloud,
  });
  const label = cand.label || cand.value;
  try {
    await openWorkbench(page);
    const readState = () =>
      page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        return {
          domFont: pm ? getComputedStyle(pm).fontFamily : null,
          cssVar: getComputedStyle(document.documentElement).getPropertyValue('--font-content').trim(),
          setting: (() => {
            try {
              return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').appearance?.fontFamily ?? null;
            } catch {
              return null;
            }
          })(),
        };
      });

    const before = await readState();

    // 走真实 UI：设置 -> 编辑器 -> 正文字体下拉
    await openSettings(page, '编辑器');
    const uiSet = await page.evaluate((font) => {
      const sel =
        document.querySelector('select[data-testid="font-family"]') ||
        document.querySelector('select[aria-label="正文字体"]') ||
        document.querySelector('select[aria-label="正文字体族"]');
      if (!sel) return { ok: false, reason: '未找到正文字体下拉' };
      const has = Array.from(sel.options).some((o) => o.value === font);
      sel.value = font;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: has, has, value: sel.value };
    }, cand.value);
    await page.waitForTimeout(1200);

    /*
     * 1.4.0 需求16 引入了设置**草稿模式**：改动只进草稿，必须点保存才写 store。
     *
     * C 段的语义是「**已保存**的字体不被云端旧值自动恢复」，所以这里必须点保存。
     * 不点保存的话，第 2 步（断言 store/localStorage 已变）必然失败 ——
     * 那不是回归，而是 C 段还在按 1.3.1 的「即时生效」旧口径测。
     * 判据本身（保存后等 95s 不被恢复）没有任何放宽。
     */
    const saveClicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="settings-save"]');
      if (!btn) return { ok: false, reason: '未找到 settings-save（草稿模式保存按钮）' };
      if (btn.disabled) return { ok: false, reason: '保存按钮 disabled（草稿未被识别为有改动）', disabled: true };
      btn.click();
      return { ok: true };
    });
    await page.waitForTimeout(1400);
    await backToDoc(page, 1000);

    const afterSet = await readState();
    await shot(page, `C${idx}-after-set`);

    // 等满 95s，每 5s 派发一次 focus / visibilitychange（模拟用户切窗口回来）
    const deadline = Date.now() + ARGS.fontHoldMs;
    let pulses = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      pulses += 1;
      await page
        .evaluate(() => {
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new Event('visibilitychange'));
        })
        .catch(() => {});
    }
    await page.waitForTimeout(1500);

    const after = await readState();

    // 设置页 UI 是否仍显示该字体
    await openSettings(page, '编辑器');
    const uiValue = await page.evaluate(() => {
      const sel =
        document.querySelector('select[aria-label="正文字体"]') || document.querySelector('select[aria-label="正文字体族"]');
      return sel ? sel.value : null;
    });
    await shot(page, `C${idx}-after-hold`);

    const target = normFont(cand.value);
    const domOk = normFont(after.domFont) === target;
    const settingOk = normFont(after.setting) === target;
    const uiOk = normFont(uiValue) === target;

    check(
      `C${idx} 字体「${label}」设置后等待 ${Math.round(ARGS.fontHoldMs / 1000)}s 未被自动恢复（DOM 实际字体）`,
      `等待后 .ProseMirror computed font-family 仍为用户所选「${cand.value}」`,
      `设置前=${before.domFont} -> 设置后=${afterSet.domFont} -> 等待后=${after.domFont}（focus/visibilitychange 脉冲 ${pulses} 次，PUT 全部 409）`,
      domOk,
      {
        repro: `设置 -> 编辑器 -> 正文字体选「${label}」-> 等 ${Math.round(ARGS.fontHoldMs / 1000)}s 并切窗口 -> 读 computed font-family`,
        note: '云端恒为旧字体且推送恒失败，正是缺陷触发条件；修复后本地未推送改动必须被保护',
      },
    );
    check(
      `C${idx} 字体「${label}」设置项与 localStorage 仍为该字体`,
      'settings.appearance.fontFamily 与设置页下拉值都等于用户所选',
      `localStorage=${after.setting} / 下拉=${uiValue}`,
      settingOk && uiOk,
      { repro: '同上，再读 localStorage neomd.settings.v1 与 select[aria-label="正文字体"] 的 value' },
    );
    check(
      `C${idx} 字体「${label}」等待期间无 JS 运行时错误`,
      '0 条 pageerror',
      jsErrors.length ? jsErrors.slice(0, 3) : '0 条',
      jsErrors.length === 0,
    );

    if (!uiSet.ok) {
      check(`C${idx} 正文字体下拉可选到「${label}」`, 'select 含该 option', fmt(uiSet), false, {
        repro: '设置 -> 编辑器 -> 展开正文字体下拉',
      });
    }
  } finally {
    await browser.close();
  }
}

export async function sectionC(chromium) {
  section(
    'C',
    `PC 设置字体不被自动恢复（3 个字体值 x 等待 ${Math.round(ARGS.fontHoldMs / 1000)}s + focus/visibilitychange，并行）`,
  );

  // 先从真实页面上取 3 个可用字体值
  let candidates = null;
  {
    const probe = await newSession(chromium, {});
    try {
      await openWorkbench(probe.page);
      candidates = await pickFontCandidates(probe.page);
    } finally {
      await probe.browser.close();
    }
  }
  if (!candidates || candidates.picked.length < 3) {
    check('C0 设置页正文字体下拉存在 >=3 个可选字体', '>=3 个非默认字体 option', fmt(candidates), false, {
      repro: '设置 -> 编辑器 -> 展开正文字体下拉',
    });
    return;
  }
  console.log(`  将测试的 3 个字体值：${candidates.picked.map((c) => c.label || c.value).join(' / ')}`);
  await Promise.all(candidates.picked.map((c, i) => runOne(chromium, c, i + 1)));
}
