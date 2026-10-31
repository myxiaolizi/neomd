/**
 * 1.4 门禁侦察脚本（只读，临时文件用后即删）
 * 一次性摸清 6 段所需的真实选择器与 DOM 结构，避免在正式门禁里猜选择器。
 */

import { loadChromium, newSession, openWorkbench, login, setMode } from '../re121/common.mjs';

/** 关键：探针必须先登录拿到 token */
async function main() {
  await login();
  const chromium = await loadChromium();
  const { browser, page } = await newSession(chromium, {});
  const out = {};
  try {
    await openWorkbench(page);
    await page.waitForTimeout(1200);

    /* ---------- C 布局：分屏手柄 ---------- */
    out.layout = await page.evaluate(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      return {
        editorbarBtns: q('.editorbar .viewswitch__btn').map((b) => (b.textContent || '').trim().slice(0, 20)),
        splitButtons: q('.editorbar [title*="分屏"], .editorbar button').filter((b) => /分屏/.test(b.getAttribute('title') || '')).map((b) => b.getAttribute('title')),
        resizeHandles: q('.resize-handle, [class*="resize"]').map((e) => ({ cls: String(e.className), dir: e.getAttribute('data-direction') || e.getAttribute('aria-label') })),
        splitpane: q('.shell__splitpane').length,
        rightstack: q('.rightstack').length,
        rightPaneBtns: q('.rightstack__tabs button, [class*="righttab"], .rsection').length,
      };
    });

    /* ---------- D 设置：设置页结构 ---------- */
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    out.settings = await page.evaluate(() => {
      const pane = document.querySelector('.settings');
      const footers = Array.from(document.querySelectorAll('[class*="footer"], [class*="actions-bar"], [class*="savebar"]'));
      return {
        tabs: Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim()),
        hasEditorBar: Boolean(document.querySelector('.editorbar')),
        editorBarCount: document.querySelectorAll('.editorbar').length,
        footerCandidates: footers.map((f) => ({ cls: String(f.className).slice(0, 60), text: (f.textContent || '').trim().slice(0, 60) })),
        saveButtons: Array.from(document.querySelectorAll('.settings button')).filter((b) => /保存/.test(b.textContent || '')).map((b) => ({ cls: String(b.className).slice(0, 50), text: (b.textContent || '').trim().slice(0, 20) })),
        themeScopeBtns: Array.from(document.querySelectorAll('[data-testid="theme-scope"] button, [data-testid="theme-scope"] .seg__item')).map((b) => (b.textContent || '').trim()),
        paneLen: (pane?.innerText || '').length,
      };
    });

    /* ---------- 主题：5 套主题的 --border 与 --bg ---------- */
    const themeProbe = [];
    const themeIds = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="theme-cards"] > *'));
      return cards.map((c) => (c.textContent || '').replace(/^Aa\s*/, '').trim().slice(0, 20));
    });
    out.themeCardLabels = themeIds;
    for (let i = 0; i < Math.min(themeIds.length, 12); i += 1) {
      await page.evaluate((idx) => {
        const cards = document.querySelectorAll('[data-testid="theme-cards"] > *');
        cards[idx]?.click();
      }, i);
      await page.waitForTimeout(450);
      const vars = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          preset: document.documentElement.dataset.themePreset,
          theme: document.documentElement.dataset.theme,
          border: cs.getPropertyValue('--border').trim(),
          borderStrong: cs.getPropertyValue('--border-strong').trim(),
          bg: cs.getPropertyValue('--bg').trim(),
          contentBg: cs.getPropertyValue('--content-bg').trim(),
          tableBorder: cs.getPropertyValue('--table-border').trim(),
        };
      });
      themeProbe.push({ idx: i, label: themeIds[i], ...vars });
    }
    out.themes = themeProbe;

    /* ---------- 主题作用域：content 档下界面变量是否被清理 ---------- */
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '主题');
      el?.click();
    });
    await page.waitForTimeout(500);
    const scopeProbe = [];
    for (const scope of ['all', 'content', 'chrome']) {
      await page.evaluate((s) => {
        const segs = Array.from(document.querySelectorAll('[data-testid="theme-scope"] .seg__item, [data-testid="theme-scope"] button'));
        const map = { all: 0, content: 1, chrome: 2 };
        segs[map[s]]?.click();
      }, scope);
      await page.waitForTimeout(700);
      const v = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          scope: document.documentElement.dataset.themeScope,
          bg: cs.getPropertyValue('--bg').trim(),
          fg: cs.getPropertyValue('--fg').trim(),
          border: cs.getPropertyValue('--border').trim(),
          contentBg: cs.getPropertyValue('--content-bg').trim(),
          inlineBg: document.documentElement.style.getPropertyValue('--bg').trim(),
          inlineBorder: document.documentElement.style.getPropertyValue('--border').trim(),
          inlineContentBg: document.documentElement.style.getPropertyValue('--content-bg').trim(),
        };
      });
      scopeProbe.push(v);
    }
    out.scopes = scopeProbe;

    /* ---------- E 命名模板 / AI 提示词 DOM 文本 ---------- */
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === '通用');
      el?.click();
    });
    await page.waitForTimeout(600);
    out.naming = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('.settings input, .settings textarea'));
      const find = (label) => {
        const fields = Array.from(document.querySelectorAll('.settings .field, .settings .field--row'));
        const f = fields.find((x) => new RegExp(label).test(x.querySelector('.nm-label, label')?.textContent || ''));
        if (!f) return null;
        const el = f.querySelector('input, textarea');
        return el ? { tag: el.tagName, value: el.value, len: el.value.length } : null;
      };
      return {
        template: find('命名模板'),
        aiPrompt: find('AI 命名提示词'),
        allLabels: Array.from(document.querySelectorAll('.settings .nm-label')).map((e) => (e.textContent || '').trim()),
      };
    });

    /* ---------- A 插件：插件中心结构 ---------- */
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab'));
      tabs.find((t) => /设置/.test(t.textContent || ''))?.querySelector('.tab__close')?.click();
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, .ribbon__btn')).find((b) => /插件/.test(b.getAttribute('title') || '') || /插件商店/.test(b.textContent || ''));
      btn?.click();
      if (!btn) {
        // 兜底：快捷键
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }));
      }
    });
    await page.waitForTimeout(1600);
    out.pluginCenter = await page.evaluate(() => {
      const subTabs = Array.from(document.querySelectorAll('[class*="plugintab"], .plugin-center button, .plg button, [role="tab"]')).map((b) => (b.textContent || '').trim().slice(0, 24)).filter(Boolean);
      return {
        hasCenter: Boolean(document.querySelector('[class*="plugin"], .plugincenter')),
        subTabs: subTabs.slice(0, 20),
        inputCount: document.querySelectorAll('.plugincenter input, [class*="plugin"] input').length,
        installButtons: Array.from(document.querySelectorAll('button')).filter((b) => /安装/.test(b.textContent || '')).length,
        bodyLen: (document.body.innerText || '').length,
      };
    });

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('PROBE FAILED:', e?.message || e);
  process.exit(1);
});
