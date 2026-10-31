/**
 * 1.4.0 设置草稿模式：**保存链路 / 1.3.1 保护链**专项验证（lead 要求的 B 段核实）。
 *
 * ## 为什么单独写这个脚本
 *
 * 需求16 把设置改成「草稿 + 保存」，于是 `verify-121.mjs` 的 C 段（改字体 →
 * 断言 store/localStorage 已变 → 等 95s + focus → 断言未被云端打回）走不通了：
 * 它改完字体没有点保存，store 与 localStorage 当然是旧值。这是**测试路径**问题。
 *
 * 但「测试路径问题」这个结论必须先证明代码侧是好的，否则就是拿改断言掩盖真 bug。
 * 本脚本逐条钉死 lead 列出的三个疑点：
 *
 *   B1. 点保存后 `settingsStore.settings.appearance.fontFamily` 真的变了吗？
 *   B2. 点保存后 `localStorage['neomd.settings.v1']` 真的变了吗？
 *   B3. 点保存后 `neomd.appearancePending.v1` 里真的有 fontFamily（pending 保护生效）？
 *   B4. 点保存后 `neomd.appearanceBaseline.v1` 有没有被**错误地**推进成新值
 *       （推进了 = 下次拉取会误判「本地没改过」而接受云端旧值 = 1.3.1 bug 复发）；
 *   B5. 推送失败（拦截 PUT）后焦点拉取：已保存的字体**不被打回**；
 *   B6. 解除拦截后能收敛（推送链路没僵住，不会像 1.1.9 那样永久拒绝云端）。
 *
 * ## 生产数据安全
 *
 * 快照 `neomd.settings.v1`（本机）与云端 global/platform 的 appearance，
 * finally 里还原并逐字段复查；快照同时落盘。
 *
 * 用法：
 *   node tools/re14-settings-save-verify.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-140-settings');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.RE14_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';
const PLATFORM = process.env.RE14_PLATFORM || 'web';
const GLOBAL_PROBE = '__re14_global_probe__';
const SNAPSHOT_FILE = path.join(here, '.re14-save-verify-snapshot.json');
/** 覆盖 30s 拉取节流 + 60s 版本轮询 */
const WAIT_MS = Number(process.env.RE14_WAIT_MS || 95_000);

let token = '';
let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fails.push(`${label}${extra !== undefined ? ` \u2192 ${JSON.stringify(extra)}` : ''}`);
    console.log(`  \u2717 ${label}${extra !== undefined ? ` \u2192 ${JSON.stringify(extra)}` : ''}`);
  }
}

async function apiJson(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function readRemoteAppearance(platform) {
  const { body } = await apiJson(`/api/settings?platform=${encodeURIComponent(platform)}`);
  const payload = body?.data?.payload ?? null;
  return { appearance: payload?.appearance ?? null, version: body?.data?.version ?? null };
}

const USER_DATA_DIR = path.join(here, '.re14-save-verify-profile');
fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
const LAUNCH_ARGS = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

let ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: BROWSER,
  args: LAUNCH_ARGS,
  viewport: { width: 1600, height: 1000 },
});
let page = ctx.pages()[0] ?? (await ctx.newPage());

const snapshot = { localStorage: null, globalAppearance: {}, platformAppearance: {} };

