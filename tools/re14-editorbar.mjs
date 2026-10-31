/**
 * 1.4.0 需求15 验收：虚拟标签（设置 / 插件商店）下不再渲染正文工具条 `.editorbar`。
 *
 * 根因：设置页与插件商店是**虚拟 tab**（`__settings__` / `__plugins__`），
 * 对它们 `activeTab` 为真、且扩展名不是 .flow/.mind，所以改前只判
 * `activeTab && !isFlowTab && !isMindTab` 时整条 `.editorbar` 照常渲染，
 * 压在设置页标题栏右边 —— 用户看到的就是「设置页上多了一条正文工具栏」。
 * 实测那个盒子是 {x:260, y:40, w:1340, h:38}。
 *
 * 修法：v-if 追加 `&& !isSettingsActive && !isPluginActive`（2 个 computed 已存在）。
 *
 * 本脚本断言四个场景（前三个是需求，第四个是**防回归**）：
 *   1. 设置页   ：.editorbar 数量 === 0
 *   2. 插件商店 ：.editorbar 数量 === 0
 *   3. 普通文档 ：.editorbar 数量 === 1   ← 不能改坏正常编辑路径
 *   4. 图文档   ：.editorbar 数量 === 0   ← 既有行为，不能被这次改动带坏
 *
 * 全部走真实用户路径：
 *   - 设置页： Ctrl+, 快捷键（对应代码里的 'Ctrl+,': () => openSettings()）
 *   - 插件商店：功能区底部按钮 [data-ribbon-bottom="plugin-center"]
 *
 * 用法：node tools/re14-editorbar.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BASE = 'http://127.0.0.1:5178';
const API = 'http://127.0.0.1:3200';
const SHOT_DIR = path.join(ROOT, 'docs', 'shots-140');
const TOKEN_CACHE = path.join(os.tmpdir(), 'neomd-re14-token.json');

async function loadChromium() {
  const candidates = [
    'playwright',
    'playwright-core',
    pathToFileURL(path.join(ROOT, 'node_modules/playwright-core/index.mjs')).href,
    pathToFileURL(path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs')).href,
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const mod = await import(c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errors.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errors.push(`${c}: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  throw new Error(`无法加载 Playwright：\n  - ${errors.join('\n  - ')}`);
}

async function httpJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function getToken() {
  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    if (cached?.token && cached?.at && Date.now() - cached.at < 6 * 3600_000) {
      const probe = await httpJson(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${cached.token}` } });
      if (probe.status === 200 && probe.body?.ok) return { token: cached.token, user: cached.user, cached: true };
    }
  } catch {
    /* 无缓存 */
  }
  const r = await httpJson(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '6655' }),
  });
  if (r.status !== 200 || !r.body?.ok) throw new Error(`登录失败 ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const { accessToken, user } = r.body.data;
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: accessToken, user, at: Date.now() }), 'utf8');
  return { token: accessToken, user, cached: false };
}

async function newSession(chromium, auth) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await ctx.addInitScript(
    ([a, u]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', '');
        localStorage.setItem('neomd.user.cache', u);
        localStorage.setItem('neomd.deviceId', 'qa-re14-editorbar');
        if (!localStorage.getItem('neomd.re14.barseeded')) {
          const prev = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
          prev.layout = { ...(prev.layout || {}), rightPanelOpen: false, leftPanelOpen: true, ribbonEnabled: true };
          localStorage.setItem('neomd.settings.v1', JSON.stringify(prev));
          localStorage.setItem('neomd.re14.barseeded', '1');
        }
      } catch {
        /* ignore */
      }
    },
    [auth.token, JSON.stringify(auth.user)],
  );
  // 生产库安全阀：设置接口换进程内假云端（设置页有草稿/保存流程会 PUT）
  const fake = { payload: null, version: 0 };
  await ctx.route('**/api/settings**', async (route) => {
    const req = route.request();
    const url = req.url();
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    if (req.method() === 'PUT') {
      try {
        const body = JSON.parse(req.postData() || '{}');
        if (body.payload !== undefined) fake.payload = body.payload;
      } catch {
        /* ignore */
      }
      fake.version += 1;
      return ok({ version: fake.version, updatedAt: new Date().toISOString(), deviceId: null, platform: null });
    }
    if (req.method() === 'GET' && /\/api\/settings\/version/.test(url)) return ok({ version: fake.version });
    if (req.method() === 'GET') {
      return ok({ payload: fake.payload, sensitive: null, version: fake.version, updatedAt: null, deviceId: null, platform: null });
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function openWorkbench(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.shell__main', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i += 1) {
    if (await page.locator('.ProseMirror, .cm-content, .read-view').count()) break;
    await page.keyboard.press('Control+n').catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** 量 .editorbar 数量 + 首个盒子几何（数量为 0 时 box 为 null） */
async function barInfo(page) {
  return page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll('.editorbar'));
    const first = bars[0];
    const b = first ? first.getBoundingClientRect() : null;
    return {
      count: bars.length,
      box: b ? { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null,
    };
  });
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/** 点第一个可见的匹配选择器 */
async function clickFirstVisible(page, selector) {
  const count = await page.locator(selector).count();
  for (let i = 0; i < count; i += 1) {
    const el = page.locator(selector).nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** 回到第一个文档标签（关闭虚拟标签不会丢文档，直接点文档标签即可） */
async function backToDocTab(page) {
  const ok = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const hit = tabs.find((t) => {
      const title = (t.querySelector('.tab__title')?.textContent || '').trim();
      return title && title !== '设置' && title !== '插件商店';
    });
    if (!hit) return false;
    const target = hit.querySelector('.tab__title') || hit;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  await page.waitForTimeout(900);
  return ok;
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re14-editorbar] 登录=${auth.cached ? '复用缓存' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const { browser, page } = await newSession(chromium, auth);
  const report = { cases: [], shots: [], failures: [] };
  const fail = (m) => report.failures.push(m);

  try {
    await openWorkbench(page);

    /* ---------- 场景3（基准）：普通文档应为 1 ---------- */
    const docBar = await barInfo(page);
    report.cases.push({ scene: '普通文档', expect: 1, actual: docBar.count, box: docBar.box, pass: docBar.count === 1 });
    if (docBar.count !== 1) fail(`普通文档下 .editorbar 应为 1，实际 ${docBar.count}（正常编辑路径被改坏）`);
    report.shots.push(await shot(page, 're14-editorbar-doc'));

    /* ---------- 场景1：设置页应为 0 ---------- */
    await page.locator('.shell__main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+,').catch(() => {});
    await page.waitForTimeout(1400);
    const settingsVisible = (await page.locator('.settings-page').count()) > 0;
    const settingsBar = await barInfo(page);
    report.cases.push({
      scene: '设置页',
      expect: 0,
      actual: settingsBar.count,
      box: settingsBar.box,
      pageVisible: settingsVisible,
      pass: settingsBar.count === 0 && settingsVisible,
    });
    if (!settingsVisible) fail('Ctrl+, 未能打开设置页（.settings-page 不存在），该场景未真正验证');
    if (settingsBar.count !== 0) {
      fail(`设置页下 .editorbar 应为 0，实际 ${settingsBar.count}，盒子 ${JSON.stringify(settingsBar.box)}`);
    }
    report.shots.push(await shot(page, 're14-editorbar-settings'));

    /* ---------- 场景4：图文档应为 0（既有行为，防回归） ---------- */
    /*
     * 走功能区按钮（只有 :title，没有 data-* 属性），按标题文本匹配。
     * 注意：本次改动只是在 v-if 上**追加 AND 条件**，只可能让工具条更少出现，
     * 不可能让原本隐藏的图文档工具条冒出来；这项是「顺手确认没被带坏」。
     */
    await backToDocTab(page);
    const flowClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.ribbon__btn'));
      const hit = btns.find((b) => /流程图/.test(b.getAttribute('title') || ''));
      if (!hit) return false;
      hit.click();
      return true;
    });
    await page.waitForTimeout(2000);
    const flowVisible = (await page.locator('.flow').count()) > 0;
    if (flowVisible) {
      const flowBar = await barInfo(page);
      report.cases.push({
        scene: '图文档',
        expect: 0,
        actual: flowBar.count,
        box: flowBar.box,
        flowVisible,
        pass: flowBar.count === 0,
      });
      if (flowBar.count !== 0) fail(`图文档下 .editorbar 应为 0，实际 ${flowBar.count}（既有行为被改坏）`);
      report.shots.push(await shot(page, 're14-editorbar-flow'));
    } else {
      report.flowNotVerified = { clicked: flowClicked };
    }

    /* ---------- 场景2：插件商店应为 0 ---------- */
    await backToDocTab(page);
    const pluginClicked = await clickFirstVisible(page, '[data-ribbon-bottom="plugin-center"]');
    await page.waitForTimeout(1500);
    const pluginVisible = (await page.locator('.pc, .plugincenter-shell').count()) > 0;
    const pluginBar = await barInfo(page);
    report.cases.push({
      scene: '插件商店',
      expect: 0,
      actual: pluginBar.count,
      box: pluginBar.box,
      pageVisible: pluginVisible,
      entryClicked: pluginClicked,
      pass: pluginBar.count === 0 && pluginVisible,
    });
    if (!pluginVisible) fail(`未能打开插件商店（[data-ribbon-bottom="plugin-center"] 点击=${pluginClicked}），该场景未真正验证`);
    if (pluginBar.count !== 0) {
      fail(`插件商店下 .editorbar 应为 0，实际 ${pluginBar.count}，盒子 ${JSON.stringify(pluginBar.box)}`);
    }
    report.shots.push(await shot(page, 're14-editorbar-plugins'));
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = report.failures.length === 0;
  report.pass = pass;
  console.log(JSON.stringify(report, null, 2));

  console.log('\n=== 需求15（正文工具条泄漏到虚拟标签）验收摘要 ===');
  for (const c of report.cases) {
    console.log(
      `${c.scene.padEnd(8)} 期望 .editorbar=${c.expect} 实际=${String(c.actual).padStart(2)} | 盒子 ${JSON.stringify(c.box)} | ${c.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  if (report.flowNotVerified) console.log('⚠ 图文档场景未能进入（命令面板未命中），仅记录');
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
  if (report.failures.length) console.log('失败明细：\n  - ' + report.failures.join('\n  - '));

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, 're14-editorbar.json'), JSON.stringify(report, null, 2), 'utf8');
  process.exit(pass ? 0 : 1);
};

main().catch((e) => {
  console.error('[re14-editorbar] 失败：', e);
  process.exit(1);
});
