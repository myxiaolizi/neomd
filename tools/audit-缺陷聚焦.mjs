/**
 * 审计缺陷聚焦复现：三个候选真缺陷的隔离验证
 * =============================================================================
 * 从 S4-S9 第一轮跑出三个可疑点，必须隔离确认是**产品缺陷**还是**测试假象**：
 *
 *   D1【代码块丢失】插入代码块后 DOM 有 `<pre>`，但保存后的 markdown 里没有 ```，
 *      重开后 pre=0 —— 是「代码块无法序列化为 markdown」吗？
 *   D2【对照模式无预览】切到对照模式后 hasCM=true 但 hasPM=false ——
 *      是真的没有预览面板，还是预览用了别的容器/类名？
 *   D3【历史版本为空】连续保存 3 次后打开历史版本面板，提示「还没有历史版本」——
 *      是归档链路坏了，还是需要云端同步完成 / 特定设置？
 *
 * ## 为什么用「真实设置」而不拦截 /api/settings
 *
 * D3 涉及云同步链路（`canSync()` / `archiveVersionToCloud`），拦截 settings 可能干扰它。
 * 本脚本**从不打开设置页、不写任何设置**，因此不产生 settings 写入（结束时用
 * `assertZeroWrites` 自证）。只创建临时文档并在 finally 删除。
 *
 * 用法：node tools/audit-缺陷聚焦.mjs
 */
import {
  API,
  BASE,
  assertZeroWrites,
  auditShot,
  beginScenario,
  diffCloudBaseline,
  fmt,
  installWriteGuard,
  loadChromium,
  login,
  newSession,
  scenarioSummary,
  sleep,
  snapshotCloudBaseline,
  waitUntil,
  writeScenarioJson,
} from './audit-场景-common.mjs';

const APP_STORE =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
console.log(`云端基线：${baseline.vaultCount} 仓库，设置版本 ${baseline.settingsVersion}`);

const tempDocs = new Set();

/** 真实设置模式（不拦截 settings）+ 放行存储；仅拦截「设置」以外的危险写？这里不拦，靠自证 */
const session = await newSession(chromium, { settingsMode: 'real', viewport: { width: 1600, height: 1000 } });
const { page, browser } = session;

const readEd = async () =>
  page.evaluate((expr) => {
    const pm = document.querySelector('.ProseMirror');
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    const tab = app?.activeTab;
    return {
      hasPM: Boolean(pm),
      domHtml: pm ? (pm.innerHTML || '') : '',
      domLen: pm ? (pm.textContent || '').length : -1,
      h1: Boolean(pm?.querySelector('h1')),
      li: pm?.querySelectorAll('li').length ?? 0,
      quote: pm?.querySelectorAll('blockquote').length ?? 0,
      pre: pm?.querySelectorAll('pre').length ?? 0,
      table: pm?.querySelectorAll('table').length ?? 0,
      storeContent: tab?.content ?? '',
      storeLen: (tab?.content ?? '').length,
      tabId: tab?.id ?? '',
      tabTitle: tab?.title ?? '',
      tabDirty: tab?.dirty ?? null,
      tabs: (app?.tabs ?? []).length,
      canSync: (() => { try { return Boolean(app?.canSync?.()); } catch { return null; } })(),
    };
  }, APP_STORE);

const focusEditor = async () => {
  for (let i = 0; i < 3; i += 1) {
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    });
    if (!box) return false;
    await page.mouse.click(box.x + Math.min(60, box.w / 4), box.y + 24);
    const ok = await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror-focused')), { timeout: 3000 });
    if (ok) return true;
    await sleep(300);
  }
  return false;
};

