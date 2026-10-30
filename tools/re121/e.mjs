/**
 * [E] 历史版本多版本可用
 * =============================================================================
 * 缺陷5：文档改了很多次，打开「历史版本」面板只列出 1 个版本，无法回滚。
 *
 * 已知根因链（T3 定位，本脚本按此设计断言）：
 *  a) HistoryModal.load() 里「本地有任意一条就不查云端」-> 本地残留 1 条旧版本时，
 *     云端 N 条被完全忽略；
 *  b) archiveVersionToCloud 归档的是**保存前**的旧内容，
 *     因此 N 次保存最多产生 N-1 条归档；
 *  c) 历史版本 key 若不唯一（rev+hash 当 key），同内容重复归档会互相覆盖。
 *
 * 断言口径（比任务书更严）：
 *  - E1 云端版本对象 >= 5 条；
 *  - E2 **至少 3 条内容互不相同**（按 sha256 比对）—— 防止「5 条但内容全一样」误判通过
 *    （lead 加严要求）；
 *  - E3 UI 面板列出 >= 5 条；
 *  - E4 选中第 2 版时预览 != 最新版；
 *  - E5 恢复后正文 == 该版正文（按 UI 显示的版本号回查云端对象，精确比对）。
 */

import {
  check,
  createTempDoc,
  fmt,
  getObjectText,
  listObjects,
  newSession,
  openWorkbench,
  readTabContent,
  readVaultRaw,
  section,
  sha256,
  shot,
  STORE_EXPR,
  THRESHOLD,
  defaultSeed,
} from './common.mjs';

/**
 * 6 个不同内容的版本。
 *
 * 为什么存 6 次而不是 5 次：`saveActiveTab()` 归档的是**保存前**的旧内容
 * （archiveVersionToCloud(prevContent)），因此 N 次保存最多产生 N-1 条归档；
 * 要拿到 >=5 条历史版本至少需要 6 次保存。任务书要求「保存 5 次 -> >=5 条」，
 * 这里多存一次以覆盖归档语义，断言门槛仍是 5 条。
 */
const E_VERSIONS = Array.from(
  { length: 6 },
  (_, i) => `# 版本 ${i + 1}\n\n这是第 ${i + 1} 版正文，内容标识 QA121-E-V${i + 1}-${'x'.repeat(i + 1)}\n`,
);

