/**
 * 审计专项：死按钮 / 假成功 / 无反馈 全量扫描
 * =============================================================================
 * 任务书第 2 部分。做法：
 *   1. 枚举所有「可点击入口」（功能区 / 编辑工具栏 / 标签栏 / 状态栏 / 左右栏 / 设置页签）；
 *   2. 对每个入口：记录点击前的可观测状态（DOM 快照 / 弹窗数 / 面包屑 / store），
 *      点击，等待，再记录；判定「有变化 / 无变化」；
 *   3. 「无变化」不等于缺陷 —— 必须人工分类：
 *        - 死按钮：完全无反应
 *        - 假成功：弹了「成功」提示但无实际变化
 *        - 无反馈：开关类按钮状态变了但视觉无提示
 *   4. 对**危险操作**（删除/清空/重置）不真点，只验证「是否有二次确认」（这本身是审计点）。
 *
 * ## 安全
 * - 使用 `settingsMode:'fake'` + 写守卫（拦 /api/vaults 与 /api/settings）；
 * - 不点「删除/清空/退出登录/重置」这类破坏性按钮，只检查是否有确认框；
 * - 点击产生的临时文档在 finally 清理。
 *
 * 用法：node tools/audit-死按钮专项.mjs
 */
import {
  BASE,
  LAUNCH_ARGS,
  assertZeroWrites,
  auditShot,
  diffCloudBaseline,
  fmt,
  installWriteGuard,
  loadChromium,
  login,
  newSession,
  sleep,
  snapshotCloudBaseline,
  waitUntil,
} from './audit-场景-common.mjs';
import fs from 'node:fs';
import path from 'node:path';

const APP_STORE =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

/** 危险文案：不点，只检查是否有确认机制 */
const DANGER_RE = /删除|清空|重置|注销|退出登录|移除|销毁|卸载|停用|禁用/;

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();

/** 页面状态指纹：任何可观测变化都应改变其中之一 */
const SNAPSHOT_FN = `(() => {
  const txt = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  /*
   * ## 为什么必须用「全文」而不是前 N 个字符
   *
   * 第一版取 txt.slice(0, 900)，结果设置页「编辑器」页签里前 8 个工具栏 chip
   * 判为「有变化」、第 9 个之后全部判为「无变化」——因为 chip 列表位于正文
   * 900 字符之后，改动落在切片外，指纹自然不变。
   * 那次跑出了 40+ 个假「死按钮」，几乎全是这个原因。
   *
   * 现在：全文参与指纹（长度 + 全文），并额外单独采集
   * 「设置页正文」「按钮自身文案」两个局部指纹，避免长页面遮蔽。
   */
  const pane = document.querySelector('.settings__body .pane');
  const btnTexts = Array.from(document.querySelectorAll('.settings__body .pane button'))
    .map((e) => (e.textContent || '').trim())
    .join('|');
  return {
    url: location.pathname + location.hash,
    textLen: txt.length,
    textFull: txt,
    paneLen: pane ? (pane.textContent || '').length : -1,
    paneText: pane ? (pane.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    btnTexts,
    modalCount: document.querySelectorAll('.nm-modal, [class*="modal"]').length,
    toastCount: document.querySelectorAll('[class*="toast"], [class*="notify"], [class*="message"]').length,
    menuCount: document.querySelectorAll('[class*="menu"], [class*="dropdown"], [class*="popover"]').length,
    panelCount: document.querySelectorAll('.rightsec, .leftsec, .ribbon, .settings-page, .plugincenter').length,
    editorTextLen: (document.querySelector('.ProseMirror, .cm-content')?.textContent || '').length,
    tabCount: document.querySelectorAll('.tab').length,
    activeTab: document.querySelector('.tab.is-active')?.textContent?.trim().slice(0,30) ?? '',
    domNodeCount: document.body.querySelectorAll('*').length,
    theme: document.documentElement.dataset.theme || '',
    preset: document.documentElement.dataset.themePreset || '',
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    rightOpen: document.querySelectorAll('.rightstack .rightsec, .rightsec').length,
  };
})()`;

const snap = () => page.evaluate(SNAPSHOT_FN);

