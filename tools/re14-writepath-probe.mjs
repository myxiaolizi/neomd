#!/usr/bin/env node
/**
 * 1.4 需求9 **决定性实验**：判断乱码是「历史脏数据」还是「写入路径仍在产生乱码」。
 *
 * 方法（只碰 naming 一个字段，写入前先备份原值）：
 *   1. 读云端现状（备份到本地文件，供回滚）；
 *   2. 直接用 fetch 把**正确的默认 naming** PUT 上去（绕过浏览器，排除前端因素）；
 *   3. 立刻 GET 读回，对比：值正确 → 服务端链路是好的，乱码来自前端写入；
 *   4. 再用浏览器内的 store（真实 pushCloudSettings 路径）推一次同样内容；
 *   5. 再 GET 对比：若此时变 `?` → **写入路径仍在污染**，必须先修它；
 *   6. finally 把第 1 步备份的原值 PUT 回去（不改变生产数据语义）。
 *
 * 用法：
 *   node tools/re14-writepath-probe.mjs             # 跑实验并自动回滚
 *   node tools/re14-writepath-probe.mjs --keep      # 不自动回滚（调试用，慎用）
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
const OUT_DIR = join(REPO, 'docs/shots-140');
const KEEP = process.argv.includes('--keep');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n=== ${t} ===`);

/** 期望的正确 naming（与 packages/core/src/settings/settings.ts 默认值一致） */
const CORRECT = {
  mode: 'datetime-input',
  template: 'YYMMDD日HHMM-{input}',
  fallback: '无标题',
  confirmBeforeRename: false,
  aiPrompt: [
    '你是笔记标题生成器。阅读用户给出的 Markdown 正文，生成一个准确、简洁的中文标题。',
    '要求：',
    '1. 只输出标题本身，不要引号、不要标点结尾、不要解释；',
    '2. 长度 6-24 个汉字（英文概念可保留原词）；',
    '3. 若正文含一级标题，可参考但需更精炼；',
    '4. 不得包含 / \\ : * ? " < > | 等文件名非法字符。',
  ].join('\n'),
  appendAiSummary: true,
};

let token = '';
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  token = body?.data?.accessToken ?? '';
  if (!token) throw new Error(`登录失败 ${JSON.stringify(body).slice(0, 200)}`);
}

async function getSettings() {
  const res = await fetch(`${API}/api/settings?platform=web`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json())?.data;
}

