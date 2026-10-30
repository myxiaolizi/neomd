/**
 * 1.2.1 导出链路实测：把 `buildExportHtml()` 的产物真的放进 Chromium 里量高度。
 *
 * 为什么不能只静态核对 CSS 字符串：`min-height:1.6em` 在什么字号下生效、
 * 空段落最终占多少像素、「一个空行」在导出页里是否真的等于一个行盒 ——
 * 这些都只有让浏览器排版一次才知道。静态读 CSS 只能证明"规则写了"，
 * 证明不了"规则渲染出了预期的几何"。
 *
 * 用法：node tools/re121-export-probe.mjs
 * 输出：终端打印几何数值 + 截图 docs/shots-121/re121-export-blankline.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'shots-121');

/**
 * exporters.ts 内部的相对导入没写扩展名（'../vault/markdown-bridge'），
 * Node 的 ESM 解析器不接受这种写法（打包器/vitest 才接受）。
 * 因此这里**不用** Node 直接 import 它，而是在浏览器里跑：
 * 由 dev server 已经编译好的模块体系来解析 —— 但导出函数是 node 侧用的，
 * 前端没暴露。折中方案：直接调用 markdownToHtml 造出同样的 body HTML，
 * 再套上 BASE_CSS（从源码里读出来），这样测到的 CSS 与真实导出**同一份**。
 */
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
      errors.push(`${c}: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  throw new Error(`无法加载 Playwright：\n  - ${errors.join('\n  - ')}`);
}

/** 从源码里抠出真实的 BASE_CSS（保证与导出用的是同一份样式）。 */
function readBaseCss() {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/export/exporters.ts'), 'utf8');
  const m = /const BASE_CSS = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('未能从 exporters.ts 提取 BASE_CSS');
  return m[1];
}

const main = async () => {
  const { markdownToHtml } = await import(
    pathToFileURL(path.join(ROOT, 'packages/core/src/vault/markdown-bridge.ts')).href
  );
  const baseCss = readBaseCss();
  const chromium = await loadChromium();

  // 与 buildExportHtml 的 body 结构保持一致：<main class="neomd-export">…</main>
  const bodySource = 'A\n\n\nB\n'; // 2 个连续空行 → 1 个空段落
  const contentHtml = markdownToHtml(bodySource);
  const page1 = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head>
<body><main class="neomd-export">${contentHtml}</main></body></html>`;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 }).then((c) => c.newPage());
  await page.setContent(page1, { waitUntil: 'load' });
  await page.waitForTimeout(200);

  const geo = await page.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const ps = Array.from(document.querySelectorAll('.neomd-export > p'));
    const blank = document.querySelector('.neomd-export p.nm-blank');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const bodyCs = getComputedStyle(document.body);
    return {
      bodyLineHeight: bodyCs.lineHeight,
      bodyFontSize: bodyCs.fontSize,
      paragraphCount: ps.length,
      hasBlankNode: Boolean(blank),
      blank: blank
        ? {
            height: Math.round(box(blank).height * 100) / 100,
            marginTop: cs(blank).marginTop,
            marginBottom: cs(blank).marginBottom,
            minHeight: cs(blank).minHeight,
          }
        : null,
      normalParagraph: ps.length
        ? {
            marginTop: cs(ps[0]).marginTop,
            marginBottom: cs(ps[0]).marginBottom,
            height: Math.round(box(ps[0]).height * 100) / 100,
          }
        : null,
      /** 相邻两个非空段落（A 与 B）之间的实际空白 */
      gapBetweenTextParagraphs: (() => {
        const texts = ps.filter((p) => (p.textContent ?? '').trim());
        if (texts.length < 2) return null;
        const r1 = texts[0].getBoundingClientRect();
        const r2 = texts[1].getBoundingClientRect();
        return Math.round((r2.top - r1.bottom) * 100) / 100;
      })(),
    };
  });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shotPath = path.join(SHOT_DIR, 're121-export-blankline.png');
  await page.screenshot({ path: shotPath, fullPage: false });
  await browser.close();

  console.log('=== 导出 HTML 实测（真实 Chromium 排版） ===');
  console.log('输入 markdown :', JSON.stringify(bodySource));
  console.log('产出 HTML     :', JSON.stringify(contentHtml));
  console.log(JSON.stringify(geo, null, 2));
  console.log(`截图: ${path.relative(ROOT, shotPath).replace(/\\/g, '/')}`);

  // 断言：空段落 = 恰好一个行盒（1.6 × 16 = 25.6px），且 margin 归零
  const lineBox = parseFloat(geo.bodyFontSize) * 1.6;
  const ok =
    geo.hasBlankNode &&
    geo.blank.marginTop === '0px' &&
    geo.blank.marginBottom === '0px' &&
    Math.abs(geo.blank.height - lineBox) < 0.6;
  console.log(
    `\n断言：空段落高度 ${geo.blank?.height}px ≈ 一个行盒 ${lineBox}px，margin 归零 → ${ok ? 'PASS' : 'FAIL'}`,
  );
  process.exit(ok ? 0 : 1);
};

main().catch((e) => {
  console.error('[re121-export-probe] 失败：', e);
  process.exit(1);
});
