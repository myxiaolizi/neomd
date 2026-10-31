/**
 * 1.4.0 需求7 验收：左右 / 上下分屏拖动**跟手**（鼠标与分隔条偏差 < 3px）。
 *
 * 背景（改前实测，见 docs/shots-140/re14-probe-before.json）：
 *   左右分屏鼠标右移 +5px → 分隔条反而左移 −52px；
 *   想拖到 70% 时反向撞死 20% 下限，偏差 421px。
 *   根因两条：① 像素增量被直接加到百分比上（灵敏度放大 容器尺寸/100 倍）；
 *            ② 百分比绑在第二栏，比例变大 → 第二栏变大 → 分隔条反向移动。
 *
 * 本脚本只做**黑盒实测**，不读源码常量：全程用真实鼠标事件（page.mouse）拖动
 * 真实分隔条，逐步采样「鼠标位置」与「分隔条实际位置」，用几何数据判定。
 *
 * 判定口径：
 * - 每个方向各拖 3 个目标位置：30% / 50% / 70%（相对分屏容器在该轴上的尺寸）；
 * - 拖拽过程**逐步采样**（不是只看终点），每一步都要求 |鼠标 − 分隔条| < 3px；
 * - 松手前后分隔条位置一致（|松手前 − 松手后| < 3px），且落在目标位置 ±3px 内。
 *
 * 用法：node tools/re14-layout-split.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败（同时打印失败明细）。
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

/** 偏差容忍（px）：需求要求 < 3px */
const TOLERANCE = 3;
/** 拖拽过程采样步数（每步移动一次鼠标并量一次几何） */
const DRAG_STEPS = 8;
/** 三个验收目标比例 */
const TARGETS = [
  { label: '30%', ratio: 0.3 },
  { label: '50%', ratio: 0.5 },
  { label: '70%', ratio: 0.7 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 复用登录 token（限流 10 次/分钟） */
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
        localStorage.setItem('neomd.deviceId', 'qa-re14-layout');
      } catch {
        /* ignore */
      }
    },
    [auth.token, JSON.stringify(auth.user)],
  );
  /*
   * 生产库安全阀：把设置接口替换成进程内假云端。
   * 分屏比例存在 **localLayout（localStorage）**，本来就不进云端，
   * 但右侧栏区块顺序走 settings.updateLayout() → 会触发 PUT /api/settings，
   * 不拦住就会把 QA 用的布局写进真实管理员配置。
   */
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

/** 打开工作台并保证有可编辑文档 */
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

/** 取分屏几何：容器 / 第二栏 / 手柄 / 分隔条位置 */
async function geom(page) {
  return page.evaluate(() => {
    const panes = document.querySelector('.shell__panes');
    const split = document.querySelector('.shell__splitpane');
    const handle = document.querySelector('.shell__panes > .resizer');
    if (!panes || !split) return null;
    const p = panes.getBoundingClientRect();
    const s = split.getBoundingClientRect();
    const h = handle ? handle.getBoundingClientRect() : null;
    const dir = panes.classList.contains('shell__panes--h') ? 'h' : 'v';
    return {
      dir,
      panes: { left: p.left, top: p.top, width: p.width, height: p.height },
      split: { left: s.left, top: s.top, width: s.width, height: s.height },
      handle: h ? { left: h.left, top: h.top, width: h.width, height: h.height } : null,
      /** 分隔条视觉位置：v 取第二栏左缘，h 取第二栏上缘（两者都是两栏的分界线） */
      divider: dir === 'h' ? s.top : s.left,
    };
  });
}

