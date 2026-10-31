/**
 * 代码块序列化差异定位：为什么 D1 成功、S4 失败？
 * =============================================================================
 * 已知：
 *  - D1（`audit-缺陷聚焦.mjs`，settingsMode:'real'）：插入代码块 → 保存 →
 *    markdown **含** ```（已亲眼看到全文）。
 *  - S4（`audit-场景-S4-S9.mjs`，settingsMode:'fake'）：同样操作 → markdown
 *    **不含** ```，且重开后 pre=0。
 *
 * 差异候选：
 *  A) 文档已有内容（S4 先写了标题/正文/列表）才插入代码块 → 序列化边界出错；
 *  B) `settingsMode:'fake'` 导致某条设置差异（如 markdown 管道开关）→ 序列化不同；
 *  C) 插入代码块时**光标位置**不同：D1 在空段落、S4 在列表之后（仍在列表上下文里），
 *     导致插入的是「列表项内的代码块」，序列化时被丢弃/降级。
 *
 * 本脚本固定 settingsMode:'fake'（与 S4 一致），对比三种插入位置，抓 markdown 原文。
 *
 * 用法：node tools/audit-代码块边界.mjs
 */
import {
  BASE,
  assertZeroWrites,
  auditShot,
  beginScenario,
  fmt,
  installWriteGuard,
  loadChromium,
  login,
  newSession,
  scenarioSummary,
  sleep,
  waitUntil,
  writeScenarioJson,
  diffCloudBaseline,
  snapshotCloudBaseline,
} from './audit-场景-common.mjs';

const APP_STORE =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();

const readEd = async () =>
  page.evaluate((expr) => {
    const pm = document.querySelector('.ProseMirror');
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    return {
      hasPM: Boolean(pm),
      pre: pm?.querySelectorAll('pre').length ?? 0,
      li: pm?.querySelectorAll('li').length ?? 0,
      domHtml: pm ? (pm.innerHTML || '').slice(0, 400) : '',
      storeContent: app?.activeTab?.content ?? '',
      tabId: app?.activeTab?.id ?? '',
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
    if (await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror-focused')), { timeout: 3000 })) return true;
    await sleep(300);
  }
  return false;
};

const clickTool = async (src) => {
  const ok = await page.evaluate((s) => {
    const re = new RegExp(s);
    const btn = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((b) => re.test(b.getAttribute('title') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, src);
  await page.waitForTimeout(1000);
  return ok;
};

/** 打印 markdown 全文（带分隔线，便于肉眼核对） */
function dumpMd(tag, md) {
  console.log(`\n      ===== ${tag} markdown 全文（len=${md.length}）=====`);
  const FENCE = String.fromCharCode(96, 96, 96);
  for (const line of md.split('\n')) {
    const vis = line.split(FENCE).join('[FENCE]');
    console.log(`      | ${vis}`);
  }
  console.log(`      ===== 结束（含围栏=${md.includes(FENCE)}）=====`);
}

const s = beginScenario('CB', '代码块在不同插入位置的序列化', '定位 S4 代码块丢失的真实条件');

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const FENCE = String.fromCharCode(96, 96, 96);

  /* 场景 A：空文档直接插入代码块（复刻 D1） */
  {
    await page.keyboard.press('Control+n');
    await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
    let st = await readEd();
    if (st.tabId) tempDocs.add(st.tabId);
    await focusEditor();
    await page.keyboard.type('A 空文档', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await clickTool('代码块');
    st = await readEd();
    s.step('[A] 空文档后插入代码块：DOM pre=1', 'pre>=1', `pre=${st.pre}`, st.pre >= 1);
    await page.keyboard.type('code A', { delay: 4 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3400);
    st = await readEd();
    dumpMd('[A] 空文档', st.storeContent);
    s.step('[A] 保存后 markdown 含围栏', 'true', `含围栏=${st.storeContent.includes(FENCE)}`, st.storeContent.includes(FENCE));
  }

  /* 场景 B：先写列表，在列表后插入代码块（复刻 S4 顺序） */
  {
    await page.keyboard.press('Control+n');
    await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
    let st = await readEd();
    if (st.tabId) tempDocs.add(st.tabId);
    await focusEditor();
    await page.keyboard.type('B 列表后', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- 项1', { delay: 3 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('项2', { delay: 3 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // 跳出列表
    await page.waitForTimeout(400);
    st = await readEd();
    console.log(`\n      [B] 插入前 DOM：pre=${st.pre}, li=${st.li}`);
    const clicked = await clickTool('代码块');
    st = await readEd();
    s.step('[B] 列表后插入代码块：DOM pre=1', 'pre>=1', `clicked=${clicked}, pre=${st.pre}, html=${JSON.stringify(st.domHtml.slice(0, 200))}`, st.pre >= 1);
    await page.keyboard.type('code B', { delay: 4 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3400);
    st = await readEd();
    dumpMd('[B] 列表后', st.storeContent);
    s.step('[B] 保存后 markdown 含围栏', 'true', `含围栏=${st.storeContent.includes(FENCE)}, pre(DOM)=${st.pre}`, st.storeContent.includes(FENCE));
  }

  /* 场景 C：完整复刻 S4 —— 写入引用+代码块+表格后保存 */
  {
    await page.keyboard.press('Control+n');
    await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
    let st = await readEd();
    if (st.tabId) tempDocs.add(st.tabId);
    await focusEditor();
    await page.keyboard.type('C 全套结构', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await clickTool('引用');
    await page.keyboard.type('引用内容', { delay: 4 });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await clickTool('代码块');
    st = await readEd();
    console.log(`\n      [C] 代码块后：pre=${st.pre}，html=${JSON.stringify(st.domHtml.slice(0, 260))}`);
    await page.keyboard.type('code C', { delay: 4 });
    await page.waitForTimeout(400);
    await clickTool('插入表格');
    st = await readEd();
    console.log(`      [C] 表格后：pre=${st.pre}, table=${st.domHtml.includes('<table')}`);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3600);
    st = await readEd();
    dumpMd('[C] 引用+代码块+表格', st.storeContent);
    s.step('[C] 保存后 markdown 含围栏', 'true', `含围栏=${st.storeContent.includes(FENCE)}, pre(DOM)=${st.pre}`, st.storeContent.includes(FENCE));
    s.step('[C] 保存后 markdown 含引用标记 >', 'true', `含 "> "=${/^>\s/m.test(st.storeContent)}`, /^>\s/m.test(st.storeContent));
    s.step('[C] 保存后 markdown 含表格 |', 'true', `含 "|"=${st.storeContent.includes('|')}`, st.storeContent.includes('|'));
    await auditShot(page, 'CB-codeblock-boundary');
  }
} catch (e) {
  s.fail(String(e?.stack ?? e));
} finally {
  await unguard().catch(() => {});
  for (const id of tempDocs) {
    await page
      .evaluate(async ({ expr, id: docId }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        try { await app.deleteDoc(docId); return true; } catch { return false; }
      }, { expr: APP_STORE, id })
      .catch(() => {});
  }
  await page.waitForTimeout(2500);
  await browser.close().catch(() => {});
  assertZeroWrites('代码块边界');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-codeblock.json');
  scenarioSummary();
}
