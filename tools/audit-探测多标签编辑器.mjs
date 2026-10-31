/**
 * 探测：多标签下是否同时存在多个编辑器实例（导致 querySelector 命中错的那个）。
 *
 * 假设：S4 失败是因为 querySelector('.ProseMirror') 取到了**非活动标签**的编辑器，
 * 而键盘输入进的是**活动标签**的编辑器 → 读到 0 字但状态栏显示 180 字。
 *
 * 用法：node tools/audit-探测多标签编辑器.mjs
 */
import { BASE, loadChromium, login, newSession } from './audit-场景-common.mjs';

const chromium = await loadChromium();
await login();
const { browser, page } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });

const SNAP = `(() => {
  const editors = Array.from(document.querySelectorAll('.ProseMirror')).map((e, i) => {
    const r = e.getBoundingClientRect();
    // 往上找所属的 tab 容器
    let owner = null;
    let p = e;
    for (let k = 0; k < 12 && p; k += 1) {
      if (p.className && /panes|pane|shell__content/.test(String(p.className))) { owner = String(p.className).slice(0, 60); break; }
      p = p.parentElement;
    }
    const cs = getComputedStyle(e);
    return {
      i,
      len: (e.textContent || '').length,
      text: (e.textContent || '').slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left),
      display: cs.display, visibility: cs.visibility,
      editable: e.getAttribute('contenteditable'),
      ownerCls: owner,
      focused: e.classList.contains('ProseMirror-focused'),
    };
  });
  return {
    tabCount: document.querySelectorAll('.tab').length,
    tabs: Array.from(document.querySelectorAll('.tab')).map((t) => ({
      text: (t.textContent || '').trim().slice(0, 24),
      active: String(t.className).includes('is-active'),
    })),
    editorCount: editors.length,
    editors,
    activeTabTitle: (document.querySelector('.tab.is-active')?.textContent || '').trim().slice(0, 24),
  };
})()`;

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  // 新建第 1 篇并写内容
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(2000);
  let snap = await page.evaluate(SNAP);
  console.log('=== 新建第 1 篇 ===');
  console.log(JSON.stringify({ tabCount: snap.tabCount, editorCount: snap.editorCount, editors: snap.editors.map((e) => ({ i: e.i, len: e.len, w: e.w, h: e.h, focused: e.focused })) }, null, 1));

  const box1 = snap.editors[0];
  await page.mouse.click(box1.left + 60, box1.top + 40);
  await page.waitForTimeout(300);
  await page.keyboard.type('第一篇文章内容ABC', { delay: 12 });
  await page.waitForTimeout(700);
  snap = await page.evaluate(SNAP);
  console.log('\n第 1 篇写入后：', JSON.stringify({ tabCount: snap.tabCount, editorCount: snap.editorCount, editors: snap.editors.map((e) => ({ i: e.i, len: e.len, text: e.text, focused: e.focused })) }, null, 1));

  // 新建第 2 篇
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(2200);
  snap = await page.evaluate(SNAP);
  console.log('\n=== 新建第 2 篇后（关键：编辑器实例数是否变 2） ===');
  console.log(JSON.stringify(snap, null, 1));

  // 往当前（第 2 篇）输入，看只改哪个
  const active = snap.editors.find((e) => e.focused) ?? snap.editors[snap.editors.length - 1];
  const box = snap.editors[snap.editors.length - 1];
  await page.mouse.click(box.left + 60, box.top + 40);
  await page.waitForTimeout(300);
  await page.keyboard.type('第二篇内容XYZ', { delay: 12 });
  await page.waitForTimeout(700);
  snap = await page.evaluate(SNAP);
  console.log('\n第 2 篇写入后：');
  console.log(JSON.stringify({ editorCount: snap.editorCount, editors: snap.editors.map((e) => ({ i: e.i, len: e.len, text: e.text, focused: e.focused, w: e.w, h: e.h })) }, null, 1));

  const store = await page.evaluate(() => {
    // eslint-disable-next-line no-eval
    const app = eval("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')");
    return {
      tabCount: app.tabs.length,
      activeTabId: app.activeTabId,
      tabs: app.tabs.map((t) => ({ id: t.id, title: t.title, len: (t.content || '').length, head: (t.content || '').slice(0, 30) })),
    };
  });
  console.log('\n=== store ===');
  console.log(JSON.stringify(store, null, 1));

  console.log('\n结论：若 editorCount > 1，则所有写作断言都必须限定到「活动标签的编辑器」。');
  await page.screenshot({ path: 'docs/AUDIT-140/shots/probe-multi-editor.png' });

  // 清理：删掉这两篇
  for (const t of store.tabs) {
    const r = await page.evaluate(async (id) => {
      // eslint-disable-next-line no-eval
      const app = eval("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')");
      try { await app.deleteDoc(id); return true; } catch { return false; }
    }, t.id);
    console.log(`  清理 ${t.title}: ${r}`);
  }
} catch (e) {
  console.log('[ERROR]', e?.stack ?? e);
} finally {
  await browser.close();
}