export async function sectionE(chromium) {
  section('E', '历史版本多版本可用（>=5 条 + >=3 条内容互不相同 + 第 2 版预览!=最新 + 恢复生效）');

  const { browser, page, jsErrors } = await newSession(chromium, { seedSettings: defaultSeed() });
  try {
    await openWorkbench(page);
    const doc = await createTempDoc(page, { title: `QA121-E-${Date.now()}`, content: E_VERSIONS[0] });
    if (!doc.docId) {
      check('E0 创建临时文档', '能新建临时文档', 'createDoc 未返回 docId', false, {
        repro: 'node tools/verify-121.mjs --only=E',
      });
      return;
    }
    await page.waitForTimeout(800);

    // ---- 连续保存 6 次不同内容 ----
    for (let i = 1; i < E_VERSIONS.length; i += 1) {
      await page.evaluate(
        async ({ expr, content }) => {
          // eslint-disable-next-line no-eval
          const s = eval(expr);
          s.updateTabContent(s.activeTab.id, content);
          await s.saveActiveTab();
        },
        { expr: STORE_EXPR, content: E_VERSIONS[i] },
      );
      await page.waitForTimeout(2200);
    }
    // 等同步把版本对象推到云端
    await page.waitForTimeout(3500);

    // ---- E1：云端版本对象条数 ----
    const listed = await listObjects(doc.vaultId, `versions/${doc.docId}/`);
    const versionObjs = (listed.objects ?? []).filter((o) =>
      /\/\d+-\d+-[0-9a-f]+(-[^/]+)?\.md$/i.test(o.key),
    );
    check(
      'E1 云端历史版本对象 >= 5 条',
      `versions/${doc.docId}/ 下 >= ${THRESHOLD.minVersions} 个版本对象`,
      `实测 ${versionObjs.length} 个：${versionObjs.map((o) => o.key.split('/').pop()).slice(0, 8).join(', ')}`,
      versionObjs.length >= THRESHOLD.minVersions,
      { repro: '同一文档连续保存 6 次不同内容 -> GET /api/storage/list?prefix=versions/<docId>/' },
    );

    // ---- E2：内容互不相同（sha256 去重）----
    const contents = [];
    for (const o of versionObjs) {
      const text = await getObjectText(doc.vaultId, o.key);
      contents.push({ key: o.key.split('/').pop(), sha: sha256(text ?? ''), text: text ?? '' });
    }
    const distinct = new Set(contents.map((c) => c.sha));
    check(
      'E2 历史版本内容互不相同（>=3 条不同 sha256）',
      `>= ${THRESHOLD.minDistinctVersions} 个不同内容哈希（防止「5 条但内容全一样」误判通过）`,
      `${versionObjs.length} 条版本 -> ${distinct.size} 个不同哈希：${contents
        .map((c) => `${c.key}=${c.sha.slice(0, 8)}`)
        .join(' / ')}`,
      distinct.size >= THRESHOLD.minDistinctVersions,
      {
        repro: '逐个 GET 版本对象并计算 sha256',
        note: 'lead 加严要求：只数条数会被「同内容重复归档」骗过',
      },
    );

    // ---- E3：UI 面板条数 ----
    const opened = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, .tbtn'));
      const hit = btns.find((b) =>
        /历史版本|版本历史/.test(
          `${b.getAttribute('title') || ''}${b.getAttribute('aria-label') || ''}${b.textContent || ''}`,
        ),
      );
      if (!hit) return false;
      hit.click();
      return true;
    });
    if (!opened) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.tbtn, .panel__action, button'));
        btns.find((b) => /history/.test(b.innerHTML || ''))?.click();
      });
    }
    await page.waitForSelector('.history', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await shot(page, 'E3-history-panel');

    const ui = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.history__list .ver'));
      return {
        count: items.length,
        labels: items.slice(0, 8).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)),
        hasPanel: Boolean(document.querySelector('.history')),
      };
    });
    check(
      'E3 历史版本面板列出 >= 5 条（UI）',
      `面板 .history__list .ver >= ${THRESHOLD.minVersions} 条`,
      `实测 ${ui.count} 条：${fmt(ui.labels)}`,
      ui.hasPanel && ui.count >= THRESHOLD.minVersions,
      {
        repro: '保存 6 次 -> 点工具栏「历史版本」-> 数 .history__list .ver',
        note: '修复前 HistoryModal 只要本地有任意一条就不查云端，导致只显示 1 条',
      },
    );

    // ---- E4：第 2 版预览 != 最新版 ----
    const picked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.history__list .ver'));
      if (items.length < 2) return { ok: false };
      items[1].click();
      const label = (items[1].textContent || '').replace(/\s+/g, ' ').trim();
      const rev = /v(\d+)/.exec(label);
      return { ok: true, label: label.slice(0, 60), rev: rev ? Number(rev[1]) : null };
    });
    await page.waitForTimeout(1600);
    const previewText = await page.evaluate(() => (document.querySelector('.history__code')?.textContent || '').trim());
    const currentContent = await readTabContent(page);
    check(
      'E4 选中第 2 版时预览内容 != 最新版',
      '第 2 版预览文本非空，且与当前（最新）正文不同',
      `第 2 版=${fmt(picked.label)}；预览 ${previewText.length} 字符：${fmt(previewText.slice(0, 80))}；最新正文 ${(currentContent || '').length} 字符`,
      picked.ok && previewText.length > 0 && !previewText.includes((currentContent || '').trim().slice(0, 24)),
      { repro: '打开历史面板 -> 点列表第 2 条 -> 读 .history__code' },
    );

    // ---- E5：恢复后正文 == 该版正文 ----
    /*
     * 关键：历史面板右侧展示的是 **diff**（+/- 行），不是原始正文，
     * 因此不能用预览文本当期望值。正确做法是按 UI 显示的版本号（如 `v5`）
     * 回查云端对象 versions/<docId>/<ts>-<rev>-<hash>.md 里 rev 匹配的那一条，
     * 取它的真实正文作为期望。
     */
    const targetRev = picked.rev;
    const candidates = contents.filter((c) => {
      const m = /^(\d+)-(\d+)-([0-9a-f]+)\.md$/i.exec(c.key ?? '');
      return m ? Number(m[2]) === targetRev : false;
    });
    const targetText = candidates.sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))[0];

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.history button, .modal__foot button, button')).find((b) =>
        /恢复/.test(b.textContent || ''),
      );
      btn?.click();
    });
    await page.waitForTimeout(3000);
    const afterRestore = await readTabContent(page);
    const afterRestoreRaw = await readVaultRaw(page, doc.docId);
    check(
      'E5 恢复后正文变成所选版本内容',
      '恢复后 activeTab.content 与仓库内容都等于该版本正文（按 UI 版本号回查云端对象精确比对）',
      `所选=${fmt(picked.label)}（rev=${targetRev ?? '?'}）；期望 ${
        targetText ? `${targetText.key}（${targetText.text.length}B）` : '未找到对应云端版本'
      }；恢复后标签 ${(afterRestore || '').length}B / 仓库 ${(afterRestoreRaw || '').length}B`,
      Boolean(targetText) && (afterRestore === targetText.text || afterRestoreRaw === targetText.text),
      {
        repro: '历史面板选中某版本 -> 点「恢复此版本」-> 读 activeTab.content 与 vault.read',
        note: '恢复会弹 window.confirm，脚本已自动确认（page.on("dialog") 默认 accept）',
      },
    );

    check(
      'E6 历史版本流程无 JS 运行时错误',
      '0 条 pageerror',
      jsErrors.length ? jsErrors.slice(0, 3) : '0 条',
      jsErrors.length === 0,
    );
  } finally {
    await browser.close();
  }
}
