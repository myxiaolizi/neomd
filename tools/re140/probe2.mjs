/**
 * 1.4 侦察 #2（只读）：补齐 #1 没摸到的选择器
 *  - 编辑器工具栏/分屏按钮的真实 DOM（#1 里 viewswitch__btn 文本为空）
 *  - 主题页签的真实结构（#1 里 theme-cards / theme-scope 都是空）
 *  - 右侧栏 stack 与开关按钮
 *  - 设置页 .editorbar 到底渲染了什么（需求15）
 *  - 浏览器内 localStorage 的 naming 值（E9 数据层乱码取证）
 */

import { loadChromium, newSession, openWorkbench, login } from '../re121/common.mjs';

async function main() {
  await login();
  const chromium = await loadChromium();
  const { browser, page } = await newSession(chromium, {});
  const out = {};
  try {
    await openWorkbench(page);
    await page.waitForTimeout(1500);

    /* ---------- 编辑器工具栏与分屏入口 ---------- */
    out.editorbar = await page.evaluate(() => {
      const dump = (el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 70),
        title: el.getAttribute('title') || '',
        aria: el.getAttribute('aria-label') || '',
        text: (el.textContent || '').trim().slice(0, 24),
      });
      const bar = document.querySelector('.editorbar');
      return {
        barFound: Boolean(bar),
        barChildren: bar ? Array.from(bar.children).map(dump) : [],
        viewswitch: Array.from(document.querySelectorAll('.viewswitch__btn')).map(dump),
        allTitled: Array.from(document.querySelectorAll('.editorbar [title]')).map(dump).slice(0, 40),
      };
    });

    /* ---------- 右侧栏：面板开关按钮（在右侧工具栏/ribbon） ---------- */
    out.rightSide = await page.evaluate(() => {
      const dump = (el) => ({ cls: String(el.className).slice(0, 60), title: el.getAttribute('title') || '', text: (el.textContent || '').trim().slice(0, 20) });
      const cands = Array.from(document.querySelectorAll('[title*="侧栏"], [title*="面板"], [title*="AI"], [title*="大纲"], [title*="反链"], [title*="标签"], [title*="历史"], [title*="统计"], [title*="日历"], [title*="文件"]'));
      return {
        rightEls: Array.from(document.querySelectorAll('[class*="right"], [class*="rsection"], [class*="sidepanel"]')).map((e) => String(e.className).slice(0, 60)).slice(0, 20),
        panelToggles: cands.map(dump).slice(0, 30),
        ribbon: Array.from(document.querySelectorAll('.ribbon__btn')).map(dump),
      };
    });

    /* ---------- 分屏：通过命令面板或菜单找 ---------- */
    out.splitAttempt = await page.evaluate(async () => {
      // 直接看 store 里的 splitDirection / localLayout
      const s = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get?.('app');
      const layoutRaw = localStorage.getItem('neomd.localLayout.v1') || localStorage.getItem('neomd.local.layout.v1');
      const keys = Object.keys(localStorage).filter((k) => /layout|split/i.test(k));
      return {
        layoutKeys: keys,
        layoutRaw: layoutRaw ? layoutRaw.slice(0, 300) : null,
        storeKeys: s ? Object.keys(s).filter((k) => /split|right|layout/i.test(k)) : null,
      };
    });

    /* ---------- 设置页：主题页签结构 + editorbar ---------- */
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '主题')?.click();
    });
    await page.waitForTimeout(900);
    out.themeTab = await page.evaluate(() => {
      const pane = document.querySelector('.settings');
      const body = pane?.innerText || '';
      return {
        textLen: body.length,
        textHead: body.slice(0, 500),
        themeCards: document.querySelectorAll('[data-testid="theme-cards"]').length,
        themeScope: document.querySelectorAll('[data-testid="theme-scope"]').length,
        testids: Array.from(document.querySelectorAll('.settings [data-testid]')).map((e) => e.getAttribute('data-testid')),
        h3s: Array.from(document.querySelectorAll('.settings h3')).map((e) => (e.textContent || '').trim()).slice(0, 20),
        segItems: Array.from(document.querySelectorAll('.settings .seg__item')).map((e) => (e.textContent || '').trim()).slice(0, 20),
      };
    });

    /* ---------- 需求15：设置页里的 .editorbar 内容 ---------- */
    out.editorbarOnSettings = await page.evaluate(() => {
      const bar = document.querySelector('.editorbar');
      if (!bar) return { found: false };
      const r = bar.getBoundingClientRect();
      return {
        found: true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
        text: (bar.textContent || '').trim().slice(0, 120),
        btnCount: bar.querySelectorAll('button').length,
        parentCls: String(bar.parentElement?.className || '').slice(0, 60),
      };
    });

    /* ---------- E9：浏览器内 naming 值 ---------- */
    out.namingLocal = await page.evaluate(() => {
      const parse = (k) => {
        try {
          return JSON.parse(localStorage.getItem(k) || 'null');
        } catch {
          return null;
        }
      };
      const s = parse('neomd.settings.v1');
      return {
        template: s?.naming?.template ?? null,
        fallback: s?.naming?.fallback ?? null,
        aiPromptLen: (s?.naming?.aiPrompt ?? '').length,
        aiPromptHead: String(s?.naming?.aiPrompt ?? '').slice(0, 60),
        keys: Object.keys(localStorage).filter((k) => /neomd/.test(k)),
      };
    });

    /* ---------- 设置页全部控件清单（D 段"全项有效"用） ---------- */
    out.controlsByTab = {};
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim()));
    for (const tab of tabs) {
      await page.evaluate((lbl) => {
        Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === lbl)?.click();
      }, tab);
      await page.waitForTimeout(420);
      out.controlsByTab[tab] = await page.evaluate(() => {
        const pane = document.querySelector('.settings');
        const list = Array.from(pane?.querySelectorAll('input, select, textarea, .toggle-btn, [role="switch"]') || [])
          .filter((el) => !el.closest('.settings__nav'))
          .map((el) => ({
            tag: el.tagName,
            type: el.getAttribute('type') || '',
            aria: el.getAttribute('aria-label') || '',
            cls: String(el.className).slice(0, 30),
            value: 'value' in el ? String(el.value ?? '').slice(0, 30) : '',
          }));
        return list;
      });
    }

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('PROBE2 FAILED:', e?.message || e);
  process.exit(1);
});
