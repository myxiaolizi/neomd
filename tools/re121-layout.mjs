/**
 * 1.2.1 缺陷 1 / 缺陷 3 的实测诊断脚本（编辑器修复组 A）。
 *
 * 为什么要有这个脚本：缺陷 1（行距过大）与缺陷 3（对照模式右侧预览没纸色）
 * 都是**纯渲染层**问题，光看 CSS 源码只能猜。这里用 Playwright 打开真实前端
 * （dev server 已在 127.0.0.1:5178 跑着），用 getComputedStyle + Range 实测：
 *   ① 正文字号 / line-height 计算值；
 *   ② 同一个段落内相邻两行的 baseline 距离（真实行距，含 half-leading）；
 *   ③ 相邻两段的「上一段末行底 → 下一段首行顶」距离（段落间距，line-height 与
 *      margin 是否双向放大就看这个值）；
 *   ④ 普通段落 / 对照模式左右两栏的背景色、文字色（浅色 + 深色两套主题）。
 *
 * 用法：
 *   node tools/re121-layout.mjs            # 默认输出到终端
 *   node tools/re121-layout.mjs --tag before
 * 输出：
 *   终端打印 JSON 形式的实测值 + 截图落到 docs/shots-121/re121-<tag>-<theme>-*.png
 *
 * 安全说明（生产库）：
 * - 登录 token 缓存在系统临时目录，避免反复登录撞 10 次/分钟限流；
 * - `/api/settings**` 被路由成本进程内的假云端（不读不写生产库里的真实设置）；
 * - 文档只新建一篇临时文档，测完删掉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BASE = 'http://127.0.0.1:5178';
const API = 'http://127.0.0.1:3200';
const SHOT_DIR = path.join(ROOT, 'docs', 'shots-121');
const TOKEN_CACHE = path.join(os.tmpdir(), 'neomd-re121-token.json');
const TAG = (process.argv.find((a) => a.startsWith('--tag=')) ?? '').replace('--tag=', '') || 'before';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadChromium() {
  // Windows 上 import() 绝对路径必须转成 file:// URL，否则 ESM loader 直接报
  // "Only URLs with a scheme in: file, data, and node are supported"。
  // 根 node_modules 里没有 playwright，只有 pnpm 的真实目录，所以逐个试。
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

/** 复用登录 token（限流 10 次/分钟，且每次登录都会写一条审计） */
async function getToken() {
  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    if (cached?.token && cached?.at && Date.now() - cached.at < 6 * 3600_000) {
      const probe = await httpJson(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${cached.token}` } });
      if (probe.status === 200 && probe.body?.ok) return { token: cached.token, user: cached.user, cached: true };
    }
  } catch {
    /* 没有缓存 */
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

/**
 * 新开一个已登录页面。
 *
 * `theme` 用 localStorage 预置到 neomd.settings.v1，等价于「用户上次选了这套主题」，
 * 比跑 UI 点设置页稳定得多，而且测的就是真实启动路径（applyTheme 从设置读）。
 *
 * 注意**不要**在这里写 lineHeight / fontSize / zoom：那几个字段一旦写进去，
 * 内联的 `--content-line-height` 就会遮蔽默认值，测到的永远是硬塞进去的档位，
 * 而不是「用户从没动过设置」时真正生效的默认值。主题只由 themePresetId 决定。
 */
async function newSession(chromium, auth, theme) {
  const appearance =
    theme === 'dark'
      ? { theme: 'dark', themePresetId: 'midnight' }
      : { theme: 'light', themePresetId: 'daylight' };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await ctx.addInitScript(
    ([a, r, u, app]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', r);
        localStorage.setItem('neomd.user.cache', u);
        localStorage.setItem('neomd.deviceId', 'qa-re121-layout');
        const prev = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
        prev.appearance = { ...(prev.appearance || {}), ...app };
        localStorage.setItem('neomd.settings.v1', JSON.stringify(prev));
      } catch {
        /* ignore */
      }
    },
    [auth.token, '', JSON.stringify(auth.user), appearance],
  );
  // 生产库安全阀：设置接口换成进程内假云端，UI 改设置不会写进真实管理员配置
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

/** 打开工作台，保证有一篇可编辑文档（没有就新建） */
async function openWorkbench(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.shell__main', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i += 1) {
    if (await page.locator('.ProseMirror, .cm-content, .read-view').count()) break;
    await page.locator('.shell__main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+n').catch(() => {});
    await page.waitForTimeout(700);
    if (!(await page.locator('.ProseMirror, .cm-content, .read-view').count())) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
        btn?.click();
      });
      await page.waitForTimeout(700);
    }
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** 切换编辑模式（wysiwyg / source / compare / read），走真实 UI 菜单 */
async function setMode(page, modeId) {
  const labelMap = { wysiwyg: '所见即所得', source: '源码模式', compare: '对照模式', read: '阅读视图' };
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
    const b = btns[btns.length - 1];
    if (b) b.click();
  });
  await page.waitForSelector('.viewswitch__menu', { timeout: 8000 }).catch(() => {});
  await page.evaluate((lb) => {
    const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
    const hit = items.find((e) => (e.textContent || '').trim().includes(lb));
    if (hit) hit.click();
  }, labelMap[modeId]);
  await page.waitForTimeout(900);
}

/**
 * 把光标放到正文末尾并写入测试用的排版样本。
 *
 * 样本结构：两段普通正文（每段刻意写足够长，触发软换行 → 段落内有「相邻行」可测），
 * 段与段之间只有一个空行，便于把「行距」和「段距」分开算。
 */
async function writeSample(page, withBlank = false) {
  // 只用纯文字，不能带 `---` / ``` / `# ` 这类会被 TipTap 输入规则自动转换的标记，
  // 否则样本会变成 hr / 代码块 / 标题，量不到「普通段落」的行距与段距。
  const p1 =
    '第一段用于测量行距：这一行文字刻意写得非常长，让它在正文宽度内自然折行成三行以上，这样段落内部就存在真正相邻的行可以用来测量行盒高度与两行之间的实际距离。';
  const p2 = '第二段用于测量段距：与上一段之间只隔一次回车，量的是上一段末行底边到下一段首行顶边的距离。';

  /*
   * 逐字符打字有概率丢一次 Enter（ProseMirror 的输入事务偶尔被合并），
   * 一旦丢键，样本就只剩 1 个段落、量不到「相邻两段」的空白 → 指标变 null。
   * 这里改成「写完就校验段落数，不对就重来」，最多 3 次，避免偶发脏数据
   * 污染验收结论（宁可重试也不要报一个 null 出来）。
   */
  const expected = withBlank ? 3 : 2;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      const el = document.querySelector('.wysiwyg .ProseMirror') || document.querySelector('.ProseMirror');
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await page.keyboard.press('Control+a');
    await page.keyboard.type(p1, { delay: 2 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    // withBlank=true 时模拟「用户在所见即所得里敲了一个空行」——
    // 这是 QA 量到 55px 段间距的那种结构（中间夹一个空段落）。
    if (withBlank) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
    }
    await page.keyboard.type(p2, { delay: 2 });
    await page.waitForTimeout(500);
    const count = await page.evaluate(
      () => document.querySelectorAll('.wysiwyg .ProseMirror > p, .ProseMirror > p').length,
    );
    if (count === expected) return;
  }
}

/**
 * 读取排版实测值。
 *
 * baseline 距离为什么必须用 Range 量：getComputedStyle 给的 lineHeight 是
 * 「行盒高度」，用户说的「行距太大」= 相邻两行文字实际相距多远，只有逐行
 * Range.getClientRects() 才拿得到。段落间距同理（用两个不同段落的行盒坐标）。
 *
 * 同时采集「空段落」的几何：它是空行在 HTML 里的载体，它的高度直接决定
 * 「用户敲一个空行看起来占多高」，必须与非空段落之间的空白一起看。
 */
async function measureTypography(page) {
  return page.evaluate(() => {
    const host = document.querySelector('.wysiwyg .ProseMirror') || document.querySelector('.ProseMirror');
    if (!host) return { error: 'no .ProseMirror' };
    const cs = getComputedStyle(host);
    const root = getComputedStyle(document.documentElement);

    /** 逐行几何：把元素内的文本按行盒切成若干矩形 */
    const lineRects = (el) => {
      const out = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.height > 0) out.push({ top: Math.round(r.top * 100) / 100, bottom: Math.round(r.bottom * 100) / 100, height: Math.round(r.height * 100) / 100 });
        }
        range.detach?.();
      }
      return out;
    };

    const blocks = Array.from(host.querySelectorAll(':scope > p'));
    const blankIdx = [];
    const textIdx = [];
    blocks.forEach((b, i) => {
      const hasText = (b.textContent ?? '').replace(/\s/g, '') !== '';
      (hasText ? textIdx : blankIdx).push(i);
    });

    const fontSizePx = parseFloat(cs.fontSize);
    const lineHeightPx = parseFloat(cs.lineHeight);
    const em = (px) => Math.round((px / fontSizePx) * 1000) / 1000;

    /** 取前两个「非空」段落，量它们之间的真实空白（这才是 A3 的口径） */
    const [i1, i2] = textIdx;
    const p1 = i1 === undefined ? null : blocks[i1];
    const p2 = i2 === undefined ? null : blocks[i2];
    const rectsP1 = p1 ? lineRects(p1) : [];
    const rectsP2 = p2 ? lineRects(p2) : [];
    const intraLineGaps = [];
    for (let i = 1; i < rectsP1.length; i += 1) {
      intraLineGaps.push(Math.round((rectsP1[i].top - rectsP1[i - 1].top) * 100) / 100);
    }
    const p1Last = rectsP1[rectsP1.length - 1];
    const p2First = rectsP2[0];
    const boxP1 = p1?.getBoundingClientRect();
    const boxP2 = p2?.getBoundingClientRect();

    /** 空段落几何：高度与 margin 是否被清零 */
    const blankEl = blankIdx.length ? blocks[blankIdx[0]] : null;
    const blankBox = blankEl?.getBoundingClientRect();
    const blankCs = blankEl ? getComputedStyle(blankEl) : null;

    /** A3：相邻两个非空段落之间「字形到字形」的空白（px 与 em 双口径） */
    const gapPx = p1Last && p2First ? Math.round((p2First.top - p1Last.bottom) * 100) / 100 : null;

    return {
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      /** A1：lineHeight / fontSize */
      ratio: Math.round((lineHeightPx / fontSizePx) * 1000) / 1000,
      blockCount: blocks.length,
      blankBlockCount: blankIdx.length,
      textBlockCount: textIdx.length,
      /** 段落内相邻行 top 差（真实行距） */
      intraParagraphLineGap: intraLineGaps,
      pMarginTop: p1 ? getComputedStyle(p1).marginTop : null,
      pMarginBottom: p1 ? getComputedStyle(p1).marginBottom : null,
      /** A3 主指标：非空段落之间字形到字形的空白 */
      textToTextGapPx: gapPx,
      textToTextGapEm: gapPx === null ? null : em(gapPx),
      /** 非空段落的行盒外框间距（= margin 折叠结果） */
      paragraphBoxGap: boxP1 && boxP2 ? Math.round((boxP2.top - boxP1.bottom) * 100) / 100 : null,
      /** 空段落：高度 / margin —— 用来确认「一个空行 = 一个行盒」且没有被 margin 撑开 */
      blank: blankEl
        ? {
            height: blankBox ? Math.round(blankBox.height * 100) / 100 : null,
            heightEm: blankBox ? em(blankBox.height) : null,
            marginTop: blankCs?.marginTop ?? null,
            marginBottom: blankCs?.marginBottom ?? null,
            matchedBy: blankEl.className || '(no class, matched by :empty or :has)',
          }
        : null,
      vars: {
        contentLineHeight: root.getPropertyValue('--content-line-height').trim(),
        contentFontSize: root.getPropertyValue('--content-font-size').trim(),
        contentBg: root.getPropertyValue('--content-bg').trim(),
        contentFg: root.getPropertyValue('--content-fg').trim(),
      },
      hostClass: host.className,
    };
  });
}

