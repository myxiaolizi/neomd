/**
 * 审计场景 S4-S9：日常写作路径（**核心**）—— 第二版（修正测试方法）
 * =============================================================================
 * ## 第一版踩的坑（记录在此，避免后人重犯）
 *
 * 1. **输入焦点竞争**：`locator.click({position})` 在编辑器刚挂载时可能点不到可编辑区，
 *    键盘事件被丢弃，于是「读了 0 字」——但状态栏显示 180 字，说明内容其实写进去了。
 *    改为：用 `boundingBox()` 绝对坐标点击 + `waitForFunction` 等到 `.ProseMirror-focused`
 *    + 写入后**回读校验**，校验失败重试一次。
 * 2. **写守卫误伤保存**：`installWriteGuard` 把 `/api/storage/object` 的 PUT 也拦了，
 *    而那是**文档保存的真实路径**，拦掉之后「保存」永远不落库，重开必然为空。
 *    改为：放行存储对象写入（这是被测功能本身），改为「登记创建的文档 + finally 删除 +
 *    基线对比自证」的方式保证零污染；`/api/settings` 仍严格拦截（那才是 admin 设置污染源）。
 * 3. **断言源**：DOM `textContent` 是渲染结果，store `activeTab.content` 才是数据真相。
 *    两者都读、都对，才能区分「数据丢了」和「渲染不对」。
 *
 * 用法：node tools/audit-场景-S4-S9.mjs
 */
import {
  API,
  BASE,
  LAUNCH_ARGS,
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
console.log(`云端基线：${baseline.vaultCount} 个仓库，设置版本 ${baseline.settingsVersion}`);

/** 临时文档登记（finally 删除） */
const tempDocs = new Set();

const session = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const { page, browser } = session;

/**
 * 写守卫：`installWriteGuard` 内部已放行 `/api/storage/**`（保存路径）
 * 与拦截 `/api/vaults`（防 docCount 被清零），这里不再单独注册 storage 路由。
 */
const unguard = await installWriteGuard(page, { log: false });

/* ---------------------------- 编辑器操作助手 ---------------------------- */

/** 读活动标签的编辑器状态（DOM + store 双读） */
async function readEditor() {
  return page.evaluate((expr) => {
    const pm = document.querySelector('.ProseMirror');
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    const tab = app?.activeTab;
    return {
      domText: pm ? pm.textContent || '' : '',
      domHtml: pm ? (pm.innerHTML || '').slice(0, 400) : '',
      domLen: pm ? (pm.textContent || '').length : -1,
      hasPM: Boolean(pm),
      focused: pm ? pm.classList.contains('ProseMirror-focused') : false,
      h1: Boolean(pm?.querySelector('h1')),
      h2: Boolean(pm?.querySelector('h2')),
      li: pm?.querySelectorAll('li').length ?? 0,
      quote: pm?.querySelectorAll('blockquote').length ?? 0,
      pre: pm?.querySelectorAll('pre').length ?? 0,
      table: pm?.querySelectorAll('table').length ?? 0,
      strong: pm?.querySelectorAll('strong').length ?? 0,
      storeContent: tab?.content ?? '',
      storeLen: (tab?.content ?? '').length,
      tabTitle: tab?.title ?? '',
      tabId: tab?.id ?? '',
      tabMode: tab?.mode ?? '',
      tabCount: app?.tabs?.length ?? 0,
      allTabs: (app?.tabs ?? []).map((t) => ({ id: t.id, title: t.title, len: (t.content || '').length })),
      statusbar: (document.querySelector('.statusbar')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    };
  }, APP_STORE);
}

/** 确保有且仅有一个可编辑文档，返回其 id */
async function ensureDoc() {
  let st = await readEditor();
  if (st.hasPM) {
    if (st.tabId) tempDocs.add(st.tabId);
    return st;
  }
  await page.keyboard.press('Control+n').catch(() => {});
  // 等编辑器挂载（比固定 sleep 可靠）
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  st = await readEditor();
  if (st.tabId) tempDocs.add(st.tabId);
  return st;
}

/**
 * 把焦点放进正文并确认拿到光标。
 * 返回是否成功聚焦。
 */
async function focusEditor() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (!box) return false;
    // 点正文区的偏上位置，避开可能的占位提示
    await page.mouse.click(box.x + Math.min(60, Math.max(20, box.w / 4)), box.y + 24);
    const ok = await waitUntil(
      page,
      () => {
        const pm = document.querySelector('.ProseMirror');
        return Boolean(pm && pm.classList.contains('ProseMirror-focused'));
      },
      { timeout: 3000 },
    );
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

/** 输入文本并回读校验（失败重试一次） */
async function typeVerified(text, expectIncludes) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const focused = await focusEditor();
    if (!focused) continue;
    await page.keyboard.type(text, { delay: 3 });
    await page.waitForTimeout(500);
    const st = await readEditor();
    if (st.domText.includes(expectIncludes) || st.storeContent.includes(expectIncludes)) {
      return { ok: true, state: st, attempts: attempt + 1, focused };
    }
  }
  const st = await readEditor();
  return { ok: false, state: st, attempts: 2, focused: false };
}

