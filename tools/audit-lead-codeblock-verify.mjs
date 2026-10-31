
/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
/**
 * Lead 亲自复现：代码块保存后重开是否丢失（审计组 D1 报的 partial）。
 *
 * ## 为什么要 Lead 亲自验
 *
 * 「保存后重开内容丢失」是**数据丢失级**缺陷 —— 如果成立，优先级高于本次审计的
 * 所有性能与体验建议。但审计脚本报的 `reopened=false, pre=0` 也可能是
 * **脚本自身切标签/重开的时机问题**（1.4.0 期间我们多次踩到「断言写错而不是产品坏」）。
 *
 * 因此这里用**最小、可人工复核**的路径重做一遍：
 *   1. 新建文档 → 插入代码块 → 输入代码
 *   2. 读 store 里的 content（markdown）—— 应含 ``` 围栏
 *   3. 显式保存（等待落盘）
 *   4. 关闭标签 → 从文档列表重新打开同一篇
 *   5. 读 store content + DOM
 *   6. 额外：直接调 vault API 读磁盘上的文件字节（绕开前端）
 *
 * 第 6 步是关键 —— 它能区分「数据真的没存」与「存了但前端没渲染」。
 *
 * 用法：node tools/audit-lead-codeblock-verify.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import fs from 'node:fs';

const { chromium } = playwright;
const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER = process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = requireAuditPass();
const APP = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    args: ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const apiCalls = [];
  page.on('request', (r) => {
    if (/\/api\/(settings|vaults|storage)/.test(r.url()) && r.method() !== 'GET') {
      apiCalls.push(`${r.method()} ${r.url().split('/api/')[1]}`);
    }
  });

  const out = { steps: [], conclusion: null, title: null, docId: null };
  const step = (name, expect, actual, ok, note = '') => {
    out.steps.push({ name, expect: String(expect), actual: String(actual), ok, note });
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}`);
    console.log(`        期望: ${expect}`);
    console.log(`        实际: ${actual}${note ? `（${note}）` : ''}`);
  };

  try {
    // 登录
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    const needLogin = await page.evaluate(() => !localStorage.getItem('neomd.access'));
    if (needLogin) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('input', { timeout: 15000 });
      const inputs = page.locator('input');
      await inputs.nth(0).fill(USER);
      await inputs.nth(1).fill(PASS);
      await page.keyboard.press('Enter');
      await sleep(4000);
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3000);
    }

    const title = `QA-LEDGER-CB-${Date.now()}`;
    out.title = title;

    // 1. 新建文档
    const created = await page.evaluate(
      async ({ expr, t }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        await app.createDoc({ title: t, content: '# 代码块测试\n\n前置段落。\n' });
        await new Promise((r) => setTimeout(r, 2500));
        const tab = (app.tabs || []).find((x) => (x.title || '').includes('QA-LEDGER-CB'));
        return { ok: Boolean(tab), docId: tab?.docId ?? null, tabId: tab?.id ?? null };
      },
      { expr: APP, t: title },
    );
    out.docId = created.docId;
    step('新建文档成功', 'docId 非空', `docId=${created.docId}`, Boolean(created.docId));

    // 2. 让编辑器拿到焦点并切到源码模式写入代码块（最可控的写法）
    await sleep(1200);
    const wrote = await page.evaluate(
      async ({ expr }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        const tab = (app.tabs || []).find((x) => (x.title || '').includes('QA-LEDGER-CB'));
        if (!tab) return { ok: false };
        const md = '# 代码块测试\n\n前置段落。\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\n后置段落。\n';
        tab.content = md;
        tab.dirty = true;
        await new Promise((r) => setTimeout(r, 400));
        // 走产品的保存入口，而不是直接写 store
        await app.saveActiveTab?.();
        await new Promise((r) => setTimeout(r, 3000));
        const after = (app.tabs || []).find((x) => x.docId === tab.docId);
        return { ok: true, contentAfterSave: String(after?.content ?? '') };
      },
      { expr: APP },
    );
    const savedHasFence = /```/.test(wrote.contentAfterSave || '');
    step(
      '插入代码块 fenced markdown 并保存',
      '保存后 store.content 含 ``` 围栏',
      `含围栏=${savedHasFence}, 长度=${(wrote.contentAfterSave || '').length}`,
      savedHasFence,
    );

    // 3. 绕开前端直接读仓库里的文件（区分「没存」与「没渲染」）
    const onDisk = await page.evaluate(
      async ({ expr, docId }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        /*
         * 方法名必须用 vault 真实导出的 `read(docId)` / `readByPath(path)`。
         * 首轮我写了 `readText`（不存在）→ 抛 TypeError → 被 catch 成
         * `{ok:false}`，于是脚本误判成「磁盘上也没有」= 真数据丢失。
         * **这正是「验证脚本自身出错被当成产品缺陷」的典型**：
         * 一个不存在的方法名，差点让我们去修一条根本不存在的保存链路 bug。
         * 所以这里先探测方法是否存在，不存在就明确报出来，绝不静默当成失败。
         */
        if (typeof app.vault?.read !== 'function') {
          const names = app.vault ? Object.getOwnPropertyNames(Object.getPrototypeOf(app.vault)) : [];
          return { ok: false, reason: `vault.read 不存在；实际方法：${names.filter((n) => /read|get|load/i.test(n)).join(',')}` };
        }
        try {
          const doc = (app.docs || []).find((d) => d.docId === docId);
          if (!doc) return { ok: false, reason: 'docs 里找不到该文档' };
          const text = await app.vault.read(docId);
          return { ok: true, text, path: doc.path };
        } catch (e) {
          return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
        }
      },
      { expr: APP, docId: created.docId },
    );
    const diskHasFence = onDisk.ok && /```/.test(onDisk.text || '');
    step(
      '磁盘/仓库文件含代码块围栏（绕开前端读）',
      '读到的原始文本含 ```',
      onDisk.ok ? `含围栏=${diskHasFence}, path=${onDisk.path}, 长度=${(onDisk.text || '').length}` : `读取失败：${onDisk.reason}`,
      diskHasFence,
      '这一步是判定的关键：磁盘有=前端渲染问题；磁盘无=真数据丢失',
    );

    // 4. 关闭标签后重新打开
    const reopened = await page.evaluate(
      async ({ expr, docId }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        const tab = (app.tabs || []).find((x) => x.docId === docId);
        if (tab) {
          app.closeTab?.(tab.id);
          await new Promise((r) => setTimeout(r, 1200));
        }
        await app.openDoc(docId);
        await new Promise((r) => setTimeout(r, 3500));
        const t2 = (app.tabs || []).find((x) => x.docId === docId);
        return { content: String(t2?.content ?? ''), tabs: (app.tabs || []).length };
      },
      { expr: APP, docId: created.docId },
    );
    const reopenHasFence = /```/.test(reopened.content || '');
    step(
      '关闭后重新打开，内容仍含代码块',
      'store.content 含 ```',
      `含围栏=${reopenHasFence}, 长度=${reopened.content.length}`,
      reopenHasFence,
    );

    // 5. DOM 里是否有 <pre>
    await sleep(1500);
    const dom = await page.evaluate(() => ({
      pre: document.querySelectorAll('.ProseMirror pre, .nm-content pre, .cm-content').length,
      bodyText: (document.querySelector('.ProseMirror')?.innerText || '').slice(0, 200),
    }));
    step(
      '重开后 DOM 里有代码块渲染',
      '<pre> 数量 >= 1',
      `pre/cm=${dom.pre}，正文前 200 字="${dom.bodyText.replace(/\n/g, '\\n')}"`,
      dom.pre >= 1,
    );

    // 结论
    /*
     * 三态判定（必须区分开，否则会得出反向结论）：
     *   diskHas = true  且 reopenHas = true  → 数据完好；DOM 无 pre 只是渲染问题
     *   diskHas = true  且 reopenHas = false → 存了但重开读不出 → 前端加载/解析层
     *   diskHas = false                      → 真数据丢失（且必须确认读取本身成功）
     *
     * 特别注意：`onDisk.ok === false` 表示**读取失败**，不能当成「磁盘上没内容」。
     * 首轮就因为 readText 方法不存在导致误判，这里显式区分。
     */
    let conclusion;
    if (!onDisk.ok) {
      conclusion = `**无法判定**：绕开前端读取失败（${onDisk.reason}）—— 这是脚本问题，不是产品结论`;
    } else if (diskHasFence && reopenHasFence) {
      conclusion = '数据完好：磁盘与重开后的 store 都含代码块（若 DOM 无 pre 则为渲染层问题）';
    } else if (diskHasFence) {
      conclusion = '数据在磁盘上，但重开后前端没读出来 —— 前端加载/解析层缺陷';
    } else {
      conclusion = '**真数据丢失**：磁盘上也没有代码块 —— 保存链路吞掉了代码块';
    }
    out.conclusion = conclusion;
    out.diskOk = onDisk.ok;
    console.log(`\n结论：${conclusion}`);

    // 清理临时文档
    const cleaned = await page.evaluate(
      async ({ expr, docId }) => {
        // eslint-disable-next-line no-eval
        const app = eval(expr);
        try {
          await app.deleteDoc?.(docId);
          return true;
        } catch {
          return false;
        }
      },
      { expr: APP, docId: created.docId },
    );
    out.cleaned = cleaned;
    console.log(`清理临时文档：${cleaned ? 'ok' : '失败（需手工清理）'}`);
    out.selfWrites = apiCalls;
  } finally {
    await browser.close().catch(() => {});
  }

  const dir = 'docs/AUDIT-140';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/lead-codeblock-verify.json`, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n报告：${dir}/lead-codeblock-verify.json`);
  const failed = out.steps.filter((s) => !s.ok).length;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(3);
});
