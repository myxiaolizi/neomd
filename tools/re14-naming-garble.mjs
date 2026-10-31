#!/usr/bin/env node
/**
 * 1.4 需求9 取证：设置里「命名模板」「AI 命名提示词」乱码 —— **分层定位**脚本。
 *
 * 只读，不写任何数据（除非显式传 --repair，那是另一半脚本的事）。
 *
 * 要回答三个问题：
 *   1. **源文件** 有没有被 GBK 破坏？（Node 按 UTF-8 读，搜 GBK 误解码特征串）
 *   2. **localStorage**（本机 `neomd.settings.v1`）里的值是什么？
 *   3. **云端**（GET /api/settings）里的值是什么？
 * 三者对比才能区分「源文件乱码」与「数据层乱码」，并判断乱码是本地产生还是云端下发。
 *
 * 关键诊断信号（本仓库此前的高发事故，务必区分）：
 *   - GBK 误解码：出现 `閿`/`銆`/`鏂`/`鐨`/`鈥`/`锛`/`鍚`/`瀛` 这类字符，
 *     一个中文字会膨胀成 2-3 个怪字（原 UTF-8 字节被当 GBK 读）；
 *   - 窄字符集替换：中文变成 **单个 ASCII `?`**（1 字符 → 1 个 `?`），
 *     原字节不可表示时被替换，长度基本不变 —— 这是本次实测看到的形态。
 *
 * 用法：
 *   node tools/re14-naming-garble.mjs            # 全量取证
 *   node tools/re14-naming-garble.mjs --json     # 仅输出机器可读 JSON
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = process.env.NEOMD_WEB || 'http://127.0.0.1:5178';
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const OUT_DIR = join(REPO, 'docs/shots-140');
const JSON_ONLY = process.argv.includes('--json');

const log = (...a) => {
  if (!JSON_ONLY) console.log(...a);
};
const hr = (t) => log(`\n=== ${t} ===`);

/* ------------------------------------------------------------------ */
/* 1. 源文件扫描                                                        */
/* ------------------------------------------------------------------ */

/**
 * 典型的 GBK 误解码字符集合。
 *
 * 原理：UTF-8 中文是 3 字节（E4-E9 开头），把这段字节按 GBK（2 字节一字）解读后，
 * 会映射到 `閿`(E9 8E) 这类生僻字；由于 3 字节会被切成 1.5 个 GBK 字符，
 * 整段中文就变成「怪字 + 半个怪字」的组合，视觉上是一串几乎不含正常汉字的乱码。
 */
const GBK_GARBLE = /[閿銆鏂鐨鈥锛鍚瀛鍒浜鏌鐗鍐璁浣鍔闁缁鏄鏈鍏夌]/;

/** 窄字符集替换：中文位置出现 `?`（且周围有 ASCII 且整体呈「问号密度异常高」） */
function questionMarkDensity(s) {
  if (!s) return 0;
  const total = [...s].length;
  const q = [...s].filter((c) => c === '?').length;
  return total ? q / total : 0;
}

/** 判断一个字符串是否已经被窄字符集破坏（问号占比高且不含正常中文） */
function looksAsciiReplaced(s) {
  if (typeof s !== 'string' || !s) return false;
  const hasCjk = /[\u4e00-\u9fa5]/.test(s);
  const q = [...s].filter((c) => c === '?').length;
  return !hasCjk && q > 0 && questionMarkDensity(s) > 0.08;
}

const SOURCE_FILES = [
  'apps/web/src/views/SettingsPage.vue',
  'apps/web/src/components/panels/SettingsModal.vue',
  'packages/core/src/settings/settings.ts',
  'packages/shared/src/naming.ts',
  'apps/web/src/stores/settings.ts',
  'apps/web/src/stores/app.ts',
  'packages/core/src/vault/registry.ts',
  'services/api/src/routes/settings.js',
];

function scanSources() {
  const report = [];
  for (const rel of SOURCE_FILES) {
    const abs = join(REPO, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      report.push({ file: rel, error: e.message });
      continue;
    }
    const lines = text.split(/\r?\n/);
    const hits = [];
    lines.forEach((line, i) => {
      if (GBK_GARBLE.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 140) });
    });
    report.push({ file: rel, lines: lines.length, gbkHits: hits.length, samples: hits.slice(0, 5) });
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* 2/3. 数据层取证                                                      */
/* ------------------------------------------------------------------ */

