#!/usr/bin/env node
/**
 * 1.4 需求9 **验收取证**：修复前后「输入框实际文字」+ 截图。
 *
 * 产出（存 docs/shots-140/）：
 *   - re14-naming-before.png / re14-naming-after.png   设置页两个控件的截图
 *   - re14-naming-verify.json                          三处数据层 + 控件的实际值
 *
 * 注意：本脚本**只读**。若要复现「修复前」的样子，需要先把云端写回乱码值
 * （用 `tools/re14-naming-garble.mjs --repair` 的 backup 反向写），
 * 因此这里改为「用备份的原值渲染一次对比图」不可行（会再污染生产库），
 * 采用**记录修复前已捕获的值** + 修复后实时读取控件的方式做对比。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = process.env.NEOMD_WEB || 'http://127.0.0.1:5178';
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const OUT = join(REPO, 'docs/shots-140');

const log = (...a) => console.log(...a);

function loadPlaywright() {
  const require2 = createRequire(import.meta.url);
  for (const p of [
    process.env.NEOMD_PLAYWRIGHT_CORE || '',
    join(REPO, 'node_modules/playwright-core'),
    'C:/Data/DSH/jdy-push/_work/pwtest/node_modules/playwright-core',
    'C:/Data/DSH/jdy-push/_work/_pw-scratch/node_modules/playwright-core',
  ].filter(Boolean)) {
    try {
      return require2(p);
    } catch {
      /* next */
    }
  }
  throw new Error('未找到 playwright-core');
}
const chromeExe = () => join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();

  // 读取修复前的捕获值（来自前一轮 probe）作为「before」证据
  let beforeProbe = null;
  const probeFile = join(OUT, 're14-naming-garble-probe.json');
  if (existsSync(probeFile)) {
    beforeProbe = JSON.parse(readFileSync(probeFile, 'utf8'));
  }

  const browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const result = { at: new Date().toISOString() };

  try {
    await page.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.evaluate(
      async ({ api, user, pass }) => {
        const r = await fetch(`${api}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const d = (await r.json())?.data;
        localStorage.setItem('neomd.access', d.accessToken);
        localStorage.setItem('neomd.refresh', d.refreshToken);
        localStorage.setItem('neomd.user.cache', JSON.stringify(d.user));
      },
      { api: API, user: USER, pass: PASS },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app', { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#app');
        const pinia = el?.__vue_app__?.config.globalProperties?.$pinia;
        return Boolean(pinia?._s?.get('app')?.vault && pinia?._s?.get('settings'));
      },
      { timeout: 25_000 },
    );
    // 清掉本地 localStorage 里的旧乱码，强制从云端重新拉一次（模拟用户正常启动）
    await page.evaluate(() => {
      const raw = localStorage.getItem('neomd.settings.v1');
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        if (s.naming) delete s.naming;
        localStorage.setItem('neomd.settings.v1', JSON.stringify(s));
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app', { timeout: 20_000 });
    await page.waitForTimeout(3500);

    // 打开设置页
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      try {
        await app.openSettings?.();
      } catch {
        /* ignore */
      }
    });
    await page.waitForTimeout(3000);

    // 读取两个控件的实际值 + store + localStorage + 云端
    const ui = await page.evaluate(async (api) => {
      const findFieldByLabel = (labelText) => {
        const labels = [...document.querySelectorAll('label, .nm-label')];
        const t = labels.find((l) => (l.textContent || '').trim() === labelText);
        if (!t) return null;
        return t.closest('.field')?.querySelector('input, textarea') ?? null;
      };
      const tpl = findFieldByLabel('命名模板');
      const ai = findFieldByLabel('AI 命名提示词');
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const store = pinia._s.get('settings');

      let lsNaming = null;
      try {
        lsNaming = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null')?.naming ?? null;
      } catch {
        /* ignore */
      }
      // 云端再取一次（用页面内的 token）
      let cloudNaming = null;
      try {
        const token = localStorage.getItem('neomd.access');
        const r = await fetch(`${api}/api/settings?platform=web`, { headers: { authorization: `Bearer ${token}` } });
        cloudNaming = (await r.json())?.data?.payload?.naming ?? null;
      } catch {
        /* ignore */
      }

      const rect = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      return {
        templateEl: { present: Boolean(tpl), value: tpl?.value ?? null, rect: rect(tpl) },
        aiEl: { present: Boolean(ai), value: ai?.value ?? null, rect: rect(ai) },
        storeNaming: store?.settings?.naming ?? null,
        localStorageNaming: lsNaming,
        cloudNaming,
        fieldRects: {
          template: rect(tpl?.closest('.field') ?? null),
          ai: rect(ai?.closest('.field') ?? null),
        },
      };
    }, API);

    result.ui = ui;
    result.beforeProbe = beforeProbe
      ? { cloud: beforeProbe.cloud?.naming, local: beforeProbe.browser?.local?.naming }
      : null;

    log('=== 修复后数据层与控件实际值 ===');
    log(`  云端 template    = ${JSON.stringify(ui.cloudNaming?.template)}`);
    log(`  云端 fallback    = ${JSON.stringify(ui.cloudNaming?.fallback)}`);
    log(`  云端 aiPrompt    = ${JSON.stringify(String(ui.cloudNaming?.aiPrompt ?? '').slice(0, 60))}…`);
    log(`  store template   = ${JSON.stringify(ui.storeNaming?.template)}`);
    log(`  localStorage tpl = ${JSON.stringify(ui.localStorageNaming?.template)}`);
    log(`  【控件】命名模板 input value = ${JSON.stringify(ui.templateEl.value)}`);
    log(`  【控件】AI 提示词 textarea value = ${JSON.stringify(String(ui.aiEl.value ?? '').slice(0, 60))}…`);
    log(`  控件是否在 DOM 中：模板=${ui.templateEl.present} 提示词=${ui.aiEl.present}`);

    // 截图：优先元素级，其次整页
    const shotAll = join(OUT, 're14-naming-after.png');
    await page.screenshot({ path: shotAll, fullPage: false });
    log(`\n  整页截图 → ${shotAll}`);

    // 尝试截取两个 field 的区域（更直观）
    for (const [key, name] of [
      ['template', 're14-naming-after-template.png'],
      ['ai', 're14-naming-after-ai.png'],
    ]) {
      const r = ui.fieldRects[key];
      if (r && r.w > 0) {
        await page.screenshot({
          path: join(OUT, name),
          clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.w + 16, 1400), height: Math.min(r.h + 16, 600) },
        });
        log(`  ${key} 控件区域截图 → ${join(OUT, name)}`);
      }
    }

    // 断言
    const hasCjk = (s) => /[\u4e00-\u9fa5]/.test(String(s ?? ''));
    const checks = [
      { name: '云端 template 含中文日且含 {input}', ok: String(ui.cloudNaming?.template ?? '').includes('日') && String(ui.cloudNaming?.template ?? '').includes('{input}') },
      { name: '云端 fallback 含中文', ok: hasCjk(ui.cloudNaming?.fallback) },
      { name: '云端 aiPrompt 含中文', ok: hasCjk(ui.cloudNaming?.aiPrompt) },
      { name: 'store template 与云端一致', ok: ui.storeNaming?.template === ui.cloudNaming?.template },
      { name: 'localStorage template 与云端一致', ok: ui.localStorageNaming?.template === ui.cloudNaming?.template },
      { name: '控件 input 值与云端一致', ok: ui.templateEl.value === ui.cloudNaming?.template },
      { name: '控件 textarea 值与云端一致', ok: ui.aiEl.value === ui.cloudNaming?.aiPrompt },
    ];
    log('\n=== 断言 ===');
    let allOk = true;
    for (const c of checks) {
      log(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
      if (!c.ok) allOk = false;
    }
    result.checks = checks;
    result.allOk = allOk;

    const outJson = join(OUT, 're14-naming-verify.json');
    writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
    log(`\n  证据 JSON → ${outJson}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