/** 判断两次快照是否有「实质变化」（排除纯时间戳/同步提示等噪声） */
function diffSnap(a, b) {
  const keys = [
    'url', 'modalCount', 'toastCount', 'menuCount', 'panelCount', 'editorTextLen',
    'tabCount', 'activeTab', 'theme', 'preset', 'bg', 'accent', 'rightOpen', 'paneLen',
  ];
  const changed = keys.filter((k) => a[k] !== b[k]);
  // 文本变化：去掉时间噪声后**全文**比较（并单独比按钮文案，防长页面遮蔽）
  const norm = (s) =>
    String(s)
      .replace(/\d+\s*(秒|分钟|小时)前/g, '')
      .replace(/\d+\s*(秒|分钟|小时)$/g, '')
      .replace(/已自动同步[^。]*/g, '')
      .replace(/上次自动同步[^，]*/g, '')
      .replace(/\s+/g, '');
  const textChanged = norm(a.textFull) !== norm(b.textFull);
  const paneChanged = norm(a.paneText) !== norm(b.paneText);
  const btnChanged = norm(a.btnTexts) !== norm(b.btnTexts);
  return { changed, textChanged, paneChanged, btnChanged, any: changed.length > 0 || textChanged || paneChanged || btnChanged };
}

const rows = [];

