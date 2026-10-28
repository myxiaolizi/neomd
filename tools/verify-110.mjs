/**
 * Neo MD 1.1.0 关键项实测脚本。
 *
 * 覆盖本次三大新增功能：
 *   一、Obsidian 仓库导入（设置入口、时间戳保留说明、语法预检、报告表格）
 *   二、AI 知识库（五种颗粒度、检索参数、实时统计、测试检索）
 *   三、思维导图与流程图（对齐 ProcessOn 的四段式布局、图形库、属性面板、导出）
 *
 * 用法：
 *   node tools/verify-110.mjs
 *   SMOKE_BASE=https://md.zhengl.vip node tools/verify-110.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-110');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4173';
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${extra ? ` → ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--headless=new', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const httpErrors = [];
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('/api/')) httpErrors.push(`${r.status()} ${r.url().slice(0, 120)}`);
});
page.on('pageerror', (e) => console.log('    [pageerror]', String(e.message).slice(0, 160)));

/** 打开设置页并切到指定页签 */
async function openSettingsTab(label) {
  // 关掉可能已打开的设置标签
  const settingsTab = page.locator('.tab', { hasText: '设置' }).first();
  if (!(await settingsTab.count())) {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(1500);
  }
  const nav = page.locator('.settings__nav-item', { hasText: label }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(900);
    return true;
  }
  return false;
}