const clickTool = async (titleSrc) => {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src);
    const btn = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((b) => re.test(b.getAttribute('title') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, titleSrc);
  await page.waitForTimeout(1000);
  return ok;
};

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);
  console.log(`canSync=${(await readEd()).canSync}`);

  /* ===================== D1 代码块序列化 ===================== */
  {
    const s = beginScenario('D1', '代码块 → markdown 序列化是否丢失', '插入代码块后保存，markdown 是否含 ```');
    try {
      await page.keyboard.press('Control+n');
      await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
      let st = await readEd();
      if (st.tabId) tempDocs.add(st.tabId);

      await focusEditor();
      await page.keyboard.type('D1 代码块测试', { delay: 4 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);

      const clicked = await clickTool('代码块');
      st = await readEd();
      s.step('工具栏插入代码块', 'DOM pre>=1', `clicked=${clicked}, pre=${st.pre}`, st.pre >= 1);

      if (st.pre >= 1) {
        // 往代码块里写点东西
        await page.keyboard.type('const answer = 42;', { delay: 5 });
        await page.waitForTimeout(600);
        st = await readEd();
        s.step('代码块内可输入', 'pre 内出现代码文本', `domHtml 片段=${JSON.stringify(st.domHtml.slice(0, 260))}`, /const answer/.test(st.domHtml));
      }

      // 保存
      await page.keyboard.press('Control+s').catch(() => {});
      await page.waitForTimeout(3200);
      st = await readEd();
      const md = st.storeContent || '';
      console.log('      ---- 保存后的 markdown 全文 ----');
      console.log(md.split('\n').map((l) => `      | ${l}`).join('\n'));
      console.log('      --------------------------------');
      s.step(
        'D1-a 保存后 markdown 含代码块围栏 ```',
        'storeContent 匹配 /^```/m',
        `pre(DOM)=${st.pre}, markdown 含围栏=${/```/.test(md)}, len=${md.length}`,
        /```/.test(md),
        /```/.test(md) ? '' : '代码块在 DOM 里有，但没被序列化进 markdown → 重开必丢',
      );

      // 关闭重开验证
      await page.keyboard.press('Control+w').catch(() => {});
      await page.waitForTimeout(1600);
      const reopened = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('*'));
        const hit = nodes.find((e) => {
          const t = (e.textContent || '').trim();
          return t.startsWith('D1 代码块测试') && t.length < 70 && e.children.length <= 3 && e.getBoundingClientRect().width > 0;
        });
        if (!hit) return false;
        hit.click();
        return true;
      });
      await page.waitForTimeout(2400);
      st = await readEd();
      if (st.tabId) tempDocs.add(st.tabId);
      s.step(
        'D1-b 重开后代码块仍在',
        'DOM pre>=1',
        `reopened=${reopened}, pre=${st.pre}, markdown 含围栏=${/```/.test(st.storeContent || '')}`,
        st.pre >= 1,
        st.pre === 0 ? '重开后代码块消失（内容丢失）' : '',
      );
      await auditShot(page, 'D1-codeblock');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ===================== D2 对照模式预览 ===================== */
  {
    const s = beginScenario('D2', '对照模式的预览面板是否存在', '切到对照模式后是否有独立的预览渲染');
    try {
      // 确保有文档
      if (!(await page.locator('.ProseMirror, .cm-content').count())) {
        await page.keyboard.press('Control+n');
        await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
      }
      const st0 = await readEd();
      if (st0.tabId) tempDocs.add(st0.tabId);

      await page.evaluate(() => {
        const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
        btns[btns.length - 1]?.click();
      });
      await page.waitForSelector('.viewswitch__menu', { timeout: 6000 }).catch(() => {});
      const picked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
        const hit = items.find((e) => /对照/.test(e.textContent || ''));
        if (!hit) return false;
        hit.click();
        return true;
      });
      await page.waitForTimeout(2500);

      const dom = await page.evaluate(() => {
        // 把所有「可能是预览」的候选都列出来
        const cands = [
          '.ProseMirror', '.cm-content', '.compare', '[class*="compare"]',
          '.preview', '[class*="preview"]', '.render', '[class*="render"]',
          '.nm-content', '.split', '[class*="split"]', '.shell__panes > *',
        ];
        const out = [];
        for (const sel of cands) {
          const els = Array.from(document.querySelectorAll(sel));
          if (!els.length) continue;
          out.push({
            sel,
            count: els.length,
            items: els.slice(0, 4).map((e) => {
              const r = e.getBoundingClientRect();
              return {
                cls: (typeof e.className === 'string' ? e.className : '').slice(0, 70),
                tag: e.tagName,
                w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left),
                len: (e.textContent || '').length,
                head: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
              };
            }),
          });
        }
        return {
          modeBtn: document.querySelector('.editorbar .viewswitch__btn:last-child')?.textContent?.trim() ?? '',
          bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          cands: out,
          editorPanels: Array.from(document.querySelectorAll('.shell__panes > *')).map((e) => ({
            cls: (typeof e.className === 'string' ? e.className : '').slice(0, 70),
            w: Math.round(e.getBoundingClientRect().width),
            len: (e.textContent || '').length,
          })),
        };
      });
      console.log('      对照模式 DOM 候选：');
      console.log(JSON.stringify(dom.cands.filter((c) => c.count > 0), null, 1).slice(0, 3000));
      console.log('      .shell__panes 子元素：', JSON.stringify(dom.editorPanels));

      const hasPM = dom.cands.some((c) => c.sel === '.ProseMirror' && c.count > 0);
      const hasCM = dom.cands.some((c) => c.sel === '.cm-content' && c.count > 0);
      // 「预览」的判据：存在第二个渲染容器（非 cm-content）且有与正文相同的内容
      const previewLike = dom.cands.filter((c) => /preview|render|compare/i.test(c.sel) && c.count > 0);

      s.step('切到对照模式', 'mode 按钮文案变化', `picked=${picked}, modeBtn=${JSON.stringify(dom.modeBtn)}`, picked);
      s.step('对照模式有源码面板', '.cm-content 存在', `hasCM=${hasCM}`, hasCM);
      s.step(
        '对照模式有预览面板（独立渲染容器）',
        '.ProseMirror 或 preview/render 容器存在',
        `hasPM=${hasPM}, previewLike=${fmt(previewLike.map((p) => p.sel))}`,
        hasPM || previewLike.length > 0,
        !hasPM && previewLike.length === 0 ? '对照模式只有源码侧，没有预览渲染 —— 名不副实的「对照」' : '',
      );
      await auditShot(page, 'D2-compare-mode');
      await page.evaluate(() => {
        const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
        btns[btns.length - 1]?.click();
      });
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
        items.find((e) => /所见即所得/.test(e.textContent || ''))?.click();
      });
      await page.waitForTimeout(1500);
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ===================== D3 历史版本归档 ===================== */
  {
    const s = beginScenario('D3', '历史版本归档链路', '多次保存后历史版本是否产生条目');
    try {
      if (!(await page.locator('.ProseMirror').count())) {
        await page.keyboard.press('Control+n');
        await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
      }
      let st = await readEd();
      if (st.tabId) tempDocs.add(st.tabId);
      s.step('canSync（云同步能力）', 'true 才可能归档到云端', `canSync=${st.canSync}`, st.canSync === true, st.canSync === false ? '未开启同步 → 历史版本只能本地留痕' : '');

      // 首版
      await focusEditor();
      await page.keyboard.type('# D3 历史测试', { delay: 4 });
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(4000);

      // 再改 2 次并保存，每次保存前内容都不同 → 应各归档一版
      for (let i = 1; i <= 2; i += 1) {
        await focusEditor();
        await page.keyboard.press('Control+End').catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.type(`\n\n第${i}次修改内容`, { delay: 5 });
        await page.waitForTimeout(700);
        await page.keyboard.press('Control+s');
        await page.waitForTimeout(4500);
        st = await readEd();
        console.log(`      第 ${i} 次保存后：storeLen=${st.storeLen}, dirty=${st.tabDirty}`);
      }

      // 直接查 API：云端是否真有 versions/<docId>/ 对象
      const docId = st.tabId;
      const vaultProbe = await page.evaluate(async (id) => {
        try {
          const r = await fetch(`/api/storage/list?prefix=${encodeURIComponent(`versions/${id}/`)}`, {
            headers: { authorization: `Bearer ${localStorage.getItem('neomd.access') || ''}` },
          });
          const j = await r.json();
          return { status: r.status, objects: (j?.data?.objects ?? []).map((o) => o.key) };
        } catch (e) {
          return { status: 0, error: String(e) };
        }
      }, docId);
      console.log(`      云端 versions/${docId}/ 对象数：${vaultProbe.objects?.length ?? 'n/a'}`);
      if (vaultProbe.objects?.length) console.log(`      对象：${fmt(vaultProbe.objects.slice(0, 5))}`);

      const opened = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((b) => /历史版本/.test(b.getAttribute('title') || ''));
        if (!btn) return false;
        btn.click();
        return true;
      });
      await page.waitForTimeout(4000);
      const hist = await page.evaluate(() => {
        const modal = document.querySelector('.nm-modal, [class*="modal"]');
        const scope = modal ?? document.body;
        return {
          hasModal: Boolean(modal),
          text: (scope.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          rows: scope.querySelectorAll('[class*="version"], [class*="history__item"], li').length,
          empty: /还没有历史版本/.test(scope.textContent || ''),
        };
      });
      s.step('打开历史版本面板', 'hasModal=true', `opened=${opened}, hasModal=${hist.hasModal}`, opened && hist.hasModal);
      s.step(
        '多次保存后历史面板有版本条目',
        'rows>=1 且不是空态',
        `rows=${hist.rows}, empty=${hist.empty}, 文本=${JSON.stringify(hist.text.slice(0, 200))}`,
        !hist.empty && hist.rows >= 1,
        hist.empty ? '保存了 3 次仍显示「还没有历史版本」' : '',
      );
      await auditShot(page, 'D3-history');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
} finally {
  console.log(`\n清理 ${tempDocs.size} 个临时文档…`);
  for (const docId of tempDocs) {
    const r = await page
      .evaluate(
        async ({ expr, id }) => {
          // eslint-disable-next-line no-eval
          const app = eval(expr);
          try {
            await app.deleteDoc(id);
            return { ok: true };
          } catch (e) {
            return { ok: false, reason: String(e?.message ?? e).slice(0, 100) };
          }
        },
        { expr: APP_STORE, id: docId },
      )
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e).slice(0, 100) }));
    console.log(`  删除 ${docId}: ${r.ok ? 'ok' : r.reason}`);
  }
  await page.waitForTimeout(3000);
  await browser.close().catch(() => {});
  assertZeroWrites('缺陷聚焦');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-defects.json');
  scenarioSummary();
}