/** 直接写 localStorage 布置起始状态（绕开 UI 菜单，避免按钮文案耦合） */
async function seed(page, patch) {
  await page.evaluate((p) => {
    const raw = JSON.parse(localStorage.getItem('neomd.localLayout') || '{}');
    Object.assign(raw, p);
    localStorage.setItem('neomd.localLayout', JSON.stringify(raw));
  }, patch);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell__panes', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/**
 * 从当前分隔条位置拖到目标像素位置，逐步采样。
 *
 * 按下点取 `divider + 1`：手柄宽 6px、用 margin 骑在分界线上（-3px..+3px），
 * 所以 +1 一定落在手柄命中区内，同时贴合真实用户「点在线上」的操作。
 */
async function dragTo(page, targetPx) {
  const g0 = await geom(page);
  if (!g0) return { error: '没有分屏几何（未进入分屏？）' };
  const isH = g0.dir === 'h';
  const startPos = g0.divider + 1;
  // 另一轴取容器内部，避免点到边缘的其它元素
  const crossAxis = isH ? g0.panes.left + 200 : g0.panes.top + 120;
  const from = { x: isH ? crossAxis : startPos, y: isH ? startPos : crossAxis };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const samples = [];
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    const cur = startPos + ((targetPx - startPos) * i) / DRAG_STEPS;
    const pt = isH ? { x: crossAxis, y: cur } : { x: cur, y: crossAxis };
    await page.mouse.move(pt.x, pt.y, { steps: 1 });
    await page.waitForTimeout(70);
    const g = await geom(page);
    const mouse = isH ? pt.y : pt.x;
    samples.push({
      step: i,
      mouse: Math.round(mouse * 100) / 100,
      divider: Math.round(g.divider * 100) / 100,
      deviation: Math.round((mouse - g.divider) * 100) / 100,
    });
  }
  const beforeRelease = await geom(page);
  await page.mouse.up();
  await page.waitForTimeout(180);
  const afterRelease = await geom(page);
  return {
    axis: isH ? 'h' : 'v',
    targetPx: Math.round(targetPx * 100) / 100,
    samples,
    dividerBeforeRelease: Math.round(beforeRelease.divider * 100) / 100,
    dividerAfterRelease: Math.round(afterRelease.divider * 100) / 100,
  };
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re14-split] 登录=${auth.cached ? '复用缓存 token' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const { browser, page } = await newSession(chromium, auth);
  const report = { tolerance: TOLERANCE, dragSteps: DRAG_STEPS, directions: {}, shots: [], failures: [] };

  try {
    await openWorkbench(page);

    for (const dir of ['v', 'h']) {
      const dirLabel = dir === 'v' ? '左右分屏' : '上下分屏';
      await seed(page, { splitDirection: dir, splitRatio: 0.5 });
      await page.waitForTimeout(700);
      const g0 = await geom(page);
      if (!g0) {
        report.failures.push(`${dirLabel}: 未能进入分屏`);
        continue;
      }
      const rec = { label: dirLabel, container: g0.panes, startRatio: '50%', positions: [] };

      for (const target of TARGETS) {
        // 每个目标位置都先回到 50%，保证是「从固定起点拖到目标」，每次拖拽相互独立
        await seed(page, { splitDirection: dir, splitRatio: 0.5 });
        const g = await geom(page);
        if (!g) {
          report.failures.push(`${dirLabel} ${target.label}: 重置后没有分屏几何`);
          continue;
        }
        const isH = dir === 'h';
        const origin = isH ? g.panes.top : g.panes.left;
        const span = isH ? g.panes.height : g.panes.width;
        const targetPx = origin + span * target.ratio;

        const drag = await dragTo(page, targetPx);
        if (drag.error) {
          report.failures.push(`${dirLabel} ${target.label}: ${drag.error}`);
          continue;
        }
        // 逐采样判定
        const worst = drag.samples.reduce((m, s) => Math.max(m, Math.abs(s.deviation)), 0);
        const endErr = Math.abs(drag.dividerAfterRelease - targetPx);
        const releaseDrift = Math.abs(drag.dividerBeforeRelease - drag.dividerAfterRelease);
        const ok = worst < TOLERANCE && endErr < TOLERANCE && releaseDrift < TOLERANCE;
        if (!ok) {
          report.failures.push(
            `${dirLabel} ${target.label}: 逐步最大偏差 ${worst.toFixed(2)}px / 终点偏差 ${endErr.toFixed(2)}px / 松手漂移 ${releaseDrift.toFixed(2)}px`,
          );
        }
        rec.positions.push({
          target: target.label,
          targetPx: Math.round(targetPx * 100) / 100,
          worstStepDeviation: Math.round(worst * 100) / 100,
          endDeviation: Math.round(endErr * 100) / 100,
          releaseDrift: Math.round(releaseDrift * 100) / 100,
          pass: ok,
          samples: drag.samples,
          finalDivider: drag.dividerAfterRelease,
        });
        report.shots.push(await shot(page, `re14-split-${dir}-${target.label.replace('%', '')}`));
      }
      rec.pass = rec.positions.length === TARGETS.length && rec.positions.every((p) => p.pass);
      report.directions[dir] = rec;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const allPass = !report.failures.length && Object.values(report.directions).every((d) => d.pass);
  report.pass = allPass;

  console.log(JSON.stringify(report, null, 2));

  // 终端可读摘要
  console.log('\n=== 分屏跟手验收摘要 ===');
  for (const [dir, rec] of Object.entries(report.directions)) {
    console.log(`${rec.label}（容器 ${Math.round(rec.container.width)}×${Math.round(rec.container.height)}）`);
    for (const p of rec.positions) {
      console.log(
        `  ${p.target.padEnd(4)} 目标 ${String(p.targetPx).padStart(7)}px | 逐步最大偏差 ${String(p.worstStepDeviation).padStart(6)}px | 终点偏差 ${String(p.endDeviation).padStart(5)}px | 松手漂移 ${String(p.releaseDrift).padStart(5)}px | ${p.pass ? 'PASS' : 'FAIL'}`,
      );
    }
  }
  console.log(allPass ? '\n✅ 全部通过（偏差均 < 3px）' : '\n❌ 存在失败项');
  if (report.failures.length) console.log('失败明细：\n  - ' + report.failures.join('\n  - '));

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, 're14-layout-split.json'), JSON.stringify(report, null, 2), 'utf8');

  process.exit(allPass ? 0 : 1);
};

main().catch((e) => {
  console.error('[re14-split] 失败：', e);
  process.exit(1);
});