/** 用码点描述一个字符串，避免终端/管道二次转码误导判断 */
function describe(label, value) {
  if (typeof value !== 'string') return { label, type: typeof value, raw: String(value) };
  const cps = [...value];
  return {
    label,
    length: value.length,
    codepoints: value.length <= 40 ? cps.map((c) => c.codePointAt(0)) : `${value.length} chars`,
    hasCjk: /[\u4e00-\u9fa5]/.test(value),
    asciiQuestionCount: cps.filter((c) => c === '?').length,
    hasGbkGarble: GBK_GARBLE.test(value),
    asciiReplaced: looksAsciiReplaced(value),
    preview: value.slice(0, 120),
  };
}

let token = '';
async function loginOnce() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  token = body?.data?.accessToken ?? '';
  if (!token) throw new Error(`登录失败：${JSON.stringify(body).slice(0, 200)}`);
  return body.data.user;
}

async function fetchCloudNaming() {
  const res = await fetch(`${API}/api/settings?platform=web`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  const naming = body?.data?.payload?.naming ?? null;
  return {
    status: res.status,
    version: body?.data?.version ?? null,
    updatedAt: body?.data?.updatedAt ?? null,
    naming,
  };
}

/* ---------------- Playwright：读 localStorage 与输入框实际值 ---------------- */

function loadPlaywright() {
  const require2 = createRequire(import.meta.url);
  const candidates = [
    process.env.NEOMD_PLAYWRIGHT_CORE || '',
    join(REPO, 'node_modules/playwright-core'),
    'C:/Data/DSH/jdy-push/_work/pwtest/node_modules/playwright-core',
    'C:/Data/DSH/jdy-push/_work/_pw-scratch/node_modules/playwright-core',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      return require2(p);
    } catch {
      /* next */
    }
  }
  throw new Error(`未找到 playwright-core，尝试过：\n  ${candidates.join('\n  ')}`);
}

function chromeExe() {
  return join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
}

/**
 * 打开设置页，读三样东西：
 *  - localStorage `neomd.settings.v1` 里的 naming；
 *  - 「命名模板」input 的**实际 value**；
 *  - 「AI 命名提示词」textarea 的**实际 value**。
 * 后两者是用户真正看到的文字，是最直接的证据。
 */