try {
  /* ============ 进入编辑器 ============ */
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2200);
    }
  }
  await page.screenshot({ path: path.join(shots, '00-editor.png') });

  /* ============ 一、Obsidian 导入 ============ */
  console.log('\n[一.1] 设置页「导入」入口');
  /**
   * 1.1.8 起设置入口**只在用户头像菜单**里（用户明确要求界面上不再出现独立设置按钮），
   * 因此不能再断言「功能区存在 title 含『打开设置』的按钮」。
   * 改为：能用快捷键打开设置即可（这仍是受支持的入口）。
   */
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(1800);
  const settingsOpened = await page.locator('.settings__nav-item').count();
  check(settingsOpened > 0, '可通过 Ctrl+, 打开设置页', `${settingsOpened} 个页签`);

  const tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.settings__nav-item')).map((n) => (n.textContent || '').trim()),
  );
  console.log('    设置页签：', tabLabels.join(' / '));
  // 「导入」页签标了 nativeOnly：导入需要读取本地文件系统，网页端按设计隐藏。
  // 因此这里断言「非网页端必须存在，网页端按设计隐藏」，避免误报。
  const isDesktopShell = await page.evaluate(() => document.documentElement.dataset.runtime === 'desktop');
  if (isDesktopShell) {
    check(tabLabels.includes('导入'), 'PC 端设置页存在「导入」页签', tabLabels.join('/'));
  } else {
    check(!tabLabels.includes('导入'), '网页端按设计隐藏「导入」页签（需 PC 客户端）');
  }

  if (tabLabels.includes('导入')) {
    await page.locator('.settings__nav-item', { hasText: '导入' }).first().click();
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(shots, '01-obsidian-import.png') });
    const importInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        hasPickDir: /选择目录|选择文件夹|选择 Obsidian/.test(text),
        hasTimestamp: /修改日期|修改时间|时间戳/.test(text),
        hasKeepTs: /保留.*时间|时间.*保留/.test(text),
        hasConvert: /转换|换行|Callout|高亮|注释/.test(text),
      };
    });
    console.log('    ', JSON.stringify(importInfo));
    check(importInfo.hasPickDir, '有「选择目录」入口');
    check(importInfo.hasTimestamp, '界面提到修改日期/时间戳');
    check(importInfo.hasKeepTs, '有「保留时间」相关选项');
    check(importInfo.hasConvert, '有语法转换相关选项');
  }

  /* ============ 二、AI 知识库 ============ */
  console.log('\n[二.1] 设置页「知识库」入口');
  check(tabLabels.includes('知识库'), '设置页存在「知识库」页签', tabLabels.join('/'));

  if (tabLabels.includes('知识库')) {
    await page.locator('.settings__nav-item', { hasText: '知识库' }).first().click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(shots, '02-knowledge.png') });

    // 知识库默认是「关闭」状态，此时面板只显示精简视图；
    // 必须先打开总开关，完整的多颗粒度设置才会展开。
    const sw = page.locator('.kb-switch input, input[aria-label="启用知识库"]').first();
    if (await sw.count()) {
      const checked = await sw.isChecked().catch(() => false);
      if (!checked) {
        await sw.click({ force: true });
        await page.waitForTimeout(1500);
      }
    }
    await page.screenshot({ path: path.join(shots, '02b-knowledge-enabled.png') });

    console.log('\n[二.2] 五种颗粒度（用户明确要求的多颗粒度精细化设置）');
    const granularity = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        doc: /整篇文档|整篇/.test(text),
        heading: /按标题|标题切分/.test(text),
        paragraph: /按段落|段落切分/.test(text),
        sentence: /按句子|句子切分/.test(text),
        block: /固定长度|字符数.*窗口|滑动窗口/.test(text),
      };
    });
    console.log('    ', JSON.stringify(granularity));
    check(granularity.doc, '颗粒度含「整篇文档」');
    check(granularity.heading, '颗粒度含「按标题」');
    check(granularity.paragraph, '颗粒度含「按段落」');
    check(granularity.sentence, '颗粒度含「按句子」');
    check(granularity.block, '颗粒度含「固定长度窗口」');
    const gCount = Object.values(granularity).filter(Boolean).length;
    check(gCount === 5, '五种颗粒度全部呈现', String(gCount));

    console.log('\n[二.3] 检索精细化参数');
    const params = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const inputs = document.querySelectorAll('input[type="range"], input[type="number"]');
      return {
        hasTopK: /topK|返回.*条|片段数/i.test(text),
        hasMinScore: /minScore|阈值|相关性/i.test(text),
        hasMode: /关键词|混合|向量/.test(text),
        sliderCount: inputs.length,
        hasStats: /切片|文档数|平均/.test(text),
      };
    });
    console.log('    ', JSON.stringify(params));
    check(params.hasTopK, '有 topK 相关设置');
    check(params.hasMinScore, '有 minScore/阈值设置');
    check(params.hasMode, '有三种检索模式');
    check(params.sliderCount >= 3, '存在滑块/数字输入控件', String(params.sliderCount));
    check(params.hasStats, '有实时统计（切片数等）');

    console.log('\n[二.4] 测试检索区');
    const hasTest = await page.evaluate(() => /测试检索|试一下|检索测试/.test(document.body.innerText || ''));
    check(hasTest, '有「测试检索」区域');
  }

  /* ============ 三、思维导图与流程图 ============ */
  console.log('\n[三.1] 功能区图编辑器入口');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const ribbonTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ribbon__btn')).map((b) => b.getAttribute('title') || ''),
  );
  console.log('    功能区按钮：', ribbonTitles.join(' | ').slice(0, 400));
  const hasFlowEntry = ribbonTitles.some((t) => /流程图/.test(t));
  const hasMindEntry = ribbonTitles.some((t) => /思维导图/.test(t));
  check(hasFlowEntry || hasMindEntry, '功能区存在图编辑器入口', `flow=${hasFlowEntry} mind=${hasMindEntry}`);

  console.log('\n[三.2] 创建并打开流程图');
  if (hasFlowEntry) {
    const flowIdx = ribbonTitles.findIndex((t) => /流程图/.test(t));
    await page.locator('.ribbon__btn').nth(flowIdx).click();
    await page.waitForTimeout(2800);
    await page.screenshot({ path: path.join(shots, '03-flowchart.png') });

    // 文件名必须落成纯 .flow，不能被补成 .flow.md。
    // 注意：标签栏显示的是 title（已去掉扩展名），因此改从左侧文件树的 title 属性
    // 与状态栏路径判断；这两处都带真实 path。
    const flowTabTitle = await page.locator('.tab.is-active .tab__title').first().textContent().catch(() => '');
    const flowPaths = await page.evaluate(() => {
      const out = [];
      // 状态栏路径按钮的 title 里带完整相对路径
      const pathBtn = document.querySelector('.st--path');
      if (pathBtn) out.push(pathBtn.getAttribute('title') || '');
      // 文件树条目的 title 属性通常是完整 path
      for (const el of Array.from(document.querySelectorAll('[title]'))) {
        const t = el.getAttribute('title') || '';
        if (/\.(flow|mind)(\.md)?$/.test(t)) out.push(t);
      }
      return out;
    });
    console.log('    标签:', flowTabTitle, '| 路径线索:', JSON.stringify(flowPaths.slice(0, 4)));
    const hasFlowPath = flowPaths.some((p) => /\.flow$/.test(p));
    const hasBadPath = flowPaths.some((p) => /\.flow\.md$/.test(p));
    check(hasFlowPath && !hasBadPath, '流程图落成纯 .flow（未被补成 .flow.md）', flowPaths.slice(0, 2).join(' | '));

    // 四段式布局对齐 ProcessOn：工具栏 48 / 图形库 200 / 画布 / 属性面板 280 / 状态栏 28
    const layout = await page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const h = (sel) => {
        const el = q(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      const w = (sel) => {
        const el = q(sel);
        return el ? Math.round(el.getBoundingClientRect().width) : null;
      };
      return {
        toolbarH: h('.flow__toolbar'),
        libW: w('.flow__lib'),
        propsW: w('.flow__props'),
        statusH: h('.flow__status'),
        canvasSvg: Boolean(q('.flow__canvas svg')),
        libItems: document.querySelectorAll('.lib-item').length,
        hasAlign: /对齐|分布/.test(document.querySelector('.flow__toolbar')?.textContent || ''),
      };
    });
    console.log('    ', JSON.stringify(layout));
    check(layout.toolbarH === 48, '顶部工具栏 48px', String(layout.toolbarH));
    check(layout.libW === 200, '左侧图形库 200px', String(layout.libW));
    check(layout.propsW === 280, '右侧属性面板 280px', String(layout.propsW));
    check(layout.statusH === 28, '底部状态栏 28px', String(layout.statusH));
    check(layout.canvasSvg, '中间是 SVG 画布');
    check(layout.libItems >= 6, '图形库有多个形状可选', String(layout.libItems));

    // 点击图形库添加一个节点 → 画布节点数 +1
    const before = await page.evaluate(() => document.querySelectorAll('.flow__canvas svg g[class*="node"], .flow__canvas .dcanvas__nodes > g').length);
    const firstShape = page.locator('.lib-item').first();
    if (await firstShape.count()) {
      await firstShape.click();
      await page.waitForTimeout(900);
    }
    const after = await page.evaluate(() => document.querySelectorAll('.flow__canvas svg g[class*="node"], .flow__canvas .dcanvas__nodes > g').length);
    console.log(`    画布节点数：${before} → ${after}`);
    check(after > before, '点击图形库后画布新增节点', `${before} → ${after}`);
    await page.screenshot({ path: path.join(shots, '03b-flowchart-node.png') });
  }

  console.log('\n[三.3] 创建并打开思维导图');
  if (hasMindEntry) {
    // 用最新一次的 ribbon 列表定位思维导图按钮
    const titles2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ribbon__btn')).map((b) => b.getAttribute('title') || ''),
    );
    const idx = titles2.findIndex((t) => /思维导图/.test(t));
    if (idx >= 0) {
      await page.locator('.ribbon__btn').nth(idx).click();
      await page.waitForTimeout(2800);
      await page.screenshot({ path: path.join(shots, '04-mindmap.png') });

      const mindTabTitle = await page.locator('.tab.is-active .tab__title').first().textContent().catch(() => '');
      const mindPaths = await page.evaluate(() => {
        const out = [];
        const pathBtn = document.querySelector('.st--path');
        if (pathBtn) out.push(pathBtn.getAttribute('title') || '');
        for (const el of Array.from(document.querySelectorAll('[title]'))) {
          const t = el.getAttribute('title') || '';
          if (/\.(flow|mind)(\.md)?$/.test(t)) out.push(t);
        }
        return out;
      });
      console.log('    标签:', mindTabTitle, '| 路径线索:', JSON.stringify(mindPaths.slice(0, 4)));
      const hasMindPath = mindPaths.some((p) => /\.mind$/.test(p));
      const hasBadMind = mindPaths.some((p) => /\.mind\.md$/.test(p));
      check(hasMindPath && !hasBadMind, '思维导图落成纯 .mind（未被补成 .mind.md）', mindPaths.slice(0, 2).join(' | '));

      const mlayout = await page.evaluate(() => {
        const h = (sel) => {
          const el = document.querySelector(sel);
          return el ? Math.round(el.getBoundingClientRect().height) : null;
        };
        const w = (sel) => {
          const el = document.querySelector(sel);
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        };
        return {
          toolbarH: h('.mind__toolbar'),
          treeW: w('.mind__tree'),
          propsW: w('.mind__props'),
          statusH: h('.mind__status'),
          hasSvg: Boolean(document.querySelector('.mind__canvas svg')),
          treeRows: document.querySelectorAll('.tree__row').length,
          hasDirections: /布局：/.test(document.querySelector('.mind__toolbar')?.textContent || ''),
          hasTheme: /主题/.test(document.querySelector('.mind__toolbar')?.textContent || ''),
          hasOutline: /大纲/.test(document.querySelector('.mind__toolbar')?.textContent || ''),
        };
      });
      console.log('    ', JSON.stringify(mlayout));
      check(mlayout.toolbarH === 48, '顶部工具栏 48px', String(mlayout.toolbarH));
      check(mlayout.treeW === 200, '左侧结构树 200px', String(mlayout.treeW));
      check(mlayout.propsW === 280, '右侧样式面板 280px', String(mlayout.propsW));
      check(mlayout.statusH === 28, '底部状态栏 28px', String(mlayout.statusH));
      check(mlayout.hasSvg, '中间是 SVG 画布');
      check(mlayout.treeRows >= 1, '结构树渲染出节点', String(mlayout.treeRows));
      check(mlayout.hasDirections, '有布局方向切换');
      check(mlayout.hasTheme, '有主题配色');
      check(mlayout.hasOutline, '有大纲互转入口');
    }
  }

  check(httpErrors.length === 0, '无前端资源 4xx/5xx', httpErrors.slice(0, 3).join(' | '));
} catch (e) {
  check(false, '脚本异常', String(e?.message ?? e).slice(0, 300));
  await page.screenshot({ path: path.join(shots, '99-error.png') }).catch(() => undefined);
} finally {
  await browser.close();
}

console.log(`\n===== 通过 ${pass}，失败 ${failures.length} =====`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
console.log(`截图：${shots}`);
process.exit(failures.length ? 1 : 0);