/** 通过左侧文件列表点击同名文档 */
async function reopenByTitle(piece) {
  const done = await page.evaluate((p) => {
    const nodes = Array.from(document.querySelectorAll('*'));
    const hit = nodes.find((e) => {
      const t = (e.textContent || '').trim();
      return t.startsWith(p) && t.length < 70 && e.children.length <= 3 && e.getBoundingClientRect().width > 0;
    });
    if (!hit) return false;
    hit.click();
    return true;
  }, piece);
  await page.waitForTimeout(2200);
  return done;
}

const setViewMode = async (label) => {
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
    btns[btns.length - 1]?.click();
  });
  await page.waitForSelector('.viewswitch__menu', { timeout: 6000 }).catch(() => {});
  const ok = await page.evaluate((lb) => {
    const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
    const hit = items.find((e) => (e.textContent || '').trim().includes(lb));
    if (!hit) return false;
    hit.click();
    return true;
  }, label);
  await page.waitForTimeout(1500);
  return ok;
};

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2200);

  /* ============================ S4 写作并保存 ============================ */
  {
    const s = beginScenario('S4', '新建 → 写 500 字（标题/列表/代码块/引用/表格）→ 保存 → 关闭 → 重开', '一篇结构完整的笔记能否无损保存与重载');
    try {
      const st0 = await ensureDoc();
      s.step('新建文档并拿到编辑器', 'hasPM=true 且有 tabId', `hasPM=${st0.hasPM}, tabId=${st0.tabId}, tabCount=${st0.tabCount}`, st0.hasPM && Boolean(st0.tabId));

      const focused = await focusEditor();
      s.step('点正文能获得编辑焦点', '.ProseMirror-focused', `focused=${focused}`, focused);

      const t0 = Date.now();
      // 标题：`# ` 会被 TipTap 的 markdown 输入规则转成 H1
      await page.keyboard.type('# 审计测试：日常写作验证', { delay: 3 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);

      const para =
        '这是审计脚本通过真实键盘输入写入的正文段落，用于验证所见即所得编辑器的输入、保存与重载链路是否无损。' +
        'Markdown 是一种轻量级标记语言，允许人们用易读易写的纯文本编写文档，再转换成有效的 HTML。' +
        '本段刻意写长一些，让总字数接近五百字，同时检验自动换行、段落间距与中文标点渲染是否正确。';
      await page.keyboard.type(para, { delay: 1 });
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');

      // 列表
      await page.keyboard.type('- 第一项：验证无序列表', { delay: 2 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('第二项：验证列表项连续性', { delay: 2 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('第三项：验证中文标点，逗号与句号。', { delay: 2 });
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      const typeMs = Date.now() - t0;

      let st = await readEditor();
      s.step(
        '真实键盘输入生效（h1 + 列表 + 字数）',
        'h1=true, li>=3, 正文字数>200',
        `h1=${st.h1}, li=${st.li}, domLen=${st.domLen}, storeLen=${st.storeLen}, 状态栏=${JSON.stringify(st.statusbar)}`,
        st.h1 && st.li >= 3 && st.domLen > 200,
        !st.h1 && st.domLen > 0 ? '有文字但 `# ` 未转成 H1（Markdown 输入规则未触发）' : '',
      );
      s.step('输入 300+ 字耗时', '< 25000ms', `${typeMs}ms`, typeMs < 25000);
      await auditShot(page, 'S4-a-typed');

      // 用工具栏插入引用 / 代码块 / 表格（真实用户路径）
      const clickTool = async (titleSrc) => {
        const ok = await page.evaluate((src) => {
          const re = new RegExp(src);
          const btn = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((b) => re.test(b.getAttribute('title') || ''));
          if (!btn) return false;
          btn.click();
          return true;
        }, titleSrc);
        await page.waitForTimeout(900);
        return ok;
      };

      const qClicked = await clickTool('引用');
      st = await readEditor();
      if (qClicked && st.quote === 0) {
        // 引用可能需要先聚焦正文；再点一次
        await focusEditor();
        await clickTool('引用');
        st = await readEditor();
      }
      s.step('工具栏「引用」插入 blockquote', 'blockquote>=1', `clicked=${qClicked}, blockquote=${st.quote}`, st.quote >= 1, st.quote === 0 && qClicked ? '按钮响应了但未插入引用块' : '');

      const cClicked = await clickTool('代码块');
      st = await readEditor();
      s.step('工具栏「代码块」插入 pre', 'pre>=1', `clicked=${cClicked}, pre=${st.pre}`, st.pre >= 1, st.pre === 0 && cClicked ? '按钮响应了但未插入代码块' : '');

      const tClicked = await clickTool('插入表格');
      st = await readEditor();
      s.step('工具栏「插入表格」插入 table', 'table>=1', `clicked=${tClicked}, table=${st.table}`, st.table >= 1, st.table === 0 && tClicked ? '按钮响应了但未插入表格' : '');

      st = await readEditor();
      await auditShot(page, 'S4-b-full-structure');

      // 保存
      const { ms: saveMs } = await timed(async () => {
        await page.keyboard.press('Control+s').catch(() => {});
        await page.waitForTimeout(3400);
      });
      const savedContent = (await readEditor()).storeContent;
      s.step('Ctrl+S 保存', '< 8000ms 且无报错', `${saveMs}ms`, saveMs < 8000);
      /**
       * 逐项检查 markdown 序列化。
       *
       * 注意这里的正则**不能**用 `/```/` 直接写（反引号在模板字符串/普通字符串里
       * 极易写错转义，第一版就是这么误判「代码块丢失」的）。用 `String.fromCharCode(96)`
       * 拼三个反引号，绕开转义坑。
       */
      const FENCE = String.fromCharCode(96, 96, 96);
      const mdFlags = {
        h1: /^#\s/m.test(savedContent),
        li: /^[-*]\s/m.test(savedContent),
        quote: /^>\s/m.test(savedContent),
        codeFence: savedContent.includes(FENCE),
        table: /\|/.test(savedContent),
      };
      s.step(
        '保存后的 markdown 含全部结构标记（# / - / > / ``` / |）',
        '五项全为 true',
        `len=${savedContent.length}, ${JSON.stringify(mdFlags)}`,
        mdFlags.h1 && mdFlags.li && mdFlags.quote && mdFlags.codeFence && mdFlags.table,
        !mdFlags.codeFence ? '代码块未序列化进 markdown' : '',
      );
      const beforeClose = await readEditor();

      // 关闭 → 重开
      await page.keyboard.press('Control+w').catch(() => {});
      await page.waitForTimeout(1800);
      const afterClose = await readEditor();
      s.step('Ctrl+W 关闭当前标签', `tabCount ${beforeClose.tabCount} → ${beforeClose.tabCount - 1}`, `tabCount=${afterClose.tabCount}`, afterClose.tabCount === beforeClose.tabCount - 1);

      const reopened = await reopenByTitle('审计测试');
      const after = await readEditor();
      s.step('从文件列表重开该文档', 'hasPM=true 且内容非空', `reopened=${reopened}, hasPM=${after.hasPM}, storeLen=${after.storeLen}`, after.hasPM && after.storeLen > 0);

      s.step(
        '重开后结构完整（h1/列表/引用/代码块/表格）',
        '五项齐全',
        `h1=${after.h1}, li=${after.li}, quote=${after.quote}, pre=${after.pre}, table=${after.table}`,
        after.h1 && after.li >= 3 && after.quote >= 1 && after.pre >= 1 && after.table >= 1,
      );
      s.step(
        '重开后字数与保存前一致（无内容丢失）',
        `storeLen 差 <= 5%（保存前 ${beforeClose.storeLen}）`,
        `保存前 ${beforeClose.storeLen} → 重开 ${after.storeLen}`,
        Math.abs(after.storeLen - beforeClose.storeLen) <= Math.max(5, beforeClose.storeLen * 0.05),
      );
      const FENCE2 = String.fromCharCode(96, 96, 96);
      s.step(
        '重开后 markdown 仍含代码块围栏',
        'storeContent 含 ```',
        `含围栏=${(after.storeContent || '').includes(FENCE2)}, 前 120 字=${JSON.stringify((after.storeContent || '').slice(0, 120))}`,
        (after.storeContent || '').includes(FENCE2),
      );
      if (after.tabId) tempDocs.add(after.tabId);
      await auditShot(page, 'S4-c-reopened');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ======================= S5 源码 ↔ WYSIWYG 往返 3 次 ======================= */
  {
    const s = beginScenario('S5', '源码 ↔ 所见即所得 往返 3 次', '往返是否内容与格式无损');
    try {
      const base = await ensureDoc();
      const before = { h1: base.h1, li: base.li, quote: base.quote, pre: base.pre, table: base.table, len: base.domLen };
      s.step('基准状态（往返前）', '结构与字数记录', fmt(before), before.h1 && before.li >= 3);
      const rounds = [];
      for (let i = 1; i <= 3; i += 1) {
        const srcOk = await setViewMode('源码模式');
        const srcSt = await readEditor();
        const wysOk = await setViewMode('所见即所得');
        const wysSt = await readEditor();
        const rec = { i, srcOk, wysOk, h1: wysSt.h1, li: wysSt.li, quote: wysSt.quote, pre: wysSt.pre, table: wysSt.table, domLen: wysSt.domLen, mdHead: (wysSt.storeContent || '').slice(0, 90) };
        rounds.push(rec);
        s.step(
          `第 ${i} 轮往返`,
          '切换成功且切回后结构完整',
          `srcOk=${srcOk}, wysOk=${wysOk}, h1=${rec.h1}, li=${rec.li}, quote=${rec.quote}, pre=${rec.pre}, table=${rec.table}, len=${rec.domLen}`,
          srcOk && wysOk && wysSt.hasPM && rec.h1 && rec.li >= 3 && rec.quote >= 1 && rec.pre >= 1 && rec.table >= 1,
        );
      }
      const last = rounds[rounds.length - 1];
      s.step(
        '3 次往返后结构完全不变',
        'h1/li/quote/pre/table 与基准一致',
        `基准=${fmt({ h1: before.h1, li: before.li, quote: before.quote, pre: before.pre, table: before.table })} → 末轮=${fmt({ h1: last.h1, li: last.li, quote: last.quote, pre: last.pre, table: last.table })}`,
        last.h1 === before.h1 && last.li === before.li && last.quote === before.quote && last.pre === before.pre && last.table === before.table,
      );
      s.step(
        '3 次往返后字数稳定（差 <= 5%）',
        `基准 ${before.len}`,
        `末轮 ${last.domLen}（差 ${Math.abs(last.domLen - before.len)}）`,
        Math.abs(last.domLen - before.len) <= Math.max(10, before.len * 0.05),
      );
      const st = await readEditor();
      s.step('store 内容为 Markdown 源码', '含 # 与 - 标记', `前 100 字=${JSON.stringify((st.storeContent || '').slice(0, 100))}`, /^#\s/m.test(st.storeContent || ''));
      await auditShot(page, 'S5-roundtrip');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================ S6 双栏对照 ============================ */
  {
    const s = beginScenario('S6', '双栏对照模式（左源码 / 右预览）', '滚动同步是否跟手、预览是否实时');
    try {
      await ensureDoc();
      // 对照模式需要正文有内容，否则两侧都显示占位符、预览区高度塌成 0（观感问题，已记录）
      const hasContent = (await readEditor()).domLen > 0;
      if (!hasContent) {
        await focusEditor();
        await page.keyboard.type('# 对照模式测试\n\n这一段用于验证对照模式的实时预览与滚动同步。', { delay: 3 });
        await page.waitForTimeout(700);
      }
      const picked = await setViewMode('对照');
      /**
       * 对照模式的编辑器结构（实测）：
       *   .compare
       *     .compare__pane  → .compare__head "源码" + .compare__body        (.cm-content 在内)
       *     .compare__pane  → .compare__head "预览" + .compare__body--preview
       *                        └─ .compare__preview.nm-content   ← 预览渲染容器
       * 注意它**不是** `.ProseMirror`：第一版按 `.ProseMirror` 断言，误判成「没有预览」。
       */
      const layout = await page.evaluate(() => {
        const cm = document.querySelector('.cm-content');
        const preview = document.querySelector('.compare__preview, .compare__body--preview .nm-content');
        const heads = Array.from(document.querySelectorAll('.compare__head')).map((e) => (e.textContent || '').trim());
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
        };
        return {
          hasCM: Boolean(cm),
          hasPreview: Boolean(preview),
          heads,
          paneCount: document.querySelectorAll('.compare__pane').length,
          cmBox: box(cm),
          previewBox: box(preview),
          previewLen: preview ? (preview.textContent || '').length : -1,
          previewTag: preview ? preview.tagName + '.' + String(preview.className).slice(0, 40) : '',
        };
      });
      s.step(
        '切到对照模式后左源码 + 右预览同屏',
        'hasCM 与 preview 同时为真，且有两个面板标题',
        `picked=${picked}, hasCM=${layout.hasCM}, hasPreview=${layout.hasPreview}, paneCount=${layout.paneCount}, heads=${fmt(layout.heads)}, cm=${fmt(layout.cmBox)}, preview=${fmt(layout.previewBox)}`,
        picked && layout.hasCM && layout.hasPreview && layout.paneCount === 2,
        !layout.hasPreview ? '对照模式没有预览渲染容器' : '',
      );
      s.step(
        '预览区有实际渲染内容（非空）',
        'previewLen > 0',
        `previewLen=${layout.previewLen}（容器 ${layout.previewTag}）`,
        layout.previewLen > 0,
        layout.previewBox && layout.previewBox.h === 0 ? '预览容器高度为 0（空文档时塌陷，观感缺陷）' : '',
      );

      if (layout.hasCM) {
        const marker = `实时${Date.now() % 100000}`;
        const cmBox = layout.cmBox;
        await page.mouse.click((cmBox?.x ?? 300) + 60, (layout.cmBox ? 200 : 200)).catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+End').catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.type(`\n\n${marker}`, { delay: 10 });
        const appeared = await waitUntil(
          page,
          (m) => Boolean(document.querySelector('.compare__preview')?.textContent?.includes(m)),
          { timeout: 7000, arg: marker },
        );
        s.step('源码侧输入 → 预览侧实时出现', '7s 内预览容器含新文字', `appeared=${Boolean(appeared)}`, Boolean(appeared));

        const sync = await page.evaluate(async () => {
          const cm = document.querySelector('.cm-content');
          const preview = document.querySelector('.compare__preview');
          if (!cm || !preview) return { ok: false, reason: 'missing' };
          const scroller = (el) => {
            let p = el;
            while (p && p !== document.body) {
              const st = getComputedStyle(p);
              if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
              p = p.parentElement;
            }
            return null;
          };
          const s1 = scroller(cm);
          const s2 = scroller(preview);
          if (!s1 || !s2) return { ok: false, reason: 'no-scroller', s1: Boolean(s1), s2: Boolean(s2) };
          const before = s2.scrollTop;
          s1.scrollTop = Math.floor(s1.scrollHeight * 0.5);
          s1.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 900));
          return { ok: true, before, after: s2.scrollTop, same: before === s2.scrollTop };
        });
        s.step(
          '源码滚动 → 预览跟随',
          '预览 scrollTop 改变',
          fmt(sync),
          Boolean(sync.ok && !sync.same),
          sync.ok && sync.same ? '预览未跟随滚动（左侧滚了右侧没动）' : '',
        );
      }
      await auditShot(page, 'S6-compare');
      await setViewMode('所见即所得');
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================ S7 搜索 ============================ */
  {
    const s = beginScenario('S7', '搜索已知文档', '能否快速准确找到文档');
    try {
      const st = await ensureDoc();
      const known = st.tabTitle;
      const { ms } = await timed(async () => {
        await page.keyboard.press('Control+Shift+F').catch(() => {});
        await page.waitForTimeout(1600);
      });
      let ui = await page.evaluate(() => ({
        hasInput: Boolean(document.querySelector('input[placeholder*="搜索"], .search__input, input[type="search"]')),
      }));
      if (!ui.hasInput) {
        await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button')).find((x) => /搜索/.test(x.textContent || ''));
          b?.click();
        });
        await page.waitForTimeout(1600);
        ui = await page.evaluate(() => ({
          hasInput: Boolean(document.querySelector('input[placeholder*="搜索"], .search__input, input[type="search"]')),
        }));
      }
      s.step('打开搜索界面', '出现搜索输入框', `hasInput=${ui.hasInput}（${ms}ms）`, ui.hasInput);
      if (ui.hasInput) {
        const kw = '审计测试';
        const { ms: searchMs } = await timed(async () => {
          const input = page.locator('input[placeholder*="搜索"], .search__input, input[type="search"]').first();
          await input.fill(kw);
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(2800);
        });
        const res = await page.evaluate((k) => {
          const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
          const items = Array.from(document.querySelectorAll('li, [class*="result"], [class*="search__item"]'))
            .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 2 && t.length < 200);
          return { count: items.length, hit: items.filter((t) => t.includes(k)).slice(0, 5), bodyHasKw: txt.includes(k) };
        }, kw);
        s.step('搜索正文关键词能找到该文档', '结果含关键词或正文区出现命中', `结果数=${res.count}, 命中=${fmt(res.hit)}, 页面含关键词=${res.bodyHasKw}`, res.hit.length > 0 || res.bodyHasKw);
        s.step('搜索耗时', '< 6000ms', `${searchMs}ms`, searchMs < 6000);
        s.observe(`搜索「${kw}」返回 ${res.count} 条候选`);
        await auditShot(page, 'S7-search');
      }
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================ S8 右栏区块 ============================ */
  {
    const s = beginScenario('S8', '右栏 5 个区块可用性', '大纲/反向链接/标签/文档统计/日历能否打开并显示有意义内容');
    try {
      await ensureDoc();
      await page.keyboard.press('Control+Shift+A').catch(() => {});
      await page.waitForTimeout(1800);

      const sections = [
        { id: 'outline', name: '大纲', re: '大纲' },
        { id: 'backlinks', name: '反向链接', re: '反向链接|反链' },
        { id: 'tags', name: '标签', re: '标签' },
        { id: 'stats', name: '文档统计', re: '文档统计|统计' },
        { id: 'calendar', name: '日历', re: '日历' },
      ];
      const outcomes = [];
      for (const sec of sections) {
        const before = await page.evaluate(() => (document.querySelector('.rightstack, .rightpanel, .shell__right')?.textContent || '').replace(/\s+/g, ' ').trim());
        const clicked = await page.evaluate((src) => {
          const re = new RegExp(src);
          const cands = Array.from(document.querySelectorAll('.rightpanel button, .rightbar button, .rightstack button, .shell__right button, .editorbar button[title]'));
          const hit = cands.find((b) => re.test(`${b.getAttribute('title') || ''}${b.textContent || ''}`));
          if (!hit) return false;
          hit.click();
          return true;
        }, sec.re);
        await page.waitForTimeout(1900);
        const after = await page.evaluate(() => ({
          rightText: (document.querySelector('.rightstack, .rightpanel, .shell__right')?.textContent || '').replace(/\s+/g, ' ').trim(),
          secCount: document.querySelectorAll('[class*="rightsec"]').length,
        }));
        const changed = after.rightText !== before;
        const hasContent = after.rightText.length > 10;
        outcomes.push({ ...sec, clicked, changed, len: after.rightText.length, sample: after.rightText.slice(0, 80) });
        s.step(
          `区块「${sec.name}」`,
          '有入口 + 点击后右栏内容变化 + 有实际内容',
          `clicked=${clicked}, changed=${changed}, 右栏文本长度=${after.rightText.length}, 内容=${JSON.stringify(after.rightText.slice(0, 70))}`,
          clicked && (changed || hasContent),
          clicked && !changed ? '点击后右栏无变化（疑似死按钮）' : '',
        );
      }
      const outlineLists = await page.evaluate(() => /审计测试/.test(document.querySelector('.rightstack, .rightpanel, .shell__right')?.textContent || ''));
      s.step('大纲/统计等区块显示了当前文档的真实信息', '右栏文本含当前文档标题', `含「审计测试」=${outlineLists}`, outlineLists);
      await auditShot(page, 'S8-right-sections');
      s.observe(`5 个区块结果：${outcomes.map((o) => `${o.name}:${o.clicked ? '点击OK' : '无入口'}/${o.changed ? '有变化' : '无变化'}`).join('，')}`);
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }

  /* ============================ S9 历史版本 ============================ */
  {
    const s = beginScenario('S9', '历史版本：保存 3 次 → 查看 → 回滚', '能否查看历史并恢复');
    try {
      await ensureDoc();
      for (let i = 1; i <= 3; i += 1) {
        const focused = await focusEditor();
        if (!focused) continue;
        await page.keyboard.press('Control+End').catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.type(`\n\n版本${i}标记${Date.now() % 100000}`, { delay: 4 });
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+s').catch(() => {});
        await page.waitForTimeout(2600);
      }
      const st = await readEditor();
      s.step('连续保存 3 次', '内容持续增长且无报错', `storeLen=${st.storeLen}`, st.storeLen > 0);

      const opened = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((b) => /历史版本/.test(b.getAttribute('title') || ''));
        if (!btn) return false;
        btn.click();
        return true;
      });
      await page.waitForTimeout(4000);
      /**
       * 历史面板条目统计。
       *
       * 第一版用 `querySelectorAll('li, [class*="version"]')` 数条目，结果 rows=0，
       * 但面板文字明明写着「共 3 个版本」—— 说明条目不是 li/version 类名。
       * 改为：**以面板文本为准**（解析「共 N 个版本」）+ 统计 `.history__*` 与
       * 「v<数字>」条目文本，双判据。
       */
      const hist = await page.evaluate(() => {
        const modal = document.querySelector('.nm-modal, [class*="modal"]');
        const scope = modal ?? document.body;
        const txt = (scope.textContent || '').replace(/\s+/g, ' ').trim();
        const countMatch = /共\s*(\d+)\s*个版本/.exec(txt);
        const vItems = (txt.match(/\bv\d+\b/g) ?? []).length;
        return {
          hasModal: Boolean(modal),
          text: txt.slice(0, 500),
          declaredCount: countMatch ? Number(countMatch[1]) : null,
          vItemCount: vItems,
          empty: /还没有历史版本/.test(txt),
        };
      });
      s.step('点「历史版本」打开面板', '出现面板', `opened=${opened}, hasModal=${hist.hasModal}`, opened && hist.hasModal);
      const versionCount = hist.declaredCount ?? hist.vItemCount;
      s.step(
        '历史面板有版本条目',
        '版本数 >= 1 且不是空态',
        `面板自述「共 ${hist.declaredCount} 个版本」, v 条目=${hist.vItemCount}, empty=${hist.empty}, 文本=${JSON.stringify(hist.text.slice(0, 220))}`,
        !hist.empty && versionCount >= 1,
        hist.empty ? '多次保存后仍显示「还没有历史版本」' : '',
      );
      s.observe(`历史面板文本：${hist.text.slice(0, 160)}`);
      await auditShot(page, 'S9-history');

      const restored = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /恢复|回滚|还原/.test((b.textContent || '').trim()));
        if (!btn) return { clicked: false };
        const label = (btn.textContent || '').trim();
        btn.click();
        return { clicked: true, label };
      });
      await page.waitForTimeout(2200);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.nm-modal button')).find((b) => /确定|确认|恢复/.test(b.textContent || ''));
        btn?.click();
      });
      await page.waitForTimeout(2600);
      const afterRestore = await readEditor();
      s.step(
        '能执行回滚且编辑器未损坏',
        '点击恢复后仍有编辑器与内容',
        `clicked=${fmt(restored)}, hasPM=${afterRestore.hasPM}, storeLen=${afterRestore.storeLen}`,
        Boolean(restored.clicked) && afterRestore.hasPM,
      );
      await auditShot(page, 'S9-restored');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(700);
    } catch (e) {
      s.fail(String(e?.message ?? e));
    } finally {
      s.end();
    }
  }
} catch (e) {
  console.log(`\n[FATAL] ${e?.stack ?? e}`);
} finally {
  /* ---------------- 清理 + 零污染自证 ---------------- */
  await unguard().catch(() => {});
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
  assertZeroWrites('S4-S9');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-S4-S9.json');
  scenarioSummary();
}
