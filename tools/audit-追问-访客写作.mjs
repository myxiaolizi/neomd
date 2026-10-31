/**
 * 审计追问：访客（未登录）到底能不能写作？
 * =============================================================================
 * S3 发现「未登录访问 /app 不会被拦到登录页」，而是渲染出一个「未登录」态的工作台。
 * 要判断这是**有意的本地优先设计**还是**坏路径**，只有一个判据：
 *   **访客能不能真的写出内容并保存下来。**
 *
 * 同时复核三件事：
 *   1. 未登录态横幅写「自动同步已就绪」，但未登录时同步本不可能工作 —— 是否误导？
 *   2. 登录页的「进入本机编辑器」按钮点击后是否真的能编辑；
 *   3. 访客新建文档后刷新，内容是否还在（本地仓库落盘是否真的可用）。
 *
 * 用法：node tools/audit-追问-访客写作.mjs
 */
import {
  API,
  BASE,
  LAUNCH_ARGS,
  auditShot,
  beginScenario,
  fmt,
  httpJson,
  loadChromium,
  scenarioSummary,
  sleep,
  writeScenarioJson,
} from './audit-场景-common.mjs';

const chromium = await loadChromium();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
const s = beginScenario('S3b', '访客（未登录）写作能力核实', '判断 /app 对访客开放是「有意设计」还是「坏路径」');

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 160)));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  /* ---------- 1. 未登录态的 UI 自述 ---------- */
  const state1 = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      hasShell: Boolean(document.querySelector('.shell__main')),
      banner: /未登录/.test(txt),
      syncClaim: /自动同步已就绪|同步已就绪/.test(txt),
      emptyVault: /仓库还是空的/.test(txt),
      text: txt.slice(0, 400),
      tabCount: document.querySelectorAll('.tab').length,
      editor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
      newDocBtn: Array.from(document.querySelectorAll('button')).some((b) => /新建文档/.test(b.textContent || '')),
    };
  });
  s.step(
    '未登录态是否明确标注「未登录」',
    '页面明确提示未登录',
    `banner=${state1.banner}；文本：${JSON.stringify(state1.text.slice(0, 120))}`,
    state1.banner,
  );
  s.step(
    '未登录态是否提供了新建文档入口',
    '存在「新建文档」按钮或 Ctrl+N',
    `newDocBtn=${state1.newDocBtn}, editor=${state1.editor}`,
    state1.newDocBtn || state1.editor,
  );

  /* ---------- 2. 访客能否真的新建并写入 ---------- */
  await page.keyboard.press('Control+n').catch(() => {});
  await page.waitForTimeout(1500);
  let afterNew = await page.evaluate(() => ({
    editor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
    tabCount: document.querySelectorAll('.tab').length,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  }));
  if (!afterNew.editor) {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
      btn?.click();
    });
    await page.waitForTimeout(1800);
    afterNew = await page.evaluate(() => ({
      editor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
      tabCount: document.querySelectorAll('.tab').length,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }));
  }
  s.step('访客点「新建文档」后出现编辑器', '存在 .ProseMirror/.cm-content', `editor=${afterNew.editor}, tabCount=${afterNew.tabCount}`, afterNew.editor);

  const MARK = `访客写作验证-${Date.now()}`;
  let typed = false;
  if (afterNew.editor) {
    await page.locator('.ProseMirror').first().click({ position: { x: 30, y: 20 } }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.type(`# ${MARK}`, { delay: 8 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter').catch(() => {});
    await page.keyboard.type('这是未登录状态下写入的正文。', { delay: 5 }).catch(() => {});
    await page.waitForTimeout(800);
    typed = true;
  }
  const afterType = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    return {
      content: pm ? (pm.textContent || '').slice(0, 200) : null,
      wordCount: (document.querySelector('.statusbar')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      tabTitle: document.querySelector('.tab.is-active')?.textContent?.trim() ?? '',
    };
  });
  s.step(
    '访客能输入正文（编辑器可写）',
    '编辑器内出现所输入的文字',
    `内容=${JSON.stringify((afterType.content || '').slice(0, 80))}`,
    Boolean(afterType.content && afterType.content.includes(MARK)),
  );

  /* ---------- 3. 保存 + 刷新后是否还在（本地落盘是否真的可用） ---------- */
  let persisted = false;
  let persistedDetail = '';
  if (typed) {
    await page.keyboard.press('Control+s').catch(() => {});
    await page.waitForTimeout(2500);
    const savedTab = await page.evaluate(() => document.querySelector('.tab.is-active')?.textContent?.trim() ?? '');
    // 刷新验证
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3500);
    const afterReload = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        text: txt.slice(0, 600),
        hasContent: txt.includes('访客写作验证'),
        tabCount: document.querySelectorAll('.tab').length,
        files: Array.from(document.querySelectorAll('.filetree__item, .fileitem, [class*="file"]'))
          .map((e) => (e.textContent || '').trim())
          .filter((t) => t.includes('访客写作验证'))
          .slice(0, 3),
      };
    });
    persisted = afterReload.hasContent || afterReload.files.length > 0;
    persistedDetail = `保存时标签=${JSON.stringify(savedTab)}；刷新后 hasContent=${afterReload.hasContent}, 文件命中=${fmt(afterReload.files)}, tabCount=${afterReload.tabCount}`;
    s.step('访客保存后刷新，内容仍在（本地落盘真的可用）', '刷新后文本含验证标记', persistedDetail, persisted);
    await auditShot(page, 'S3b-guest-after-reload');
  }

  /* ---------- 4. 未登录却说「自动同步已就绪」是否误导 ---------- */
  const syncProbe = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return { claim: /自动同步已就绪|同步已就绪/.test(txt), loginHint: /未登录/.test(txt), text: txt.slice(0, 200) };
  });
  // 未登录时同步本不可能工作：看 /api/settings 是否 401（前面已证），这里判断 UI 是否同时说「就绪」
  s.step(
    '未登录态文案是否自相矛盾（同时说「自动同步已就绪」与「未登录」）',
    '不应同时出现',
    `同步就绪文案=${syncProbe.claim}, 未登录文案=${syncProbe.loginHint}`,
    !(syncProbe.claim && syncProbe.loginHint),
    syncProbe.claim && syncProbe.loginHint
      ? '误导：未登录时云端同步不可能工作，却提示「自动同步已就绪」'
      : '',
  );

  /* ---------- 5. 登录页「进入本机编辑器」按钮 ---------- */
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const localBtn = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a')).find((e) => /本机编辑器|本地编辑器/.test((e.textContent || '').trim()));
    if (!el) return { found: false };
    el.click();
    return { found: true, text: (el.textContent || '').trim() };
  });
  await page.waitForTimeout(3500);
  const localState = await page.evaluate(() => ({
    path: location.pathname,
    hasEditor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
    hasShell: Boolean(document.querySelector('.shell__main')),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  }));
  s.step(
    '登录页「进入本机编辑器」点击后进入可编辑界面',
    '跳转后有编辑器（.ProseMirror/.cm-content）',
    `found=${localBtn.found}, path=${localState.path}, hasEditor=${localState.hasEditor}, 文本=${JSON.stringify(localState.text.slice(0, 140))}`,
    !localBtn.found ? false : localState.hasEditor,
    localBtn.found && !localState.hasEditor
      ? '按钮文案承诺「进入本机编辑器」，实际只到未登录空工作台、没有编辑器'
      : '',
  );
  await auditShot(page, 'S3b-local-editor-entry');

  s.step('全流程无 JS 运行时错误', '0 条 pageerror', `${jsErrors.length} 条 ${fmt(jsErrors.slice(0, 2))}`, jsErrors.length === 0);

  await ctx.close();
} catch (e) {
  s.fail(String(e?.stack ?? e));
} finally {
  await browser.close();
  s.end();
  writeScenarioJson('scenarios-S3b.json');
  scenarioSummary();
}