async function probeBrowser() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // 注入令牌（键名与 api/client.ts:38-39 一致）
    await page.evaluate(
      async ({ api, user, pass }) => {
        const res = await fetch(`${api}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const d = (await res.json())?.data;
        if (!d?.accessToken) throw new Error('登录失败');
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
        return Boolean(pinia?._s?.get('app')?.vault);
      },
      { timeout: 25_000 },
    );
    // 给云端设置一次拉取机会（设置页打开会触发）
    await page.waitForTimeout(2500);

    const local = await page.evaluate(() => {
      const raw = localStorage.getItem('neomd.settings.v1');
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      return {
        hasRaw: Boolean(raw),
        rawLength: raw?.length ?? 0,
        naming: parsed?.naming ?? null,
        // 也把 store 的实时值取出来（可能已被云端覆盖）
        storeNaming: (() => {
          try {
            const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
            const s = pinia._s.get('settings');
            return s?.settings?.naming ?? null;
          } catch {
            return null;
          }
        })(),
      };
    });

    // 打开设置页（路由 /app 下切换设置标签），再读两个控件的实际 value
    const ui = await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      // 直接打开设置标签（与用户点「设置」等价）
      try {
        await app.openSettings?.();
      } catch {
        /* 忽略 */
      }
      return { opened: true };
    });
    await page.waitForTimeout(2500);

    const controls = await page.evaluate(() => {
      /** 在设置面板里找到「命名模板」后面的 input 与「AI 命名提示词」的 textarea */
      const findFieldByLabel = (labelText) => {
        const labels = [...document.querySelectorAll('label, .nm-label')];
        const target = labels.find((l) => (l.textContent || '').trim() === labelText);
        if (!target) return null;
        const field = target.closest('.field');
        if (!field) return null;
        return field.querySelector('input, textarea');
      };
      const tplEl = findFieldByLabel('命名模板');
      const aiEl = findFieldByLabel('AI 命名提示词');
      return {
        templatePresent: Boolean(tplEl),
        templateValue: tplEl ? tplEl.value : null,
        aiPresent: Boolean(aiEl),
        aiValue: aiEl ? aiEl.value : null,
        settingsPanelPresent: Boolean(document.querySelector('.pane, .settings')),
      };
    });

    return { local, controls };
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* 模式 4：存量修复（--repair / --repair --apply）                      */
/* ------------------------------------------------------------------ */

/**
 * 用**真实 core 代码**的纠偏函数判断并修复云端的 naming 乱码。
 *
 * 为什么用真代码而不是脚本里另写一份判据：判据（精确签名 + 强约束）必须
 * 与运行时**完全一致**，否则会出现「脚本说该修、应用说不修」的错位。
 * 用 esbuild 现场 bundle `packages/core/src/settings/settings.ts` 拿到真函数。
 */
async function loadRepairFns() {
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const esbuildPath = join(REPO, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js');
  const esbuild = require2(esbuildPath);
  const outfile = join(REPO, 'packages/core/.re14-settings-bundle.mjs');
  await esbuild.build({
    entryPoints: [join(REPO, 'packages/core/src/settings/settings.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    alias: { '@neomd/shared': join(REPO, 'packages/shared/src/index.ts') },
    external: ['markdown-it', 'minisearch', 'sql.js'],
  });
  const mod = await import(pathToFileURL(outfile).href);
  return {
    mod,
    cleanup: async () => {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(outfile, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

async function repair({ apply }) {
  hr(`存量乱码修复（${apply ? 'APPLY —— 会写云端' : 'DRY-RUN —— 只读'}）`);
  const { mod, cleanup } = await loadRepairFns();
  const { repairGarbleNaming, defaultSettings } = mod;
  if (typeof repairGarbleNaming !== 'function') {
    await cleanup();
    throw new Error('core 未导出 repairGarbleNaming（请确认 settings.ts 的改动已保存）');
  }

  try {
    const cloud = await fetchCloudNaming();
    const before = cloud.naming;
    if (!before) {
      log('  云端没有 naming，无需修复');
      return { repaired: [], applied: false };
    }

    log('  修复前：');
    for (const k of ['template', 'fallback', 'aiPrompt']) {
      log(`    ${k.padEnd(9)} = ${JSON.stringify(String(before[k] ?? '').slice(0, 90))}`);
    }

    const { naming: after, repaired, backup } = repairGarbleNaming(before);
    log(`\n  判定结果：${repaired.length ? repaired.join(', ') + ' 需要修复' : '无字段命中乱码签名，保持原样'}`);
    if (!repaired.length) {
      log('  ✓ 云端数据健康，无需修复');
      return { repaired: [], applied: false };
    }
    if (backup) {
      log(`  备份原值到 naming.garbleBackup（at=${new Date(backup.at).toISOString()}）`);
    }

    log('\n  修复后（将要写入的值）：');
    for (const k of ['template', 'fallback', 'aiPrompt']) {
      log(`    ${k.padEnd(9)} = ${JSON.stringify(String(after[k] ?? '').slice(0, 90))}`);
    }

    if (!apply) {
      log('\n  DRY-RUN：未写入。确认无误后加 --apply 执行。');
      return { repaired, applied: false, after };
    }

    // 写入：把纠偏后的整份 naming PUT 回云端
    const res = await fetch(`${API}/api/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        payload: { global: { naming: after } },
        version: cloud.version ?? 0,
        deviceId: 're14-garble-repair',
        platform: 'web',
      }),
    });
    log(`\n  写入状态 ${res.status}`);
    const verify = await fetchCloudNaming();
    const v = verify.naming;
    const ok = repaired.every((k) => {
      const def = defaultSettings().naming[k];
      return String(v?.[k] ?? '') === String(def ?? '');
    });
    log('  写回校验：');
    for (const k of ['template', 'fallback', 'aiPrompt']) {
      log(`    ${k.padEnd(9)} = ${JSON.stringify(String(v?.[k] ?? '').slice(0, 90))}`);
    }
    log(ok ? '  ✓ 修复已生效并校验通过' : '  ✗ 写回值与默认值不一致，请人工检查');
    if (v?.garbleBackup) log(`  ✓ 原值备份已随命名设置持久化（garbleBackup）`);
    return { repaired, applied: true, ok, after: v };
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const result = { at: new Date().toISOString(), api: API, web: WEB };

  const doRepair = process.argv.includes('--repair');
  const isJsonOnly = process.argv.includes('--json');

  if (doRepair) {
    await loginOnce();
    const apply = process.argv.includes('--apply');
    result.repair = await repair({ apply });
    const outRepair = join(OUT_DIR, 're14-naming-repair.json');
    writeFileSync(outRepair, JSON.stringify(result, null, 2), 'utf8');
    log(`\n  证据 JSON → ${outRepair}`);
    if (apply && result.repair.applied && !result.repair.ok) process.exitCode = 1;
    return;
  }

  hr('1. 源文件扫描（Node 按 UTF-8 读）');
  result.sources = scanSources();
  let totalGbk = 0;
  for (const r of result.sources) {
    if (r.error) {
      log(`  ${r.file}  读取失败：${r.error}`);
      continue;
    }
    totalGbk += r.gbkHits;
    const mark = r.gbkHits ? '✗' : '✓';
    log(`  ${mark} ${r.file}  lines=${r.lines}  GBK乱码命中=${r.gbkHits}`);
    for (const s of r.samples) log(`      ${s.line}: ${s.text}`);
  }
  result.sourceGbkTotal = totalGbk;
  log(totalGbk === 0 ? '\n✓ 源文件无 GBK 乱码（乱码必在数据层）' : `\n✗ 源文件有 ${totalGbk} 处 GBK 乱码`);

  hr('2. 云端 GET /api/settings 的 naming');
  await loginOnce();
  const cloud = await fetchCloudNaming();
  result.cloud = cloud;
  if (cloud.naming) {
    for (const k of ['template', 'fallback', 'aiPrompt']) {
      const d = describe(k, cloud.naming[k]);
      result.cloud.described = result.cloud.described ?? {};
      result.cloud.described[k] = d;
      log(`  ${d.label}: len=${d.length} hasCjk=${d.hasCjk} '?'数=${d.asciiQuestionCount} GBK乱码=${d.hasGbkGarble} 窄字符集替换=${d.asciiReplaced}`);
      if (d.codepoints) log(`      codepoints=${d.codepoints}`);
      log(`      preview=${JSON.stringify(d.preview)}`);
    }
    log(`  （云端 version=${cloud.version} updatedAt=${cloud.updatedAt}）`);
  } else {
    log('  云端没有 naming（null）');
  }

  hr('3. 浏览器 localStorage + 设置页控件实际值');
  try {
    const b = await probeBrowser();
    result.browser = b;
    log(`  localStorage 有值=${b.local.hasRaw} rawLength=${b.local.rawLength}`);
    if (b.local.naming) {
      for (const k of ['template', 'fallback', 'aiPrompt']) {
        const v = b.local.naming[k];
        const d = describe(k, v);
        log(`  [localStorage] ${k}: len=${d.length} hasCjk=${d.hasCjk} '?'数=${d.asciiQuestionCount} GBK乱码=${d.hasGbkGarble} 窄字符集替换=${d.asciiReplaced}`);
        log(`      preview=${JSON.stringify(d.preview)}`);
      }
    } else {
      log('  localStorage 里没有 naming（首次启动或被清空）');
    }
    if (b.local.storeNaming) {
      log(`  [store 实时] template=${JSON.stringify(b.local.storeNaming.template)}`);
      log(`  [store 实时] aiPrompt=${JSON.stringify(String(b.local.storeNaming.aiPrompt ?? '').slice(0, 60))}`);
    }
    log(`  [控件] 命名模板 input 存在=${b.controls.templatePresent} value=${JSON.stringify(b.controls.templateValue)}`);
    log(`  [控件] AI 提示词 textarea 存在=${b.controls.aiPresent} value=${JSON.stringify(String(b.controls.aiValue ?? '').slice(0, 80))}`);
  } catch (e) {
    result.browserError = e.message;
    log(`  ! 浏览器取证失败：${e.message}`);
  }

  const outJson = join(OUT_DIR, 're14-naming-garble-probe.json');
  writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
  hr('结论');
  log(`  源文件 GBK 乱码：${totalGbk} 处`);
  log(`  云端 template 是否窄字符集替换：${result.cloud?.described?.template?.asciiReplaced ?? 'n/a'}`);
  log(`  云端 aiPrompt 是否窄字符集替换：${result.cloud?.described?.aiPrompt?.asciiReplaced ?? 'n/a'}`);
  log(`  本机 localStorage template 是否替换：${result.browser?.local?.naming ? looksAsciiReplaced(result.browser.local.naming.template) : 'n/a'}`);
  log(`\n  证据 JSON → ${outJson}`);
}

await main();