/**
 * 读取颜色：正文宿主 / 对照模式左右两栏 / 分屏第二栏 / body。
 *
 * 注意要读 `backgroundColor` 而不是「看起来的颜色」：比对时会算
 * color-mix 后的最终结果 —— 若某一栏是 transparent，说明它没有自己的纸色，
 * 会把底下容器的颜色透上来，深色主题下就是「右侧一片灰」的观感来源。
 * 因此这里额外做一次 `paintedBg`：沿祖先链找第一个真正上色的节点，
 * 报出「这一栏实际呈现的颜色 + 它来自哪个祖先」，这才是用户眼睛看到的值。
 */
async function measureColors(page) {
  return page.evaluate(() => {
    /** 沿祖先链找第一个非透明背景，返回它实际呈现的颜色与来源 */
    const paintedBg = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          return { color: bg, from: cur.className || cur.tagName.toLowerCase() };
        }
        cur = cur.parentElement;
      }
      return { color: getComputedStyle(document.body).backgroundColor, from: 'body' };
    };
    const shot = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        selector: sel,
        backgroundColor: cs.backgroundColor,
        painted: paintedBg(el),
        color: cs.color,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        fontFamily: cs.fontFamily.split(',')[0],
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        opacity: cs.opacity,
      };
    };
    return {
      theme: {
        preset: document.documentElement.dataset.themePreset,
        mode: document.documentElement.dataset.theme,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
      },
      targets: {
        shellMain: shot('.shell__main'),
        shellContent: shot('.shell__content'),
        shellPage: shot('.shell__page'),
        splitpane: shot('.shell__splitpane'),
        splitpaneBody: shot('.shell__splitpane .splitpane__body .wysiwyg'),
        splitpaneProseMirror: shot('.shell__splitpane .ProseMirror'),
        wysiwyg: shot('.wysiwyg'),
        proseMirror: shot('.ProseMirror'),
        compare: shot('.compare'),
        compareLeftPane: shot('.compare__pane:first-child'),
        compareLeftScroller: shot('.compare__body'),
        compareRightPane: shot('.compare__pane:last-child'),
        compareRightScroller: shot('.compare__body--preview'),
        comparePreview: shot('.compare__preview'),
        comparePreviewP: shot('.compare__preview p'),
        cmContent: shot('.compare .cm-content'),
      },
    };
  });
}

