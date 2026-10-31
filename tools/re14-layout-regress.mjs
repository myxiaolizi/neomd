/**
 * 1.4.0 布局回归护栏：确认「改分屏」没有改坏**本来正常的**像素拖拽。
 *
 * 为什么要单独一个脚本：`ResizeHandle` 是左右侧栏宽度、右侧区块高度、分屏比例
 * 三方共用的组件。这次给分屏加了 `unit="percent"` 的换算分支，风险是顺手把
 * 默认（px）路径也改了 —— 那就会「修好分屏、弄坏侧栏」。
 *
 * 断言：
 *   1. 左右侧栏宽度拖动仍然 1px 跟 1px（偏差 < 3px）；
 *   2. 右侧栏 3 个区块时，区块之间的高度分隔条拖动仍然 1px 跟 1px。
 *
 * 用法：node tools/re14-layout-regress.mjs
 * 退出码：0 = 通过；1 = 失败。
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
const TOLERANCE = 3;

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
        localStorage.setItem('neomd.deviceId', 'qa-re14-regress');
        if (!localStorage.getItem('neomd.re14.seeded')) {
          const prev = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
          prev.layout = {
            ...(prev.layout || {}),
            rightPanelOpen: true,
            leftPanelOpen: true,
            rightPanelSections: ['ai', 'file', 'outline'],
          };
          localStorage.setItem('neomd.settings.v1', JSON.stringify(prev));
          localStorage.setItem('neomd.re14.seeded', '1');
        }
      } catch {
        /* ignore */
      }
    },
    [auth.token, JSON.stringify(auth.user)],
  );
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
    await page.keyboard.press('Ctrl+n').catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re14-regress] 登录=${auth.cached ? '复用缓存' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const { browser, page } = await newSession(chromium, auth);
  const report = { tolerance: TOLERANCE, cases: [], shots: [], failures: [] };

  try {
    await openWorkbench(page);

    /* ---------- 1. 左侧栏宽度（px 模型）---------- */
    const leftHandle = page.locator('.shell__left + .resizer, .resizer').first();
    const leftBefore = await page.evaluate(() => {
      const el = document.querySelector('.shell__left');
      return el ? el.getBoundingClientRect().width : null;
    });
    const leftHandleCount = await page.locator('.resizer').count();
    if (leftBefore === null) {
      report.failures.push('找不到左侧栏 .shell__left');
    } else if (!leftHandleCount) {
      report.failures.push('找不到任何 ResizeHandle');
    } else {
      // 左侧栏手柄在 .shell__left 右侧：取 .shell__left 的下一个兄弟 resizer
      const box = await page.evaluate(() => {
        const left = document.querySelector('.shell__left');
        if (!left) return null;
        const next = left.nextElementSibling;
        const target = next?.classList.contains('resizer') ? next : left.parentElement?.querySelector('.resizer--vertical');
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + Math.min(300, r.height / 2), width: left.getBoundingClientRect().width };
      });
      if (!box) {
        report.failures.push('找不到左侧栏的分隔条');
      } else {
        const startWidth = box.width;
        const dx = 80;
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        const samples = [];
        const steps = 6;
        for (let i = 1; i <= steps; i += 1) {
          const x = box.x + (dx * i) / steps;
          await page.mouse.move(x, box.y, { steps: 1 });
          await page.waitForTimeout(70);
          const now = await page.evaluate(() => {
            const left = document.querySelector('.shell__left');
            const next = left?.nextElementSibling;
            const target = next?.classList.contains('resizer') ? next : left?.parentElement?.querySelector('.resizer--vertical');
            if (!left || !target) return null;
            const r = target.getBoundingClientRect();
            return { divider: r.left + r.width / 2, width: left.getBoundingClientRect().width, mouse: null };
          });
          samples.push({
            step: i,
            mouse: Math.round(x * 100) / 100,
            divider: now ? Math.round(now.divider * 100) / 100 : null,
            deviation: now ? Math.round((x - now.divider) * 100) / 100 : null,
            widthDelta: now ? Math.round((now.width - startWidth) * 100) / 100 : null,
          });
        }
        await page.mouse.up();
        await page.waitForTimeout(150);
        const worst = samples.reduce((m, s) => Math.max(m, Math.abs(s.deviation ?? 999)), 0);
        // px 模型下：分隔条应跟着鼠标走，宽度增量应接近 dx
        const widthDelta = samples[samples.length - 1]?.widthDelta ?? null;
        const ok = worst < TOLERANCE && widthDelta !== null && Math.abs(widthDelta - dx) < TOLERANCE;
        if (!ok) {
          report.failures.push(`左侧栏宽度拖动异常：逐步最大偏差 ${worst.toFixed(2)}px，宽度增量 ${widthDelta}px（期望 ${dx}px）`);
        }
        report.cases.push({ name: '左侧栏宽度(px)', startWidth, sampleCount: samples.length, worstDeviation: Math.round(worst * 100) / 100, widthDelta, pass: ok, samples });
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, 're14-regress-leftwidth.png') }).catch(() => {});
        report.shots.push('docs/shots-140/re14-regress-leftwidth.png');
      }
    }

    /* ---------- 2. 右侧区块高度（px 模型）---------- */
    const heightBox = await page.evaluate(() => {
      const panes = Array.from(document.querySelectorAll('.rightstack .rightstack__pane'));
      if (panes.length < 2) return null;
      const first = panes[0];
      // 第一块下方紧邻的横向前置手柄
      let cur = first.nextElementSibling;
      while (cur && !cur.classList.contains('resizer--horizontal')) cur = cur.nextElementSibling;
      if (!cur) return null;
      const r = cur.getBoundingClientRect();
      return {
        x: r.left + Math.min(120, r.width / 2),
        y: r.top + r.height / 2,
        firstHeight: first.getBoundingClientRect().height,
        paneCount: panes.length,
      };
    });
    if (!heightBox) {
      report.failures.push('右侧栏不足 2 个区块或找不到高度分隔条');
    } else {
      const dy = 60;
      await page.mouse.move(heightBox.x, heightBox.y);
      await page.mouse.down();
      const samples = [];
      const steps = 6;
      for (let i = 1; i <= steps; i += 1) {
        const y = heightBox.y + (dy * i) / steps;
        await page.mouse.move(heightBox.x, y, { steps: 1 });
        await page.waitForTimeout(70);
        const now = await page.evaluate(() => {
          const panes = Array.from(document.querySelectorAll('.rightstack .rightstack__pane'));
          const first = panes[0];
          let cur = first?.nextElementSibling;
          while (cur && !cur.classList.contains('resizer--horizontal')) cur = cur.nextElementSibling;
          if (!first || !cur) return null;
          const r = cur.getBoundingClientRect();
          return { divider: r.top + r.height / 2, firstHeight: first.getBoundingClientRect().height };
        });
        samples.push({
          step: i,
          mouse: Math.round(y * 100) / 100,
          divider: now ? Math.round(now.divider * 100) / 100 : null,
          deviation: now ? Math.round((y - now.divider) * 100) / 100 : null,
          heightDelta: now ? Math.round((now.firstHeight - heightBox.firstHeight) * 100) / 100 : null,
        });
      }
      await page.mouse.up();
      await page.waitForTimeout(150);
      const worst = samples.reduce((m, s) => Math.max(m, Math.abs(s.deviation ?? 999)), 0);
      const heightDelta = samples[samples.length - 1]?.heightDelta ?? null;
      const ok = worst < TOLERANCE && heightDelta !== null && Math.abs(heightDelta - dy) < TOLERANCE;
      if (!ok) {
        report.failures.push(`右侧区块高度拖动异常：逐步最大偏差 ${worst.toFixed(2)}px，高度增量 ${heightDelta}px（期望 ${dy}px）`);
      }
      report.cases.push({
        name: '右侧区块高度(px)',
        paneCount: heightBox.paneCount,
        firstHeightBefore: Math.round(heightBox.firstHeight * 100) / 100,
        sampleCount: samples.length,
        worstDeviation: Math.round(worst * 100) / 100,
        heightDelta,
        pass: ok,
        samples,
      });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, 're14-regress-sectionheight.png') }).catch(() => {});
      report.shots.push('docs/shots-140/re14-regress-sectionheight.png');
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = report.failures.length === 0;
  report.pass = pass;
  console.log(JSON.stringify(report, null, 2));
  console.log('\n=== 像素拖拽回归摘要 ===');
  for (const c of report.cases) {
    console.log(
      `${c.name.padEnd(16)} 逐步最大偏差 ${String(c.worstDeviation).padStart(5)}px | 尺寸增量 ${String(c.widthDelta ?? c.heightDelta).padStart(6)}px | ${c.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(pass ? '\n✅ 像素拖拽未被改坏' : '\n❌ 存在回归');
  if (report.failures.length) console.log('失败明细：\n  - ' + report.failures.join('\n  - '));

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, 're14-layout-regress.json'), JSON.stringify(report, null, 2), 'utf8');
  process.exit(pass ? 0 : 1);
};

main().catch((e) => {
  console.error('[re14-regress] 失败：', e);
  process.exit(1);
});
