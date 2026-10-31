/**
 * 编辑器 DOM 精确探测：确认「正文在哪、怎么输入、怎么读回」。
 *
 * 为什么必须先做这一步：第一版 S4-S9 脚本里 `document.querySelector('.ProseMirror')`
 * 读到的 textContent 恒为 0，而状态栏却显示 180 字 —— 说明选择器命中的不是真正的
 * 正文节点（可能是 placeholder 或另一个实例）。选择器错了，所有写作类断言都是假的。
 *
 * 用法：node tools/audit-探测编辑器.mjs
 */
import {
  BASE,
  LAUNCH_ARGS,
  loadChromium,
  login,
  newSession,
  sleep,
} from './audit-场景-common.mjs';

const chromium = await loadChromium();
await login();
const { browser, page } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  console.log('=== 初始状态 ===');
  console.log(
    JSON.stringify(
      await page.evaluate(() => ({
        tabs: document.querySelectorAll('.tab').length,
        proseMirror: document.querySelectorAll('.ProseMirror').length,
        cmContent: document.querySelectorAll('.cm-content').length,
        nmContent: document.querySelectorAll('.nm-content').length,
        modeBtn: document.querySelector('.editorbar .viewswitch__btn')?.textContent?.trim() ?? '',
        emptyHint: /还没有打开任何文档/.test(document.body.innerText || ''),
      })),
      null,
      1,
    ),
  );

  // 新建文档
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(2200);

  console.log('\n=== 新建后：所有候选编辑器节点 ===');
  const nodes = await page.evaluate(() => {
    const out = [];
    for (const sel of ['.ProseMirror', '.cm-content', '.nm-content', '[contenteditable="true"]', '.wysiwyg__host', '.shell__content', '.shell__page']) {
      const els = Array.from(document.querySelectorAll(sel));
      out.push({
        sel,
        count: els.length,
        items: els.slice(0, 3).map((e) => {
          const r = e.getBoundingClientRect();
          return {
            cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60),
            w: Math.round(r.width),
            h: Math.round(r.height),
            textLen: (e.textContent || '').length,
            text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            editable: e.getAttribute('contenteditable'),
            childCount: e.children.length,
          };
        }),
      });
    }
    return out;
  });
  console.log(JSON.stringify(nodes, null, 1));

  // 输入测试：往「看起来最像编辑器」的地方打字，观察哪个节点变化
  console.log('\n=== 输入测试 ===');
  const before = await page.evaluate(() => ({
    pm: document.querySelector('.ProseMirror')?.textContent?.length ?? -1,
    pmInner: document.querySelector('.ProseMirror')?.innerHTML?.length ?? -1,
    active: document.activeElement?.className ?? '',
  }));
  console.log('输入前 =', JSON.stringify(before));

  // 点击正文区域（第一版用 position 30,20 可能点到了工具栏）
  const clickedTarget = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { ok: false };
    const r = pm.getBoundingClientRect();
    return { ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  });
  console.log('ProseMirror 位置 =', JSON.stringify(clickedTarget));

  await page.mouse.click(clickedTarget.rect.x + 60, clickedTarget.rect.y + 40);
  await page.waitForTimeout(400);
  await page.keyboard.type('探测标题文本', { delay: 15 });
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    return {
      pmText: pm ? (pm.textContent || '').slice(0, 120) : null,
      pmTextLen: pm ? (pm.textContent || '').length : -1,
      pmInnerHtmlHead: pm ? (pm.innerHTML || '').slice(0, 300) : null,
      activeEl: document.activeElement?.className ?? '',
      activeTag: document.activeElement?.tagName ?? '',
      statusbar: (document.querySelector('.statusbar')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      htmlCandidates: {
        pmCount: document.querySelectorAll('.ProseMirror').length,
        // 是否有嵌套：列出每个 pm 的父子关系
        parents: Array.from(document.querySelectorAll('.ProseMirror')).map((e) => ({
          parentCls: (typeof e.parentElement?.className === 'string' ? e.parentElement.className : '').slice(0, 50),
          len: (e.textContent || '').length,
        })),
      },
    };
  });
  console.log('输入后 =', JSON.stringify(after, null, 1));

  // 读 store 里 activeTab.content，判断真实数据
  const storeState = await page.evaluate(() => {
    // eslint-disable-next-line no-eval
    const app = eval("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')");
    return {
      activeTabTitle: app?.activeTab?.title ?? null,
      activeTabId: app?.activeTab?.id ?? null,
      activeTabMode: app?.activeTab?.mode ?? null,
      contentLen: (app?.activeTab?.content ?? '').length,
      contentHead: (app?.activeTab?.content ?? '').slice(0, 300),
      tabCount: app?.tabs?.length ?? 0,
      tabs: (app?.tabs ?? []).slice(0, 5).map((t) => ({ id: t.id, title: t.title, mode: t.mode, len: (t.content || '').length })),
    };
  });
  console.log('\n=== store 状态 ===');
  console.log(JSON.stringify(storeState, null, 1));

  await page.screenshot({ path: 'docs/AUDIT-140/shots/probe-editor.png' });
  console.log('\n截图: docs/AUDIT-140/shots/probe-editor.png');
} catch (e) {
  console.log('[ERROR]', e?.stack ?? e);
} finally {
  await browser.close();
}