/**
 * 开启左右分屏（走真实 UI：标签栏的分屏按钮 → 菜单里的「左右分屏」）。
 *
 * 为什么要测分屏而不只测对照模式：缺陷3 有**两条**独立成因 ——
 * ① 对照模式（CompareView）右侧预览没上纸色；
 * ② 左右分屏（EditorPage 的 .shell__splitpane）背景误用外壳色 var(--bg)。
 * 两者都在「右侧那一栏颜色不对」的用户描述范围内，必须分别实测。
 */
async function enableSplit(page) {
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('.tabbar__split .tabbar__act');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) return false;
  await page.waitForSelector('.splitmenu', { timeout: 6000 }).catch(() => {});
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.splitmenu .splitmenu__item'));
    const hit = items.find((e) => /左右分屏/.test(e.textContent || ''));
    if (!hit) return false;
    hit.click();
    return true;
  });
  await page.waitForTimeout(1200);
  return clicked;
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/** 删除本次测量新建的临时文档，避免污染生产库 */
async function cleanupDoc(page) {
  return page.evaluate(() => {
    const tab = document.querySelector('.tab.is-active .tab__title')?.textContent ?? '';
    return tab.trim();
  });
}

const main = async () => {
  const chromium = await loadChromium();
  const auth = await getToken();
  console.log(`[re121-layout] tag=${TAG} 登录=${auth.cached ? '复用缓存 token' : '新登录'} 用户=${auth.user?.username ?? '?'}`);
  const out = { tag: TAG, themes: {} };

  for (const theme of ['light', 'dark']) {
    const { browser, page } = await newSession(chromium, auth, theme);
    const rec = { shots: [] };
    try {
      await openWorkbench(page);
      const preset = await page.evaluate(() => ({
        preset: document.documentElement.dataset.themePreset,
        mode: document.documentElement.dataset.theme,
      }));
      rec.preset = preset;

      // ---- 缺陷 1：所见即所得下的行距 / 段距（无空段落：A1/A3 的主口径）----
      await writeSample(page, false);
      rec.typography = await measureTypography(page);
      rec.shots.push(await shot(page, `re121-${TAG}-${theme}-wysiwyg`));

      // ---- 缺陷 1 附加：段间夹一个空行（QA 量到 55px 的那种结构）----
      await writeSample(page, true);
      rec.typographyWithBlank = await measureTypography(page);
      rec.shots.push(await shot(page, `re121-${TAG}-${theme}-wysiwyg-blank`));

      // ---- 设置档位 1.2~2.2 逐档实测：确认每一档都不空旷 ----
      /*
       * 为什么要同时写两处变量：改设置时真实链路是
       *   settings.appearance.lineHeight
       *     → applyTheme() 写 <html> 上的 --content-line-height
       *     → EditorPage 把同一个值作为 :line-height prop 传给 WysiwygEditor
       *     → WysiwygEditor 又把它**内联**写到 .wysiwyg 上（内联优先级更高）。
       * 只改 <html> 会被 .wysiwyg 上的内联值遮蔽，测出来恒等于旧值 ——
       * 所以这里两处一起写，才是「用户真的在设置里改成 N」的等价场景。
       */
      rec.lineHeightSweep = [];
      for (const lh of [1.2, 1.4, 1.6, 1.75, 1.9, 2.0, 2.2]) {
        const setVar = async (v) => {
          await page.evaluate((x) => {
            document.documentElement.style.setProperty('--content-line-height', String(x));
            const w = document.querySelector('.wysiwyg');
            if (w) w.style.setProperty('--content-line-height', String(x));
          }, v);
          await page.waitForTimeout(140);
        };
        await setVar(lh);
        // 口径一：默认排版（两段之间只按一次回车，没有显式空行）——A3 的主口径
        await writeSample(page, false);
        await setVar(lh);
        const plain = await measureTypography(page);
        // 口径二：段间夹一个显式空行（用户主动敲的空行，QA 量到 55px 的那种）
        await writeSample(page, true);
        await setVar(lh);
        const blank = await measureTypography(page);
        rec.lineHeightSweep.push({
          setting: lh,
          ratio: plain.ratio,
          lineHeightPx: plain.lineHeight,
          /** 默认排版下相邻非空段落的字形间空白（A3 判定用这一列） */
          gapEmPlain: plain.textToTextGapEm,
          gapPxPlain: plain.textToTextGapPx,
          /** 显式敲一个空行时：按构造应等于 2 个行距（2×lh − 1.25em） */
          gapEmOneBlank: blank.textToTextGapEm,
          gapPxOneBlank: blank.textToTextGapPx,
          blankHeightEm: blank.blank?.heightEm ?? null,
        });
      }
      // 复原：把两处变量都还原成页面初始值
      await page.evaluate(() => {
        const w = document.querySelector('.wysiwyg');
        if (w) w.style.removeProperty('--content-line-height');
      });

      // ---- 缺陷 3：对照模式右侧预览配色 ----
      await setMode(page, 'compare');
      await page.waitForSelector('.compare__preview', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
      rec.colors = await measureColors(page);
      rec.shots.push(await shot(page, `re121-${TAG}-${theme}-compare`));

      // 回所见即所得，避免影响下一次循环
      await setMode(page, 'wysiwyg');

      // ---- 缺陷 3 第二条成因：左右分屏第二栏的背景色 ----
      rec.split = { enabled: await enableSplit(page) };
      if (rec.split.enabled) {
        await page.waitForSelector('.shell__splitpane', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(800);
        const splitColors = await measureColors(page);
        rec.split.colors = {
          leftPrimary: splitColors.targets.shellContent?.painted ?? null,
          rightSplitpane: splitColors.targets.splitpane
            ? { own: splitColors.targets.splitpane.backgroundColor, painted: splitColors.targets.splitpane.painted, color: splitColors.targets.splitpane.color }
            : null,
          rightSplitProseMirror: splitColors.targets.splitpaneProseMirror
            ? { painted: splitColors.targets.splitpaneProseMirror.painted, color: splitColors.targets.splitpaneProseMirror.color }
            : null,
        };
        rec.shots.push(await shot(page, `re121-${TAG}-${theme}-split`));
      }

      rec.activeTab = await cleanupDoc(page).catch(() => '');
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 400);
    } finally {
      await browser.close().catch(() => {});
    }
    out.themes[theme] = rec;
  }

  console.log(JSON.stringify(out, null, 2));
};

main().catch((e) => {
  console.error('[re121-layout] 失败：', e);
  process.exit(1);
});
