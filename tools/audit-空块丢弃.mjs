/**
 * 确认：**空的代码块在保存时被静默丢弃**。
 * =============================================================================
 * 由 `audit-代码块边界.mjs` 推断出的条件：
 *  - A（空文档 + 空代码块 + 输入 code A）→ markdown 含围栏 ✓
 *  - B（列表后 + 空代码块 + 输入 code B）→ 含围栏 ✓
 *  - C（引用 + 空代码块 + 输入 code C + 表格）→ 含围栏 ✓
 *  - S4（引用 + **空代码块未输入内容** + 表格）→ **不含围栏** ✗
 *
 * 唯一差异：S4 的代码块插入后立刻离开、保持空。DOM 里它带 `is-empty` 类。
 * 本脚本用最小复现确认这一点，并顺带确认「空引用块 / 空表格」是否同样被丢。
 *
 * 用法：node tools/audit-空块丢弃.mjs
 */
import {
  BASE,
  assertZeroWrites,
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
const FENCE = String.fromCharCode(96, 96, 96);

const chromium = await loadChromium();
await login();
const baseline = await snapshotCloudBaseline();
const { page, browser } = await newSession(chromium, { settingsMode: 'fake', viewport: { width: 1600, height: 1000 } });
const unguard = await installWriteGuard(page, { log: false });
const tempDocs = new Set();

const read = async () =>
  page.evaluate((expr) => {
    const pm = document.querySelector('.ProseMirror');
    // eslint-disable-next-line no-eval
    const app = eval(expr);
    return {
      pre: pm?.querySelectorAll('pre').length ?? 0,
      preEmpty: pm?.querySelectorAll('pre.is-empty').length ?? 0,
      quote: pm?.querySelectorAll('blockquote').length ?? 0,
      table: pm?.querySelectorAll('table').length ?? 0,
      tabId: app?.activeTab?.id ?? '',
      content: app?.activeTab?.content ?? '',
      html: pm ? (pm.innerHTML || '').slice(0, 300) : '',
    };
  }, APP_STORE);

const focus = async () => {
  for (let i = 0; i < 3; i += 1) {
    const b = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      if (!pm) return null;
      const r = pm.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    });
    if (!b) return false;
    await page.mouse.click(b.x + Math.min(60, b.w / 4), b.y + 24);
    if (await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror-focused')), { timeout: 3000 })) return true;
    await sleep(250);
  }
  return false;
};

const tool = async (src) => {
  const ok = await page.evaluate((s) => {
    const re = new RegExp(s);
    const b = Array.from(document.querySelectorAll('.editorbar .tbtn')).find((x) => re.test(x.getAttribute('title') || ''));
    if (!b) return false;
    b.click();
    return true;
  }, src);
  await page.waitForTimeout(900);
  return ok;
};

const s = beginScenario('EB', '空块是否在保存时被丢弃', '插入后不填内容的代码块/引用/表格会不会消失');

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.shell__main', { timeout: 30000 });
  await page.waitForTimeout(2500);

  /* 空代码块：插入后立刻保存，不输入任何内容 */
  await page.keyboard.press('Control+n');
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  let st = await read();
  if (st.tabId) tempDocs.add(st.tabId);
  await focus();
  await page.keyboard.type('空代码块测试', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const inserted = await tool('代码块');
  st = await read();
  console.log(`\n      插入后：pre=${st.pre}, pre.is-empty=${st.preEmpty}`);
  console.log(`      DOM：${JSON.stringify(st.html.slice(0, 220))}`);
  s.step('插入空代码块后 DOM 里有 pre', 'pre>=1', `inserted=${inserted}, pre=${st.pre}, 其中 is-empty=${st.preEmpty}`, st.pre >= 1);
  s.step('空代码块带 is-empty 标记（说明编辑器知道它是空的）', 'preEmpty>=1', `preEmpty=${st.preEmpty}`, st.preEmpty >= 1);

  // 直接保存，不往代码块里输入
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(3400);
  st = await read();
  console.log(`\n      ===== 保存后 markdown（len=${st.content.length}）=====`);
  for (const line of st.content.split('\n')) console.log(`      | ${line.split(FENCE).join('[FENCE]')}`);
  console.log(`      =================================`);
  s.step(
    '空代码块保存后 markdown 仍含围栏',
    'content 含 ```',
    `含围栏=${st.content.includes(FENCE)}, len=${st.content.length}`,
    st.content.includes(FENCE),
    st.content.includes(FENCE) ? '' : '空代码块在保存时被静默丢弃（用户插入的块消失了）',
  );

  // 再保存一次（有内容变更）看是否仍丢
  await focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n追加一行', { delay: 4 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(3400);
  st = await read();
  s.step(
    '再次保存后空代码块仍未出现',
    '用于确认不是首次保存时序问题',
    `含围栏=${st.content.includes(FENCE)}, len=${st.content.length}`,
    st.content.includes(FENCE),
    st.content.includes(FENCE) ? '第二次保存后又出现了（时序问题）' : '持续丢失',
  );

  /* 对照：空引用块是否也丢 */
  await page.keyboard.press('Control+n');
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  st = await read();
  if (st.tabId) tempDocs.add(st.tabId);
  await focus();
  await page.keyboard.type('空引用块测试', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await tool('引用');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(3400);
  st = await read();
  s.step(
    '对照：空引用块保存后是否保留 `> `',
    '/^>\\s/m 为 true',
    `含 "> "=${/^>\s/m.test(st.content)}, md=${JSON.stringify(st.content.slice(0, 120))}`,
    /^>\s/m.test(st.content),
    /^>\s/m.test(st.content) ? '' : '空引用块同样被丢弃（与空代码块一致）',
  );

  /* 对照：空表格是否也丢 */
  await page.keyboard.press('Control+n');
  await waitUntil(page, () => Boolean(document.querySelector('.ProseMirror')), { timeout: 12000 });
  st = await read();
  if (st.tabId) tempDocs.add(st.tabId);
  await focus();
  await page.keyboard.type('空表格测试', { delay: 4 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await tool('插入表格');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(3400);
  st = await read();
  s.step(
    '对照：空表格保存后是否保留 `|`',
    'content 含 |',
    `含 "|"=${st.content.includes('|')}, md=${JSON.stringify(st.content.slice(0, 160))}`,
    st.content.includes('|'),
    st.content.includes('|') ? '' : '空表格被丢弃',
  );
} catch (e) {
  s.fail(String(e?.stack ?? e));
} finally {
  await unguard().catch(() => {});
  for (const id of tempDocs) {
    await page
      .evaluate(async ({ expr, id: d }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        try { await app.deleteDoc(d); return true; } catch { return false; }
      }, { expr: APP_STORE, id })
      .catch(() => {});
  }
  await page.waitForTimeout(2500);
  await browser.close().catch(() => {});
  assertZeroWrites('空块');
  await diffCloudBaseline(baseline);
  writeScenarioJson('scenarios-emptyblock.json');
  scenarioSummary();
}