/** 读「设置侧全量状态」：store 不可直接访问，因此以 localStorage + DOM 变量为准 */
const READ_STATE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  let store = null;
  try { store = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null'); } catch {}
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem('neomd.appearancePending.v1') || 'null'); } catch {}
  let baseline = null;
  try { baseline = JSON.parse(localStorage.getItem('neomd.appearanceBaseline.v1') || 'null'); } catch {}
  let probe = document.getElementById('re14-font-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 're14-font-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-family:var(--font-content)';
    probe.textContent = 'x';
    document.body.appendChild(probe);
  }
  return {
    lsFontFamily: store?.appearance?.fontFamily ?? null,
    lsAccent: store?.appearance?.accent ?? null,
    lsThemePresetId: store?.appearance?.themePresetId ?? null,
    pending: Array.isArray(pending) ? pending : pending,
    baselineFontFamily: baseline?.fontFamily ?? null,
    rootFontVar: root.style.getPropertyValue('--font-content').trim(),
    probeFont: getComputedStyle(probe).fontFamily,
    runtimeFontVar: cs.getPropertyValue('--font-content').trim(),
    saveBarDirty: !!document.querySelector('[data-testid="settings-save-bar"].is-dirty'),
  };
})()`;

const readState = () => page.evaluate(READ_STATE);

/**
 * 打开设置页并切到「编辑器」页签。
 *
 * 为什么要「先点一下正文再按 Ctrl+,」并带重试：
 * 无头 Chrome 在 `goto` 之后不一定把焦点给到文档，此时键盘事件会被丢掉，
 * 表现为「按了 Ctrl+, 但设置页没开」——不加重试会变成假失败。
 */
async function openFontTab() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.locator('.settings-page').count()) break;
    await page.locator('body').click({ position: { x: 700, y: 300 } }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+Comma').catch(() => {});
    await page.waitForTimeout(1800);
  }
  const nav = page.locator('.settings__nav-item').filter({ hasText: '编辑器' }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(700);
  }
}

/** 分段等待，页面崩了就恢复（长等待期间无头 Chrome 偶发退出） */
async function waitResilient(totalMs, chunkMs = 15_000) {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(chunkMs, left);
    try {
      await page.waitForTimeout(step);
    } catch {
      /* 页面崩了：下面重新导航 */
    }
    left -= step;
  }
}

try {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const loginBody = await loginRes.json();
  const d = loginBody.data ?? {};
  token = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  if (!token) throw new Error('登录响应里没有 accessToken');

  const globalView = await readRemoteAppearance(GLOBAL_PROBE);
  snapshot.globalAppearance = globalView.appearance ?? {};
  const platView = await readRemoteAppearance(PLATFORM);
  snapshot.platformAppearance = platView.appearance ?? {};
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ savedAt: new Date().toISOString(), ...snapshot }, null, 2));
  console.log(`快照已备份：${SNAPSHOT_FILE}`);

  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [token, refresh],
  );
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  snapshot.localStorage = await page.evaluate(() => {
    const out = {};
    for (const k of [
      'neomd.settings.v1',
      'neomd.themeScope',
      'neomd.themeDirtySince',
      'neomd.layoutBaseline.v1',
      'neomd.appearanceBaseline.v1',
      'neomd.appearancePending.v1',
    ]) {
      out[k] = localStorage.getItem(k);
    }
    return out;
  });

  /* ================= B0. 基线状态 ================= */
  await openFontTab();
  check((await page.locator('.settings-page').count()) > 0, '设置页已打开');
  const before = await readState();
  console.log(`  改前：lsFontFamily=${JSON.stringify(before.lsFontFamily)}`);
  console.log(`  改前：pending=${JSON.stringify(before.pending)} baselineFontFamily=${JSON.stringify(before.baselineFontFamily)}`);

  const fontSel = page.locator('select[data-testid="font-family"], select[aria-label="正文字体"]').first();
  check((await fontSel.count()) > 0, '编辑器页签存在正文字体下拉');
  const optionTexts = await fontSel.locator('option').evaluateAll((els) =>
    els.map((e) => ({ value: e.value, label: e.textContent?.trim() ?? '' })),
  );
  const target = optionTexts.find((o) => /Georgia/.test(o.value) || /Georgia/.test(o.label));
  if (!target) throw new Error('字体下拉里没有 Georgia 选项');
  const expect = target.value.split(',')[0].trim().replace(/^["']|["']$/g, '');
  console.log(`  目标字体：${JSON.stringify(target.value)}（期望 computed 含 ${expect}）`);

  /* ============ B1. 只改草稿、不保存 → 必须完全不生效（需求16） ============ */
  console.log('\n=== [B1] 只改设置不点保存 → store/localStorage 必须不变（需求16） ===');
  await fontSel.selectOption(target.value);
  await page.waitForTimeout(1200);
  const draftOnly = await readState();
  console.log(`  改草稿后：lsFontFamily=${JSON.stringify(draftOnly.lsFontFamily)}`);
  console.log(`  改草稿后：saveBarDirty=${draftOnly.saveBarDirty}`);
  check(
    JSON.stringify(draftOnly.lsFontFamily) === JSON.stringify(before.lsFontFamily),
    '不点保存时 localStorage 的 fontFamily 未变（草稿未落盘）',
    { before: before.lsFontFamily, after: draftOnly.lsFontFamily },
  );
  check(draftOnly.saveBarDirty === true, '底部保存栏已进入「有未保存改动」状态');

  /* ============ B2/B3/B4. 点保存 → store 落盘 + pending 保护 ============ */
  console.log('\n=== [B2] 点保存 → localStorage 更新 ===');
  const saveBtn = page.locator('[data-testid="settings-save"]').first();
  check((await saveBtn.count()) > 0, '底部保存按钮存在');
  await saveBtn.click();
  await page.waitForTimeout(1500);
  const afterSave = await readState();
  console.log(`  保存后：lsFontFamily=${JSON.stringify(afterSave.lsFontFamily)}`);
  console.log(`  保存后：--font-content=${JSON.stringify(afterSave.rootFontVar)}`);
  console.log(`  保存后：probe computed=${JSON.stringify(afterSave.probeFont)}`);
  check(
    String(afterSave.lsFontFamily ?? '').toLowerCase().includes(expect.toLowerCase()),
    'B2 保存后 localStorage 的 fontFamily 已变（草稿真的落盘）',
    { expect, actual: afterSave.lsFontFamily },
  );
  check(
    String(afterSave.probeFont ?? '').toLowerCase().includes(expect.toLowerCase()),
    'B2b 保存后 DOM 实际字体已变',
    afterSave.probeFont,
  );
  check(afterSave.saveBarDirty === false, '保存后保存栏回到「已保存」状态');

  console.log('\n=== [B3] 保存后 pending 保护是否生效（1.3.1 链路） ===');
  console.log(`  neomd.appearancePending.v1 = ${JSON.stringify(afterSave.pending)}`);
  const pendingList = Array.isArray(afterSave.pending) ? afterSave.pending : [];
  /*
   * 这里**不**断言 pending 非空：推送在 1s 防抖 + 本地 API 很快，保存后 1.5s 内通常已经推送成功，
   * 而推送成功会按设计执行 `clearAppearancePending()` + `snapshotAppearanceBaseline()`。
   * 「pending 是否真的被写进去」只有在**推送失败**时才观察得到 —— 见下面的 B3'/B4'。
   */
  console.log(
    `  （推送已成功：pending=${JSON.stringify(pendingList)} baseline=${JSON.stringify(afterSave.baselineFontFamily)}，` +
      `这是设计行为；pending 的真实断言在 B3'/B4'）`,
  );

  /* ============ B3'/B4'. 推送失败场景：pending 与基线必须保持「未同步」 ============ */
  console.log('\n=== [B3\'] 拦截 PUT 后再保存 → pending 必须含 fontFamily、基线必须停旧值 ===');
  const abortPutEarly = (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.continue();
  const fontSelX = page.locator('select[data-testid="font-family"], select[aria-label="正文字体"]').first();
  const optionTextsX = await fontSelX.locator('option').evaluateAll((els) =>
    els.map((e) => ({ value: e.value, label: e.textContent?.trim() ?? '' })),
  );
  // 选一个与当前不同的字体，保证确实产生「本地改动」
  const targetX =
    optionTextsX.find((o) => /KaiTi/.test(o.value) || /KaiTi/.test(o.label)) ??
    optionTextsX.find((o) => /Consolas|Cascadia/.test(o.value)) ??
    optionTextsX.find((o) => o.value !== afterSave.lsFontFamily);
  if (!targetX) throw new Error('找不到可用的第二个字体选项');
  const expectX = targetX.value.split(',')[0].trim().replace(/^["']|["']$/g, '');
  console.log(`  第二个目标字体：${JSON.stringify(targetX.value)}（期望含 ${expectX}）`);

  const baselineBeforeFailSave = afterSave.baselineFontFamily;
  await page.route('**/api/settings**', abortPutEarly);
  let failSaveState = null;
  try {
    await openFontTab();
    await page
      .locator('select[data-testid="font-family"], select[aria-label="正文字体"]')
      .first()
      .selectOption(targetX.value);
    await page.waitForTimeout(900);
    const saveX = page.locator('[data-testid="settings-save"]').first();
    check(!(await saveX.isDisabled()), '改字体后保存按钮可用');
    await saveX.click();
    // 等过推送防抖 + 失败重试（1s + 一次重试），确认仍在失败态
    await page.waitForTimeout(3500);
    failSaveState = await readState();
    console.log(`  推送失败态：lsFontFamily=${JSON.stringify(failSaveState.lsFontFamily)}`);
    console.log(`  推送失败态：pending=${JSON.stringify(failSaveState.pending)}`);
    console.log(`  推送失败态：baselineFontFamily=${JSON.stringify(failSaveState.baselineFontFamily)}`);
    const pendingFail = Array.isArray(failSaveState.pending) ? failSaveState.pending : [];
    check(
      pendingFail.includes('fontFamily'),
      "B3' 推送失败时 fontFamily 在 pending 集合里（保护生效）",
      { pending: failSaveState.pending },
    );
    check(
      String(failSaveState.baselineFontFamily ?? '') === String(baselineBeforeFailSave ?? ''),
      "B4' 推送失败时基线未被推进（仍是推送成功前的值）",
      { baseline: failSaveState.baselineFontFamily, expected: baselineBeforeFailSave },
    );
    check(
      String(failSaveState.lsFontFamily ?? '').toLowerCase().includes(expectX.toLowerCase()),
      "B4'b 推送失败时 localStorage 已写入本地新值",
      { expect: expectX, actual: failSaveState.lsFontFamily },
    );

    /* ============ B5. 拉取 → 已保存的本地改动不被打回 ============ */
    console.log('\n=== [B5] 触发云端拉取（重开设置页）→ 已保存的本地字体不得被云端旧值覆盖 ===');
    const remoteDuringFail = await readRemoteAppearance(GLOBAL_PROBE);
    console.log(`  拉取前云端 global.fontFamily=${JSON.stringify(remoteDuringFail.appearance?.fontFamily ?? null)}（应为上一轮的值，不含 ${expectX}）`);
    // 真实拉取时机：关闭设置标签页 → 重新打开（onMounted → requestCloudPull）
    await page.keyboard.press('Control+w');
    await page.waitForTimeout(1200);
    await openFontTab();
    await page.waitForTimeout(5000);
    const afterPull = await readState();
    console.log(`  拉取后：lsFontFamily=${JSON.stringify(afterPull.lsFontFamily)}`);
    console.log(`  拉取后：probe computed=${JSON.stringify(afterPull.probeFont)}`);
    console.log(`  拉取后：pending=${JSON.stringify(afterPull.pending)}`);
    check(
      String(afterPull.lsFontFamily ?? '').toLowerCase().includes(expectX.toLowerCase()),
      'B5 推送失败 + 拉取后，已保存的字体仍未被云端旧值覆盖（1.3.1 保护有效）',
      { expect: expectX, actual: afterPull.lsFontFamily },
    );
  } finally {
    await page.unroute('**/api/settings**', abortPutEarly);
  }

  /* ============ B6. 解除拦截后能收敛（不僵住） ============ */
  console.log('\n=== [B6] 解除拦截后能收敛到云端（推送链路未僵住） ===');
  /*
   * 触发一次推送：重开设置页（拉取结束时会 `pushAfterPull` 补发）+ 再保存一次。
   *
   * ## 为什么必须**轮询**而不是固定 sleep
   *
   * 收敛是一条链：开设置页 → `requestCloudPull()`（网络往返）→ 拉取结束
   * → finally 里 `pushAfterPull` → `scheduleCloudPush()`（1s 防抖）→ PUT 上行。
   * 固定等 6s 在这台机器上**不够**（拉取加上同步链路常在 3~5s，再叠 1s 防抖就超了），
   * 于是云端还是旧值 —— 这是**断言时序问题**，不是「保护退化成永久拒绝云端」。
   *
   * 首轮实测 13 通过 / 2 失败，其中 B6 就是这样假失败的。
   * 改成每 1.5s 轮询一次、最长等 45s，一旦云端收敛立刻通过。
   */
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(1200);
  await openFontTab();

  let remoteAfter = null;
  const B6_DEADLINE = Date.now() + 45_000;
  let waited = 0;
  while (Date.now() < B6_DEADLINE) {
    await page.waitForTimeout(1500);
    waited += 1500;
    remoteAfter = await readRemoteAppearance(GLOBAL_PROBE);
    const v = String(remoteAfter.appearance?.fontFamily ?? '');
    if (v.toLowerCase().includes(expectX.toLowerCase())) break;
    // 每 10s 再触发一次「保存」推动补发（模拟用户再动一下设置）
    if (waited % 10_000 === 0) {
      const btn = page.locator('[data-testid="settings-save"]').first();
      if ((await btn.count()) && !(await btn.isDisabled())) await btn.click().catch(() => {});
    }
  }
  console.log(`  云端 global.appearance.fontFamily=${JSON.stringify(remoteAfter?.appearance?.fontFamily ?? null)}（轮询 ${waited}ms）`);
  check(
    String(remoteAfter?.appearance?.fontFamily ?? '').toLowerCase().includes(expectX.toLowerCase()),
    'B6 解除拦截后本地改动已收敛到云端（保护没有退化成永久拒绝云端）',
    { expect: expectX, actual: remoteAfter?.appearance?.fontFamily ?? null, waitedMs: waited },
  );

  /* ============ B7. 刷新后保持 ============ */
  console.log('\n=== [B7] 刷新页面后字体仍保持（落盘真的有效） ===');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const afterReload = await readState();
  console.log(`  刷新后：lsFontFamily=${JSON.stringify(afterReload.lsFontFamily)} probe=${JSON.stringify(afterReload.probeFont)}`);
  check(
    String(afterReload.lsFontFamily ?? '').toLowerCase().includes(expectX.toLowerCase()),
    'B7 刷新后 localStorage 的 fontFamily 仍是保存值',
    { expect: expectX, actual: afterReload.lsFontFamily },
  );

  await page.screenshot({ path: path.join(shots, 'save-verify.png') });
} catch (e) {
  fails.push(`脚本异常：${e?.message ?? e}`);
  console.log(`\n[ERROR] ${e?.stack ?? e}`);
} finally {
  let restoredOk = false;
  for (let attempt = 1; attempt <= 3 && !restoredOk; attempt += 1) {
    try {
      const ver = await apiJson('/api/settings/version');
      const currentVersion = Number(ver.body?.data?.version ?? 0);
      const put = await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          payload: {
            global: { appearance: snapshot.globalAppearance },
            platform: { [PLATFORM]: { appearance: snapshot.platformAppearance } },
          },
          version: currentVersion,
          platform: PLATFORM,
        }),
      });
      const after = await readRemoteAppearance(GLOBAL_PROBE);
      const afterFlat = await readRemoteAppearance(PLATFORM);
      const diffs = [];
      for (const [k, v] of Object.entries(snapshot.globalAppearance)) {
        if (JSON.stringify(after.appearance?.[k]) !== JSON.stringify(v)) diffs.push(`global.${k}`);
      }
      for (const [k, v] of Object.entries(snapshot.platformAppearance)) {
        if (JSON.stringify(afterFlat.appearance?.[k]) !== JSON.stringify(v)) diffs.push(`platform.${k}`);
      }
      restoredOk = diffs.length === 0;
      console.log(`\n还原（第 ${attempt} 次）：HTTP ${put.status}；${restoredOk ? '全部已还原' : `差异 ${diffs.length} 项：${diffs.join(',')}`}`);
      if (!restoredOk) await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.log(`\n[WARN] 还原第 ${attempt} 次失败：${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!restoredOk) console.log(`\n[!!] 还原未成功，快照在 ${SNAPSHOT_FILE}`);
  try {
    if (snapshot.localStorage) {
      await page.evaluate((snap) => {
        for (const [k, v] of Object.entries(snap)) {
          if (v === null || v === undefined) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        }
      }, snapshot.localStorage);
      console.log('本机 localStorage 快照已回写。');
    }
  } catch {
    /* 页面已关闭 */
  }
  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) {
    console.log('失败明细：');
    for (const f of fails) console.log(`  - ${f}`);
  }
  await ctx.close().catch(() => {});
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}