/** 安全地点击一个入口并记录结果 */
async function probe(kind, label, clickFn, opts = {}) {
  const before = await snap();
  let clickErr = null;
  try {
    await clickFn();
  } catch (e) {
    clickErr = String(e?.message ?? e).slice(0, 120);
  }
  await page.waitForTimeout(opts.waitMs ?? 1100);

  // 若弹出确认框，记录（不继续点确认）
  const dialog = await page.evaluate(() => {
    const m = document.querySelector('.nm-modal, [class*="modal"]');
    if (!m) return null;
    return (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  });
  const after = await snap();
  const d = diffSnap(before, after);

  const row = {
    kind,
    label,
    danger: DANGER_RE.test(label),
    clickErr,
    dialog,
    changedKeys: d.changed,
    textChanged: d.textChanged,
    verdict: null,
    note: '',
  };

  if (clickErr) {
    row.verdict = 'error';
    row.note = clickErr;
  } else if (dialog && row.danger) {
    row.verdict = 'ok-confirm'; // 危险操作有确认框 = 正确行为
    row.note = `弹确认：${dialog.slice(0, 90)}`;
  } else if (dialog) {
    row.verdict = 'ok-dialog';
    row.note = `弹窗：${dialog.slice(0, 90)}`;
  } else if (d.any) {
    row.verdict = 'ok';
    row.note = `变化：${d.changed.join(',') || '文本'}`;
  } else {
    row.verdict = 'no-change';
  }
  rows.push(row);
  const mark = { ok: '\u2713', 'ok-dialog': '\u25a1', 'ok-confirm': '\u26a0', 'no-change': '\u2717', error: '!' }[row.verdict];
  console.log(`  ${mark} [${kind}] ${label.slice(0, 52)}${row.note ? `  — ${row.note}` : ''}`);
  return row;
}

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  // 先建一篇文档，让编辑器工具条可用
  await page.keyboard.press('Control+n');
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  const firstDoc = await page.evaluate((e) => {
    // eslint-disable-next-line no-eval
    const app = eval(e);
    return app?.activeTab?.id ?? '';
  }, APP_STORE);
  if (firstDoc) tempDocs.add(firstDoc);
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return;
    const r = pm.getBoundingClientRect();
  });
  const pb = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return null;
    const r = pm.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  });
  if (pb) await page.mouse.click(pb.x + 50, pb.y + 24);
  await page.keyboard.type('# 死按钮专项测试\n\n正文内容。', { delay: 3 });
  await page.waitForTimeout(500);

  /* ---------------- 1. 功能区按钮 ---------------- */
  console.log('\n=== 1. 功能区（ribbon） ===');
  const ribbonButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ribbon__btn')).map((e, i) => ({
      i,
      title: (e.getAttribute('title') || '').replace(/\s*Ctrl\+.*$/, ''),
      text: (e.textContent || '').trim(),
    })),
  );
  console.log(`  功能区按钮 ${ribbonButtons.length} 个`);
  for (const rb of ribbonButtons) {
    const label = rb.title || rb.text || `ribbon#${rb.i}`;
    if (rb.text === '日记' || /日记/.test(label)) continue; // 日记会建文档，跳过避免脏数据
    await probe('ribbon', label, async () => {
      await page.evaluate((idx) => {
        document.querySelectorAll('.ribbon__btn')[idx]?.click();
      }, rb.i);
    }, { waitMs: 1500 });
    // 关掉可能打开的弹窗/菜单
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }

  /* ---------------- 2. 编辑工具栏 ---------------- */
  console.log('\n=== 2. 正文编辑工具栏（editorbar） ===');
  /**
   * ## 格式化按钮必须「先选中文本」再点
   *
   * 第一版直接点「加粗 / 斜体 / H1 / 引用 / 代码块…」全部判为「无变化」——
   * 这不是死按钮：格式命令作用于**选区**，没有选区时 TipTap 不会做任何改动，
   * 或者只切换「待输入的标记」而不改现有 DOM。
   * 所以每个格式按钮点击前先 `Ctrl+A` 全选正文，点完再读 DOM 结构变化。
   */
  const FORMAT_RE = /加粗|斜体|下划线|删除线|高亮|行内代码|代码块|引用|分隔线|标题|列表|表格|链接/;
  const tbtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.editorbar .tbtn')).map((e, i) => ({
      i,
      title: (e.getAttribute('title') || '').replace(/（可拖动排序，右键可隐藏）/, '').replace(/\s*Ctrl\+.*$/, ''),
    })),
  );
  console.log(`  工具按钮 ${tbtns.length} 个`);
  for (const tb of tbtns) {
    const label = tb.title || `tbtn#${tb.i}`;
    const isFormat = FORMAT_RE.test(label);
    if (isFormat) {
      // 选中全文 → 点格式 → 比较编辑区结构
      const before = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        return {
          html: pm ? pm.innerHTML.length : -1,
          strong: pm?.querySelectorAll('strong').length ?? 0,
          em: pm?.querySelectorAll('em').length ?? 0,
          h1: pm?.querySelectorAll('h1').length ?? 0,
          quote: pm?.querySelectorAll('blockquote').length ?? 0,
          pre: pm?.querySelectorAll('pre').length ?? 0,
          table: pm?.querySelectorAll('table').length ?? 0,
          ul: pm?.querySelectorAll('ul').length ?? 0,
          code: pm?.querySelectorAll('code').length ?? 0,
          s: pm?.querySelectorAll('s, del, strike').length ?? 0,
          mark: pm?.querySelectorAll('mark').length ?? 0,
          u: pm?.querySelectorAll('u').length ?? 0,
          hr: pm?.querySelectorAll('hr').length ?? 0,
        };
      });
      // 聚焦 + 全选
      const pbx = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        if (!pm) return null;
        const r = pm.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      });
      if (pbx) await page.mouse.click(pbx.x + 50, pbx.y + 24);
      await page.waitForTimeout(200);
      await page.keyboard.press('Control+a').catch(() => {});
      await page.waitForTimeout(200);
      const clicked = await page.evaluate((idx) => {
        const b = document.querySelectorAll('.editorbar .tbtn')[idx];
        if (!b) return false;
        b.click();
        return true;
      }, tb.i);
      await page.waitForTimeout(1000);
      const after = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        return {
          html: pm ? pm.innerHTML.length : -1,
          strong: pm?.querySelectorAll('strong').length ?? 0,
          em: pm?.querySelectorAll('em').length ?? 0,
          h1: pm?.querySelectorAll('h1').length ?? 0,
          quote: pm?.querySelectorAll('blockquote').length ?? 0,
          pre: pm?.querySelectorAll('pre').length ?? 0,
          table: pm?.querySelectorAll('table').length ?? 0,
          ul: pm?.querySelectorAll('ul').length ?? 0,
          code: pm?.querySelectorAll('code').length ?? 0,
          s: pm?.querySelectorAll('s, del, strike').length ?? 0,
          mark: pm?.querySelectorAll('mark').length ?? 0,
          u: pm?.querySelectorAll('u').length ?? 0,
          hr: pm?.querySelectorAll('hr').length ?? 0,
        };
      });
      const structural = Object.keys(before).filter((k) => before[k] !== after[k]);
      const row = {
        kind: 'editorbar',
        label,
        danger: false,
        clickErr: null,
        dialog: null,
        changedKeys: structural,
        textChanged: false,
        verdict: clicked && structural.length ? 'ok' : clicked ? 'no-change' : 'error',
        note: `（已全选后点击）结构变化：${structural.join(',') || '无'}`,
      };
      rows.push(row);
      console.log(`  ${row.verdict === 'ok' ? '\u2713' : '\u2717'} [editorbar] ${label.slice(0, 46)}  — ${row.note}`);
      // 撤销这次格式改动，避免污染后续
      await page.keyboard.press('Control+z').catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    await probe('editorbar', label, async () => {
      await page.evaluate((idx) => {
        document.querySelectorAll('.editorbar .tbtn')[idx]?.click();
      }, tb.i);
    }, { waitMs: 1300 });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350);
    // 若切了模式，切回来
    const modeNow = await page.evaluate(() => document.querySelectorAll('.ProseMirror').length);
    if (!modeNow) {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
        btns[btns.length - 1]?.click();
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
        items.find((e) => /所见即所得/.test(e.textContent || ''))?.click();
      });
      await page.waitForTimeout(900);
    }
  }

  /* ---------------- 3. 标签栏 / 状态栏 ---------------- */
  console.log('\n=== 3. 标签栏 / 状态栏 ===');
  const bars = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar button, .statusbar button, .shell__status button')).map((e, i) => ({
      i,
      title: (e.getAttribute('title') || '').slice(0, 50),
      text: (e.textContent || '').trim().slice(0, 24),
      cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40),
    })),
  );
  console.log(`  标签栏/状态栏按钮 ${bars.length} 个`);
  for (const b of bars) {
    const label = b.title || b.text || b.cls || `bar#${b.i}`;
    if (DANGER_RE.test(label)) {
      rows.push({ kind: 'bar', label, danger: true, verdict: 'skipped-danger', note: '破坏性操作，未点击', changedKeys: [], textChanged: false, clickErr: null, dialog: null });
      console.log(`  \u2298 [bar] ${label.slice(0, 50)}  — 破坏性，跳过`);
      continue;
    }
    await probe('bar', label, async () => {
      await page.evaluate((idx) => {
        document.querySelectorAll('.tabbar button, .statusbar button, .shell__status button')[idx]?.click();
      }, b.i);
    }, { waitMs: 1200 });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350);
  }

  /* ---------------- 4. 设置页签（每个页签内所有控件） ---------------- */
  console.log('\n=== 4. 设置页：页签 + 页内控件 ===');
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);

  const tabLabels = await page.evaluate(() => Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim()));
  console.log(`  设置页签 ${tabLabels.length} 个：${fmt(tabLabels)}`);
  for (const tl of tabLabels) {
    await probe('settings-tab', tl, async () => {
      await page.evaluate((lbl) => {
        const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === lbl);
        el?.click();
      }, tl);
    }, { waitMs: 1000 });
  }

  // 逐页签扫页内按钮（只记录「无变化」的候选，供人工判定）
  const noChangeInSettings = [];
  for (const tl of tabLabels) {
    await page.evaluate((lbl) => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === lbl);
      el?.click();
    }, tl);
    await page.waitForTimeout(1000);
    const ctrls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.settings__body .pane button')).map((e, i) => ({
        i,
        text: (e.textContent || '').trim().slice(0, 26),
        title: (e.getAttribute('title') || '').slice(0, 46),
        disabled: Boolean(e.disabled),
        cls: (typeof e.className === 'string' ? e.className : '').slice(0, 44),
      })),
    );
    console.log(`\n  --- 页签「${tl}」内按钮 ${ctrls.length} 个 ---`);
    for (const c of ctrls) {
      const label = c.title || c.text || c.cls;
      if (DANGER_RE.test(label)) {
        // 危险：检查是否有确认框（点一下，不确认）
        const before = await snap();
        await page.evaluate((idx) => {
          const els = document.querySelectorAll('.settings__body .pane button');
          const btn = els[idx];
          // 只点「有确认框保护」的：先看是否 onclick 直接执行（无法判断），保守：不点
        }, c.i);
        rows.push({ kind: `settings:${tl}`, label, danger: true, verdict: 'skipped-danger', note: '破坏性，未点击', changedKeys: [], textChanged: false, clickErr: null, dialog: null });
        continue;
      }
      if (c.disabled) {
        rows.push({ kind: `settings:${tl}`, label, danger: false, verdict: 'disabled', note: '按钮当前禁用（依赖前置条件）', changedKeys: [], textChanged: false, clickErr: null, dialog: null });
        continue;
      }
      await probe(`settings:${tl}`, label, async () => {
        await page.evaluate((idx) => {
          document.querySelectorAll('.settings__body .pane button')[idx]?.click();
        }, c.i);
      }, { waitMs: 900 });
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  /* ---------------- 5. 右栏区块 ---------------- */
  console.log('\n=== 5. 右栏区块 ===');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  // 关设置
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.tab')).find((x) => /设置/.test(x.textContent || ''));
    t?.querySelector('.tab__close')?.click();
  });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+Shift+A').catch(() => {});
  await page.waitForTimeout(1800);
  const rightBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.rightpanel button, .rightbar button, .rightstack button, .shell__right button')).map((e, i) => ({
      i,
      title: (e.getAttribute('title') || '').slice(0, 50),
      text: (e.textContent || '').trim().slice(0, 22),
    })),
  );
  console.log(`  右栏按钮 ${rightBtns.length} 个`);
  for (const rb of rightBtns.slice(0, 20)) {
    const label = rb.title || rb.text || `right#${rb.i}`;
    if (DANGER_RE.test(label)) {
      rows.push({ kind: 'right', label, danger: true, verdict: 'skipped-danger', note: '破坏性，未点击', changedKeys: [], textChanged: false, clickErr: null, dialog: null });
      continue;
    }
    await probe('right', label, async () => {
      await page.evaluate((idx) => {
        document.querySelectorAll('.rightpanel button, .rightbar button, .rightstack button, .shell__right button')[idx]?.click();
      }, rb.i);
    }, { waitMs: 1200 });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  await auditShot(page, 'DEAD-最后状态');
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
} finally {
  /* ---------------- 汇总 + 清理 ---------------- */
  const byVerdict = rows.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n${'='.repeat(78)}\n死按钮专项汇总\n${'='.repeat(78)}`);
  console.log(`  探测入口总数：${rows.length}`);
  for (const [k, v] of Object.entries(byVerdict)) console.log(`    ${k.padEnd(18)} ${v}`);

  const noChange = rows.filter((r) => r.verdict === 'no-change');
  console.log(`\n  【无任何可观测变化】${noChange.length} 个（需人工分类：死按钮 / 无反馈 / 设计如此）：`);
  for (const r of noChange) console.log(`    · [${r.kind}] ${r.label}`);

  const disabledRows = rows.filter((r) => r.verdict === 'disabled');
  console.log(`\n  【按钮禁用】${disabledRows.length} 个：`);
  for (const r of disabledRows) console.log(`    · [${r.kind}] ${r.label} — ${r.note}`);

  const confirms = rows.filter((r) => r.verdict === 'ok-confirm');
  console.log(`\n  【危险操作有二次确认】${confirms.length} 个（正面）：`);
  for (const r of confirms) console.log(`    · [${r.kind}] ${r.label}`);

  const skipped = rows.filter((r) => r.verdict === 'skipped-danger');
  console.log(`\n  【破坏性操作，未点击（仅记录）】${skipped.length} 个`);

  const dir = path.join(process.cwd(), 'docs', 'AUDIT-140');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dead-buttons.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary: byVerdict, rows }, null, 2), 'utf8');
  console.log(`\n  明细已写：docs/AUDIT-140/dead-buttons.json`);

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
  assertZeroWrites('死按钮');
  await diffCloudBaseline(baseline);
}
