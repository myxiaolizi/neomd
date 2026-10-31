/**
 * 1.4.0 布局缺陷取证探针（临时，只跑一次；正式验收脚本是 re14-layout-split.mjs）。
 *
 * 目的：在**改代码之前**亲眼看一遍「分屏分隔条不跟手」的真实数据，确认根因是
 * ① 像素增量被当成百分比增量（灵敏度放大 = 容器尺寸/100 倍）；
 * ② flex 百分比绑在第二栏，鼠标右移/下移时比例变大→第二栏变大→分隔条反向移动。
 *
 * 用法：node tools/re14-layout-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BASE = 'http://127.0.0.1:5178';
const API = 'http://127.0.0.1:3200';
const TOKEN_CACHE = path.join(os.tmpdir(), 'neomd-re14-token.json');

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
  if (!(await page.locator('.ProseMirror, .cm-content').count())) {
    await page.keyboard.press('Control+n').catch(() => {});
    await page.waitForTimeout(900);
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** 打开分屏（走真实 UI：标签栏分屏按钮 → 菜单项） */
async function enableSplit(page, dir) {
  const label = dir === 'v' ? '左右分屏' : '上下分屏';
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('.tabbar__split .tabbar__act');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) return false;
  await page.waitForSelector('.splitmenu', { timeout: 6000 }).catch(() => {});
  const clicked = await page.evaluate((lb) => {
    const items = Array.from(document.querySelectorAll('.splitmenu .splitmenu__item'));
    const hit = items.find((e) => (e.textContent || '').includes(lb));
    if (!hit) return false;
    hit.click();
    return true;
  }, label);
  await page.waitForTimeout(1200);
  return clicked;
}

/** 几何：容器 + 分隔条（= 第二栏的起始边）+ 比例 */
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
      /** 分隔条视觉位置：v 取第二栏左缘（边界线），h 取第二栏上缘 */
      divider: dir === 'h' ? s.top : s.left,
    };
  });
}

/** 把比例设成指定值（直接改 localStorage 里的 splitRatio 并刷新，绕开坏掉的拖拽） */
async function setRatio(page, ratio) {
  await page.evaluate((r) => {
    const raw = JSON.parse(localStorage.getItem('neomd.localLayout') || '{}');
    raw.splitRatio = r;
    localStorage.setItem('neomd.localLayout', JSON.stringify(raw));
  }, ratio);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell__panes', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** 单次拖动：按下分隔条 → 分 5 步移到目标 → 松开，逐步采样 */
async function dragTo(page, axis, targetPx) {
  const g0 = await geom(page);
  if (!g0) return { error: 'no split geometry' };
  const isH = g0.dir === 'h';
  const startPos = isH ? g0.divider + 1 : g0.divider + 1; // 落在手柄命中区（±3px）
  const crossAxis = isH ? g0.panes.left + 200 : g0.panes.top + 120;
  const start = { x: isH ? crossAxis : startPos, y: isH ? startPos : crossAxis };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const samples = [];
  const steps = 5;
  for (let i = 1; i <= steps; i += 1) {
    const cur = isH ? start.y + ((targetPx - start.y) * i) / steps : start.x + ((targetPx - start.x) * i) / steps;
    const px = isH ? { x: crossAxis, y: cur } : { x: cur, y: crossAxis };
    await page.mouse.move(px.x, px.y, { steps: 1 });
    await page.waitForTimeout(90);
    const g = await geom(page);
    samples.push({
      mouse: Math.round((isH ? px.y : px.x) * 100) / 100,
      divider: Math.round(g.divider * 100) / 100,
      deviation: Math.round(((isH ? px.y : px.x) - g.divider) * 100) / 100,
    });
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  const gEnd = await geom(page);
  return { axis, targetPx: Math.round(targetPx * 100) / 100, samples, afterRelease: { divider: Math.round(gEnd.divider * 100) / 100 } };
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re14-probe] 登录=${auth.cached ? '复用缓存' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const { browser, page } = await newSession(chromium, auth);
  const out = {};
  try {
    await openWorkbench(page);
    for (const dir of ['v', 'h']) {
      await enableSplit(page, dir);
      await page.waitForSelector('.shell__splitpane', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      await setRatio(page, 0.5);
      const g = await geom(page);
      if (!g) {
        out[dir] = { error: '未进入分屏' };
        continue;
      }
      const isH = dir === 'h';
      const span = isH ? g.panes.height : g.panes.width;
      const origin = isH ? g.panes.top : g.panes.left;
      // 「鼠标右/下移 5px」等价于「想把分隔条移到 50% + 5px」
      const rec = { geom: g, ratioText: '50%', delta5: null, to70: null };
      rec.delta5 = await dragTo(page, dir, g.divider + 5);
      await setRatio(page, 0.5);
      const g2 = await geom(page);
      rec.to70 = await dragTo(page, dir, origin + span * 0.7);
      rec.after = { panesSpan: span, origin, expect70: Math.round((origin + span * 0.7) * 100) / 100, g2Divider: g2?.divider };
      out[dir] = rec;
      // 收掉分屏，避免影响下一个方向
      await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('neomd.localLayout') || '{}');
        raw.splitDirection = 'none';
        localStorage.setItem('neomd.localLayout', JSON.stringify(raw));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.shell__panes', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
};

main().catch((e) => {
  console.error('[re14-probe] 失败：', e);
  process.exit(1);
});
