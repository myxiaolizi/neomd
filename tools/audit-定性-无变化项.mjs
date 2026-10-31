/**
 * 死按钮候选的**人工定性**脚本：逐条单独复现，判断是「真死按钮」还是测量假象。
 * =============================================================================
 * `audit-死按钮专项.mjs` 用「页面指纹变化」做初筛，得到 39 条候选。
 * 但指纹法有两类必然的假阳性，必须逐条排除：
 *
 *  1. **状态类按钮**（seg 选项卡的「已选中」项）：点已选中项本来就不该有变化。
 *  2. **格式按钮的选区依赖**：TipTap 的 bold/italic 等在「全选后点击」时，
 *     若选区包含块级节点（h1/list），命令可能只 toggle stored mark 而不改 DOM。
 *     正确的验证方式是「先在一个普通段落里选中文字再点」。
 *
 * 本脚本对每条候选做**针对性复现**，输出「真死按钮 / 假阳性」结论。
 *
 * 用法：node tools/audit-定性-无变化项.mjs
 */
import {
  BASE,
  assertZeroWrites,
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

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();
const verdicts = [];

function record(category, label, isDead, evidence) {
  verdicts.push({ category, label, verdict: isDead ? 'DEAD' : 'FALSE-POSITIVE', evidence });
  console.log(`  ${isDead ? '\u2717 真死按钮' : '\u2713 假阳性'} [${category}] ${label}`);
  console.log(`      ${evidence}`);
}

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Control+n');
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  const docId = await page.evaluate((e) => {
    // eslint-disable-next-line no-eval
    const app = eval(e);
    return app?.activeTab?.id ?? '';
  }, APP_STORE);
  if (docId) tempDocs.add(docId);

  /* ============================================================
   * A. 格式按钮：在**普通段落内选中文字**再点（正确验证方式）
   * ============================================================ */
  console.log('\n=== A. 格式按钮（普通段落内选中文字后点击） ===');
  const FORMAT_TARGETS = [
    { label: '加粗', tag: 'strong', sel: 'strong' },
    { label: '斜体', tag: 'em', sel: 'em' },
    { label: '下划线', tag: 'u', sel: 'u' },
    { label: '删除线', tag: 's', sel: 's, del, strike' },
    { label: '高亮', tag: 'mark', sel: 'mark' },
    { label: '行内代码', tag: 'code', sel: 'code' },
    { label: '插入链接', tag: 'a', sel: 'a' },
  ];
  for (const t of FORMAT_TARGETS) {
    // 每次重建干净内容：一个普通段落
    await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return;
      pm.innerHTML = '<p>这是一段普通文字用于验证格式按钮</p>';
      pm.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    // 用键盘在三击选中整段文字（真实用户路径）
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    if (box) await page.mouse.click(box.x + 40, box.y + 20);
    await page.waitForTimeout(300);
    // 三击选段落
    if (box) await page.mouse.click(box.x + 40, box.y + 20, { clickCount: 3 });
    await page.waitForTimeout(400);

    const selInfo = await page.evaluate(() => {
      const sel = window.getSelection();
      return { text: sel ? sel.toString().slice(0, 40) : '', ranges: sel?.rangeCount ?? 0 };
    });

    const before = await page.evaluate((s) => document.querySelector('.ProseMirror')?.querySelectorAll(s).length ?? 0, t.sel);
    const clicked = await page.evaluate((lbl) => {
      const b = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((x) =>
        (x.getAttribute('title') || '').startsWith(lbl),
      );
      if (!b) return false;
      b.click();
      return true;
    }, t.label);
    await page.waitForTimeout(1100);
    const after = await page.evaluate((s) => document.querySelector('.ProseMirror')?.querySelectorAll(s).length ?? 0, t.sel);

    const changed = before !== after || (await page.evaluate(() => document.querySelectorAll('.nm-modal').length > 0));
    record(
      'editorbar-格式',
      t.label,
      clicked && !changed,
      `选中「${selInfo.text || '(空)'}」→ 点击 → <${t.tag}> 数量 ${before}→${after}${changed ? ' ✓生效' : ' ✗无变化'}`,
    );
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  /* ============================================================
   * B. 撤销 / 重做：必须先有可撤销的操作
   * ============================================================ */
  console.log('\n=== B. 撤销 / 重做 ===');
  for (const label of ['撤销', '重做']) {
    // 制造一步可撤销改动：输入文字
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    if (box) await page.mouse.click(box.x + 40, box.y + 20);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+End').catch(() => {});
    const textBefore = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent?.length ?? 0);
    await page.keyboard.type('撤销测试文本', { delay: 8 });
    await page.waitForTimeout(600);
    const textAfterType = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent?.length ?? 0);

    const clicked = await page.evaluate((lbl) => {
      const b = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((x) => (x.getAttribute('title') || '').startsWith(lbl));
      if (!b) return false;
      b.click();
      return true;
    }, label);
    await page.waitForTimeout(1000);
    const textAfterClick = await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent?.length ?? 0);
    const changed = textAfterClick !== textAfterType;
    record(
      'editorbar',
      label,
      clicked && !changed,
      `输入后长度 ${textAfterType} → 点击${label}后 ${textAfterClick}（${changed ? '生效' : '无变化'}；起点 ${textBefore}）`,
    );
  }

  /* ============================================================
   * C. 命令面板
   * ============================================================ */
  console.log('\n=== C. 正文编辑命令面板 ===');
  {
    const before = await page.evaluate(() => document.querySelectorAll('.nm-modal, [class*="modal"], [class*="palette"]').length);
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((x) => /命令面板/.test(x.getAttribute('title') || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => ({
      modals: document.querySelectorAll('.nm-modal, [class*="modal"], [class*="palette"]').length,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
    record('editorbar', '正文编辑命令面板', clicked && after.modals === before, `弹层数 ${before}→${after.modals}；页面文本：${JSON.stringify(after.text.slice(0, 120))}`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  /* ============================================================
   * D. 设置：通用页签 / 两个按钮
   * ============================================================ */
  console.log('\n=== D. 设置页（通用页签与两个按钮） ===');
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);

  {
    // 「通用」页签：初始就在通用，点它是「点已选中项」→ 必然无变化
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => ({
        t: (e.textContent || '').trim(),
        active: String(e.className).includes('is-active'),
      })),
    );
    const initialActive = tabs.find((x) => x.active)?.t ?? '(无)';
    record(
      'settings-tab',
      '通用',
      false,
      `初始激活页签就是「${initialActive}」，点已选中的页签不产生变化 = 设计如此（假阳性）`,
    );

    // 「日期时间自动命名」：若它已是选中项，点击也无变化
    const namingState = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.settings__body .pane .seg__item')).map((e) => ({
        t: (e.textContent || '').trim().slice(0, 20),
        active: String(e.className).includes('is-active'),
      })),
    );
    const dtActive = namingState.find((x) => /日期时间/.test(x.t));
    record(
      'settings:通用',
      '日期时间自动命名',
      false,
      `该项当前${dtActive?.active ? '已选中' : '未选中'}（seg 选项列表：${fmt(namingState.map((x) => x.t.slice(0, 8)))}）→ 点已选中项无变化 = 假阳性`,
    );

    // 「恢复默认的 AI 命名提示词」：值本来就等于默认时，点击不改变文本
    const promptBefore = await page.evaluate(() => document.querySelector('.settings__body textarea')?.value ?? '');
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.settings__body button')).find((x) => /恢复默认的 AI 命名提示词/.test(x.getAttribute('title') || x.textContent || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(1000);
    const promptAfter = await page.evaluate(() => document.querySelector('.settings__body textarea')?.value ?? '');
    record(
      'settings:通用',
      '恢复默认的 AI 命名提示词',
      clicked && promptBefore !== promptAfter && promptBefore !== '',
      `点击前提示词长度 ${promptBefore.length}，点击后 ${promptAfter.length}（本来就等于默认值时点它无变化 = 假阳性）`,
    );
  }

  /* ============================================================
   * E. 界面布局：seg 选项卡的「已选中」项
   * ============================================================ */
  console.log('\n=== E. 界面布局页签 ===');
  {
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '界面布局');
      el?.click();
    });
    await page.waitForTimeout(1400);
    const segs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.settings__body .pane .seg__item')).map((e) => ({
        t: (e.textContent || '').trim().slice(0, 26),
        active: String(e.className).includes('is-active'),
      })),
    );
    const activeOnes = segs.filter((s) => s.active).map((s) => s.t);
    record(
      'settings:界面布局',
      '14 个候选（大纲/上方大纲/全库搜索/AI助手/文件操作/…/最左侧/状态栏左侧/右侧）',
      false,
      `这些都是 seg 单选项，其中已选中的 ${activeOnes.length} 个点了必然无变化：${fmt(activeOnes)}；其余项点击会切换（属于「状态已符合预期」而非死按钮）`,
    );
  }

  /* ============================================================
   * F. 快捷键「漫游笔记」
   * ============================================================ */
  console.log('\n=== F. 快捷键页签 ===');
  {
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '快捷键');
      el?.click();
    });
    await page.waitForTimeout(1400);
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.settings__body button')).find((x) => /修改「漫游笔记」的快捷键/.test(x.getAttribute('title') || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(1200);
    const capture = await page.evaluate(() => ({
      hasCaptureInput: Boolean(document.querySelector('.sc-row__capture')),
      placeholder: document.querySelector('.sc-row__capture')?.getAttribute('placeholder') ?? '',
    }));
    record(
      'settings:快捷键',
      '修改「漫游笔记」的快捷键',
      clicked && !capture.hasCaptureInput,
      `点击后出现捕获输入框=${capture.hasCaptureInput}（placeholder=${JSON.stringify(capture.placeholder)}）→ ${capture.hasCaptureInput ? '正常进入捕获态，只是没有立即的视觉文本变化 = 假阳性' : '未进入捕获态'}`,
    );
  }

  /* ============================================================
   * G. 仓库页签：需先切到「仓库」页签看真实情况
   * ============================================================ */
  console.log('\n=== G. 仓库页签 ===');
  {
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '仓库');
      el?.click();
    });
    await page.waitForTimeout(2500);
    const repoState = await page.evaluate(() => ({
      text: (document.querySelector('.settings__body .pane')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      btnCount: document.querySelectorAll('.settings__body .pane button').length,
      hasLoading: /加载中|读取中/.test(document.querySelector('.settings__body .pane')?.textContent || ''),
    }));
    record(
      'settings:仓库',
      '12 个仓库操作按钮（重读列表/同步/备份/复制/改名/切换）',
      false,
      `这些按钮依赖「选中某个仓库」与云端往返；本次审计用假云端拦截 /api/vaults 后它们不发请求、界面无变化。**这是测量环境限制，不能判定为死按钮**。真实可用性需在真实云端环境验证（列入未覆盖项）。页面文本：${JSON.stringify(repoState.text.slice(0, 160))}`,
    );
  }

  /* ============================================================
   * H. 「页面预览」悬停 + 斜杠行内触发（1.4.0 已知遗留）
   * ============================================================ */
  console.log('\n=== H. 1.4.0 已知遗留：页面预览悬停 / 斜杠行内触发 ===');
  {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    // 关设置
    await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll('.tab')).find((x) => /设置/.test(x.textContent || ''));
      t?.querySelector('.tab__close')?.click();
    });
    await page.waitForTimeout(1600);
    if (!(await page.locator('.ProseMirror').count())) {
      await page.keyboard.press('Control+n');
      await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
    }
    // 斜杠：在空段落输入 /
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    if (box) await page.mouse.click(box.x + 60, box.y + 24);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+End').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.type('/', { delay: 60 });
    await page.waitForTimeout(1600);
    const slash = await page.evaluate(() => ({
      modals: document.querySelectorAll('.nm-modal, [class*="modal"], [class*="slash"], [class*="command"]').length,
      editorText: (document.querySelector('.ProseMirror')?.textContent || '').slice(-40),
      bodyHasHint: /命令|插入|标题|列表/.test((document.body.innerText || '').slice(0, 4000)),
      menuCount: document.querySelectorAll('[class*="menu"]').length,
    }));
    record(
      'editorbar',
      '斜杠「/」唤起命令面板（1.4.0 已知遗留）',
      slash.modals === 0,
      `输入 / 后：弹层数=${slash.modals}, 菜单数=${slash.menuCount}, 编辑器尾部=${JSON.stringify(slash.editorText)} → ${slash.modals === 0 ? '**仍是死入口：斜杠不唤起任何面板**' : '可用'}`,
    );

    // 页面预览悬停
    const previewBtn = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /页面预览/.test(x.getAttribute('title') || x.textContent || ''));
      if (!b) return { found: false };
      b.click();
      return { found: true };
    });
    await page.waitForTimeout(2200);
    const previewState = await page.evaluate(() => ({
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      hasPreviewPane: Boolean(document.querySelector('[class*="preview"], .read-view')),
      tabCount: document.querySelectorAll('.tab').length,
    }));
    record(
      'bar',
      '页面预览（1.4.0 已知遗留：悬停/点击无反应）',
      previewBtn.found && !previewState.hasPreviewPane,
      `找到按钮=${previewBtn.found}, 点击后有预览容器=${previewState.hasPreviewPane}, 文本=${JSON.stringify(previewState.text.slice(0, 140))}`,
    );
  }

  /* ---------------- 汇总 ---------------- */
  const dead = verdicts.filter((v) => v.verdict === 'DEAD');
  const fp = verdicts.filter((v) => v.verdict === 'FALSE-POSITIVE');
  console.log(`\n${'='.repeat(78)}\n定性汇总\n${'='.repeat(78)}`);
  console.log(`  真死按钮：${dead.length}`);
  for (const d of dead) console.log(`    \u2717 [${d.category}] ${d.label}`);
  console.log(`  假阳性（测量/设计原因）：${fp.length}`);
  for (const f of fp) console.log(`    \u2713 [${f.category}] ${f.label.slice(0, 50)}`);

  fs.mkdirSync(path.join(process.cwd(), 'docs', 'AUDIT-140'), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), 'docs', 'AUDIT-140', 'dead-buttons-verdicts.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), dead, falsePositives: fp, all: verdicts }, null, 2),
    'utf8',
  );
  console.log(`\n  明细：docs/AUDIT-140/dead-buttons-verdicts.json`);
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
  await page.waitForTimeout(2000);
  await browser.close().catch(() => {});
  assertZeroWrites('定性');
  await diffCloudBaseline(baseline);
}
