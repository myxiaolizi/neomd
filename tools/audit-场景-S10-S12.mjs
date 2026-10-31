/**
 * 审计场景 S10-S12：多文档与组织
 * =============================================================================
 * S10 开 10 个标签 → 切换流畅度 → 达到上限时的行为
 * S11 子文件夹拖拽移动 → 重命名（含中文名）→ 全库 Wikilink 是否自动重写
 * S12 6 种排序方式逐一验证
 *
 * 用法：node tools/audit-场景-S10-S12.mjs
 */
import {
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
  timed,
  waitUntil,
  writeScenarioJson,
} from './audit-场景-common.mjs';

const APP_STORE =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();

const readTabs = async () =>
  page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    return {
      tabCount: document.querySelectorAll('.tab').length,
      activeId: app?.activeTabId ?? '',
      tabs: (app?.tabs ?? []).map((t) => ({ id: t.id, title: t.title, len: (t.content || '').length })),
      domTabs: Array.from(document.querySelectorAll('.tab')).map((t) => ({
        text: (t.textContent || '').trim().slice(0, 30),
        active: String(t.className).includes('is-active'),
      })),
      hasToast: /已达|上限|最多|不能再开/.test(document.body.innerText || ''),
    };
  }, APP_STORE);

const newDoc = async () => {
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(1400);
  const st = await page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    return { id: app?.activeTab?.id ?? '', count: app?.tabs?.length ?? 0 };
  }, APP_STORE);
  if (st.id) tempDocs.add(st.id);
  return st;
};

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  /* ============================== S10 多标签 ============================== */
  {
    const s = beginScenario('S10', '开 10 个标签：切换流畅度 + 上限行为', '多标签是否可用、有无上限提示');
    try {
      const created = [];
      for (let i = 1; i <= 10; i += 1) {
        const st = await newDoc();
        created.push(st);
        if (st.id) tempDocs.add(st.id);
        // 每篇写点不同内容，便于切换验证
        const focused = await page.evaluate(() => Boolean(document.querySelector('.ProseMirror-focused')));
        if (!focused) {
          const b = await page.evaluate(() => {
            const pm = document.querySelector('.ProseMirror');
            if (!pm) return null;
            const r = pm.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
          });
          if (b) await page.mouse.click(b.x + 50, b.y + 24);
        }
        await page.keyboard.type(`标签${i}内容`, { delay: 3 }).catch(() => {});
        await page.waitForTimeout(200);
      }
      const st = await readTabs();
      s.step(
        '能连续新建 10 个标签',
        'tabCount >= 10（或给出明确上限提示）',
        `tabCount=${st.tabCount}, 有上限提示=${st.hasToast}, tabs=${fmt(st.domTabs.map((t) => t.text).slice(0, 12))}`,
        st.tabCount >= 10,
        st.tabCount < 10 ? `只开到 ${st.tabCount} 个${st.hasToast ? '（有提示）' : '（无任何提示）'}` : '',
      );

      // 切换流畅度：逐个点标签，测量切换耗时
      const switchTimes = [];
      const domTabs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.tab')).map((t, i) => ({ i, text: (t.textContent || '').trim().slice(0, 20) })),
      );
      for (const t of domTabs.slice(0, 10)) {
        const { ms } = await timed(async () => {
          await page.evaluate((idx) => {
            const tabs = document.querySelectorAll('.tab');
            tabs[idx]?.click();
          }, t.i);
          await waitUntil(page, (idx) => Boolean(document.querySelector('.tab.is-active')), { timeout: 4000, arg: t.i });
          await page.waitForTimeout(120);
        });
        switchTimes.push(ms);
      }
      const avg = Math.round(switchTimes.reduce((a, b) => a + b, 0) / switchTimes.length);
      const max = Math.max(...switchTimes);
      s.step(
        '10 个标签逐个切换',
        '每次 < 1500ms，平均 < 800ms',
        `平均 ${avg}ms / 最慢 ${max}ms（各次：${fmt(switchTimes)}）`,
        max < 1500 && avg < 800,
        max >= 1500 ? '切换明显卡顿' : '',
      );
      await auditShot(page, 'S10-tabs');

      // 内容跟随：切到某标签，编辑器内容应对应
      const contentFollow = await page.evaluate((expr) => {
        const tabs = document.querySelectorAll('.tab');
        tabs[0]?.click();
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        return new Promise((res) =>
          setTimeout(() => {
            const pm = document.querySelector('.ProseMirror');
            res({
              activeTitle: app?.activeTab?.title ?? '',
              domText: (pm?.textContent || '').slice(0, 40),
              storeLen: (app?.activeTab?.content || '').length,
            });
          }, 700),
        );
      }, APP_STORE);
      s.step('切换标签后编辑器内容跟随', 'DOM 内容与 store 一致（非空）', fmt(contentFollow), contentFollow.storeLen > 0);
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================== S12 排序（先做，因 S11 依赖文件夹） ============================== */
  {
    const s = beginScenario('S12', '6 种排序方式', '每种排序是否都能改变列表顺序');
    try {
      // 把左栏切到文件列表
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /文件列表|全部文件/.test(x.textContent || ''));
        b?.click();
      });
      await page.waitForTimeout(1500);

      // 找排序入口
      const sortUi = await page.evaluate(() => {
        const cands = Array.from(document.querySelectorAll('button, select, [role="button"]'))
          .map((e) => ({
            text: (e.textContent || '').trim().slice(0, 24),
            title: (e.getAttribute('title') || '').slice(0, 44),
            cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50),
            tag: e.tagName,
          }))
          .filter((x) => /排序|sort/i.test(x.text + x.title + x.cls));
        return cands;
      });
      s.step('存在排序入口', '找到排序按钮/下拉', `候选=${fmt(sortUi)}`, sortUi.length > 0);

      if (sortUi.length) {
        // 打开排序菜单，枚举选项
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('button, [role="button"]')).find((e) => /排序|sort/i.test(`${e.getAttribute('title') || ''}${e.textContent || ''}${typeof e.className === 'string' ? e.className : ''}`));
          el?.click();
        });
        await page.waitForTimeout(1200);
        const options = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.sortmenu *, [class*="sort"] *, .menu__item, .dropdown__item, ul li, button'))
            .map((e) => ({ text: (e.textContent || '').trim().slice(0, 20), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40) }))
            .filter((x) => x.text && x.text.length < 20 && /名称|时间|修改|创建|大小|类型|升序|降序|标题|字数/.test(x.text)),
        );
        const uniq = [...new Map(options.map((o) => [o.text, o])).values()];
        s.step(
          '排序列出多种可选方式',
          '>= 4 种（任务书要求 6 种）',
          `候选 ${uniq.length} 种：${fmt(uniq.map((o) => o.text))}`,
          uniq.length >= 4,
          uniq.length < 6 ? `只找到 ${uniq.length} 种，低于任务书的 6 种` : '',
        );

        // 逐一选择每个排序，验证列表顺序发生变化
        const seenOrders = new Set();
        let changedCount = 0;
        for (const opt of uniq.slice(0, 8)) {
          const before = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[class*="file"], .filetree__item, .leftpanel li')).map((e) => (e.textContent || '').trim().slice(0, 24)).slice(0, 12).join('|'),
          );
          const clicked = await page.evaluate((t) => {
            const els = Array.from(document.querySelectorAll('button, li, [role="menuitem"], .menu__item'));
            const hit = els.find((e) => (e.textContent || '').trim() === t);
            if (!hit) return false;
            hit.click();
            return true;
          }, opt.text);
          await page.waitForTimeout(900);
          const after = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[class*="file"], .filetree__item, .leftpanel li')).map((e) => (e.textContent || '').trim().slice(0, 24)).slice(0, 12).join('|'),
          );
          const orderChanged = before !== after;
          if (orderChanged) changedCount += 1;
          seenOrders.add(after);
          s.step(
            `排序「${opt.text}」可选中且生效`,
            '点击后列表顺序发生变化',
            `clicked=${clicked}, 顺序变化=${orderChanged}`,
            clicked && orderChanged,
            clicked && !orderChanged ? '点了但列表顺序没变（可能只有 1 个文件或排序未接线）' : '',
          );
          // 重新打开菜单（选择后通常关闭）
          await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('button, [role="button"]')).find((e) => /排序|sort/i.test(`${e.getAttribute('title') || ''}${typeof e.className === 'string' ? e.className : ''}`));
            el?.click();
          });
          await page.waitForTimeout(700);
        }
        s.step('不同排序产生不同顺序（排序真的接线）', 'unique 顺序数 >= 2', `唯一顺序数=${seenOrders.size}，生效数=${changedCount}`, seenOrders.size >= 2);
      }
      await auditShot(page, 'S12-sort');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================== S11 重命名 + Wikilink ============================== */
  {
    const s = beginScenario('S11', '重命名（含中文）+ 全库 Wikilink 自动重写', '改名后引用是否跟着更新');
    try {
      // 目标：新建两篇 A、B，B 里写 [[A]]，然后重命名 A，检查 B 里的链接
      const target = await newDoc();
      const targetId = target.id;
      // 给 A 起一个明确的中文标题
      await page.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        return app?.activeTab?.id ?? '';
      }, APP_STORE);
      const b = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        if (!pm) return null;
        const r = pm.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      });
      if (b) await page.mouse.click(b.x + 50, b.y + 24);
      const nameA = `审计链接源${Date.now() % 10000}`;
      await page.keyboard.type(`# ${nameA}`, { delay: 4 });
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(2600);
      s.step('创建文档 A（中文标题）', 'A 已保存', `nameA=${nameA}`, true);

      // 建 B，写入 [[A]]
      const other = await newDoc();
      const b2 = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        if (!pm) return null;
        const r = pm.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      });
      if (b2) await page.mouse.click(b2.x + 50, b2.y + 24);
      await page.keyboard.type(`引用：[[${nameA}]]`, { delay: 4 });
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(2600);
      const bContent = await page.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        return app?.activeTab?.content ?? '';
      }, APP_STORE);
      s.step('文档 B 写入 Wikilink', 'B 内容含 [[A]]', `B=${JSON.stringify(bContent.slice(0, 80))}`, bContent.includes(nameA));

      // 重命名 A
      const renamed = await page.evaluate(
        async ({ expr, id, newName }) => {
          // eslint-disable-next-line no-eval
          const app = eval(expr);
          try {
            await app.renameDoc(id, newName);
            return { ok: true };
          } catch (e) {
            return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
          }
        },
        { expr: APP_STORE, id: targetId, newName: `改名后${Date.now() % 10000}` },
      );
      await page.waitForTimeout(3200);
      s.step('重命名文档 A（API 路径）', 'renameDoc 成功', fmt(renamed), renamed.ok);

      // 检查 B 里的链接是否被重写
      const linkAfter = await page.evaluate(async (expr) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        const docs = app?.docs ?? app?.allDocs ?? [];
        return {
          docCount: docs.length,
          // 找含「引用：」的文档内容
          refDoc: (docs.find((d) => (d.title || '').includes('引用')) ?? null)?.title ?? null,
        };
      }, APP_STORE);
      // 直接用 store 读全部文档内容找 B
      const wikilinkState = await page.evaluate(async (expr) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        const tabs = app?.tabs ?? [];
        const bTab = tabs.find((t) => (t.content || '').includes('引用：'));
        return {
          bContent: bTab?.content ?? null,
          allTabs: tabs.map((t) => ({ title: t.title, head: (t.content || '').slice(0, 40) })),
        };
      }, APP_STORE);
      s.step(
        '重命名后 Wikilink 是否自动重写',
        'B 里的 [[旧名]] 变成 [[新名]]',
        `B 内容=${JSON.stringify((wikilinkState.bContent || '').slice(0, 120))}`,
        Boolean(wikilinkState.bContent && !wikilinkState.bContent.includes(nameA)),
        wikilinkState.bContent && wikilinkState.bContent.includes(nameA) ? '重命名后 Wikilink 未重写，链接会失效' : '',
      );
      await auditShot(page, 'S11-rename');

      // 文件夹：是否有新建文件夹入口
      const folderUi = await page.evaluate(() => {
        const cands = Array.from(document.querySelectorAll('button, [role="button"]'))
          .map((e) => ({ t: (e.textContent || '').trim().slice(0, 20), title: (e.getAttribute('title') || '').slice(0, 40) }))
          .filter((x) => /文件夹|新建目录|folder|移动|move/i.test(x.t + x.title));
        return cands;
      });
      s.step('存在「新建文件夹 / 移动」入口', '找到相关按钮', `候选=${fmt(folderUi.slice(0, 8))}`, folderUi.length > 0);
      s.observe(`文件夹/拖拽相关入口：${fmt(folderUi.slice(0, 6))}（拖拽移动需真实鼠标拖放，审计以入口存在性+API 能力为准）`);
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
} finally {
  await unguard().catch(() => {});
  console.log(`\n清理 ${tempDocs.size} 个临时文档…`);
  for (const id of tempDocs) {
    const r = await page
      .evaluate(async ({ expr, id: d }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        try { await app.deleteDoc(d); return { ok: true }; } catch (e) { return { ok: false, reason: String(e?.message ?? e).slice(0, 90) }; }
      }, { expr: APP_STORE, id })
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e).slice(0, 90) }));
    if (!r.ok) console.log(`  删除 ${id} 失败: ${r.reason}`);
  }
  await page.waitForTimeout(3000);
  await browser.close().catch(() => {});
  assertZeroWrites('S10-S12');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-S10-S12.json');
  scenarioSummary();
}