async function putNaming(naming) {
  const cur = await getSettings();
  const res = await fetch(`${API}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      payload: { global: { naming } },
      version: cur?.version ?? 0,
      deviceId: 're14-writepath-probe',
      platform: 'web',
    }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** 判定一个 naming 值是否被污染 */
function verdict(naming) {
  const t = naming?.template ?? '';
  const f = naming?.fallback ?? '';
  const a = naming?.aiPrompt ?? '';
  const hasCjk = (s) => /[\u4e00-\u9fa5]/.test(s);
  return {
    template: t,
    fallback: f,
    aiPromptHead: a.slice(0, 40),
    templateOk: t.includes('日') && t.includes('{input}'),
    fallbackOk: hasCjk(f),
    aiPromptOk: hasCjk(a),
    // 粗判：模板里出现 '?' 且没有中文 → 被替换
    templateGarbled: !hasCjk(t) && t.includes('?'),
    aiPromptGarbled: !hasCjk(a) && a.includes('?'),
  };
}

/* ---------------- 浏览器侧（走真实 store 推送路径） ---------------- */

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
  throw new Error('未找到 playwright-core');
}
const chromeExe = () => join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

/**
 * 在真实页面里：把 store 的 naming 设为正确值并调用 pushCloudSettings。
 *
 * 这里刻意不用 UI 输入框，而是直接改 store + 调推送函数 ——
 * 目的就是复刻「用户正常输入后保存」的那条代码路径，
 * 但不引入 DOM 交互的干扰（是否点中、是否触发 @input）。
 */
async function browserPushCorrectNaming() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.evaluate(
      async ({ api, user, pass }) => {
        const res = await fetch(`${api}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const d = (await res.json())?.data;
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
    await page.waitForTimeout(2000);

    return await page.evaluate(async (correct) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const store = pinia._s.get('settings');
      const before = JSON.parse(JSON.stringify(store.settings.naming));
      // 直接写正确值（等价于用户在输入框里输入正确内容后 @input 触发 patchSettings）
      store.update({ naming: { ...correct } });
      const afterSet = JSON.parse(JSON.stringify(store.settings.naming));
      // 走真实推送路径
      await store.pushCloudSettings();
      const afterPush = JSON.parse(JSON.stringify(store.settings.naming));
      // 读一下 localStorage 里落了什么
      let lsNaming = null;
      try {
        lsNaming = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null')?.naming ?? null;
      } catch {
        lsNaming = null;
      }
      return { before, afterSet, afterPush, lsNaming };
    }, CORRECT);
  } finally {
    await browser.close();
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const backupFile = join(OUT_DIR, 're14-naming-backup.json');
  await login();

  let backup = null;
  const result = { at: new Date().toISOString() };
  try {
    hr('步骤 0：备份云端当前 naming');
    const origin = await getSettings();
    backup = { version: origin?.version ?? 0, naming: origin?.payload?.naming ?? null, at: new Date().toISOString() };
    writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');
    log(`  已备份 version=${backup.version} → ${backupFile}`);
    log(`  备份 template=${JSON.stringify(backup.naming?.template)}`);
    result.backup = backup;

    hr('步骤 1：用 fetch 直推「正确 naming」（绕过浏览器，纯服务端链路）');
    const put1 = await putNaming(CORRECT);
    log(`  PUT 状态 ${put1.status}`);
    const read1 = await getSettings();
    const v1 = verdict(read1?.payload?.naming);
    result.afterDirectPut = v1;
    log(`  读回 template   = ${JSON.stringify(v1.template)}   → ${v1.templateOk ? '✓ 正确' : '✗ 仍乱码'}`);
    log(`  读回 fallback   = ${JSON.stringify(v1.fallback)}   → ${v1.fallbackOk ? '✓ 中文保留' : '✗ 仍乱码'}`);
    log(`  读回 aiPrompt   = ${JSON.stringify(v1.aiPromptHead)}… → ${v1.aiPromptOk ? '✓ 中文保留' : '✗ 仍乱码'}`);

    hr('步骤 2：用浏览器 store 的真实 pushCloudSettings 推同样内容');
    const b = await browserPushCorrectNaming();
    result.browser = {
      before: verdict(b.before),
      afterSet: verdict(b.afterSet),
      afterPush: verdict(b.afterPush),
      lsNaming: verdict(b.lsNaming),
    };
    log(`  [store] 设置后 template = ${JSON.stringify(b.afterSet?.template)} → ${verdict(b.afterSet).templateOk ? '✓' : '✗'}`);
    log(`  [store] 推送后 template = ${JSON.stringify(b.afterPush?.template)} → ${verdict(b.afterPush).templateOk ? '✓' : '✗'}`);
    log(`  [localStorage] 落盘 template = ${JSON.stringify(b.lsNaming?.template)} → ${verdict(b.lsNaming).templateOk ? '✓' : '✗'}`);

    hr('步骤 3：再次读云端，确认是否有二次污染');
    const read2 = await getSettings();
    const v2 = verdict(read2?.payload?.naming);
    result.final = v2;
    log(`  template = ${JSON.stringify(v2.template)}  ${v2.templateGarbled ? '✗ 被替换成 ?' : '✓ 完好'}`);
    log(`  aiPrompt = ${JSON.stringify(v2.aiPromptHead)}…  ${v2.aiPromptGarbled ? '✗ 被替换' : '✓ 完好'}`);

    hr('结论');
    const ok = v2.templateOk && v2.fallbackOk && v2.aiPromptOk;
    if (ok) {
      log('  ✓ 写入链路**正常**：正确值写进去读出来仍是正确的');
      log('    → 现有乱码是**历史脏数据**，修复策略 = 一次性数据迁移 + 读时防御');
    } else {
      log('  ✗ 写入链路**仍在污染**：正确值写进去后被破坏');
      log('    → 必须修产生乱码的写入路径，否则修了数据下次还坏');
    }
    result.writepathHealthy = ok;
    const outJson = join(OUT_DIR, 're14-writepath-probe.json');
    writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
    log(`\n  证据 JSON → ${outJson}`);
  } finally {
    if (backup && !KEEP) {
      hr('回滚：把备份的原值写回云端');
      try {
        const put = await putNaming(backup.naming ?? CORRECT);
        log(`  回滚 PUT 状态 ${put.status}`);
      } catch (e) {
        log(`  ! 回滚失败（备份在 ${backupFile}）：${e.message}`);
      }
    } else if (KEEP) {
      log(`\n  --keep：未回滚，原值备份在 ${backupFile}`);
    }
  }
}

await main();
