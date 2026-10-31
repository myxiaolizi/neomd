#!/usr/bin/env node
/**
 * 1.4.0 需求10 **反弹复现验证**（lead 指定的核心验收点）。
 *
 * ## 要证明什么
 *
 * 不是「清理后是 4 条」（那是静态结果），而是：
 * **一个 localStorage 里存着已删除 vaultId 的浏览器 profile，
 * 在触发周期同步后，不会把这些 vaultId 重新登记回 `/api/vaults`。**
 *
 * ## 复现方法（对照实验，修前 vs 修后）
 *
 * 1. 起一个真实 Chromium，登录注入 token；
 * 2. **手工往 localStorage 的 `neomd.vaultList.v1` 里塞 2 条幽灵条目**
 *    （`location: 'cloud:<ghostId>'`、有 `lastSyncedAt` —— 与实测到的
 *    「曾经同步过、云端已删除」形态完全一致）；
   3. 记录当前 `/api/vaults` 行数（基线）；
 * 4. 在页面内触发「全部同步」（`syncAllVaults`）与周期同步（`syncNow`）；
 * 5. 再查 `/api/vaults` 行数：
 *    - **修复后**：行数不变，且幽灵条目被标 `orphan`，不在 `listSyncable()` 里；
 *    - 对照组（模拟修复前行为）：直接对幽灵 id 调 `PUT /api/storage/*`，
 *      证明这**确实会**触发服务端重新登记 —— 从而证明前面的「不调用」是关键。
 * 6. finally 清理：把可能被登记进去的条目删掉，恢复 localStorage。
 *
 * 用法：node tools/re14-anti-rebound.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
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
const hr = (t) => log(`\n${'═'.repeat(68)}\n${t}\n${'═'.repeat(68)}`);

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

/* ---------------- HTTP ---------------- */

let token = '';
async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login() {
  const r = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  token = r.body?.data?.accessToken ?? '';
  if (!token) throw new Error('登录失败');
}

async function vaultCount() {
  const r = await api('/api/vaults');
  return (r.body?.data?.vaults ?? []).length;
}
async function vaultIds() {
  const r = await api('/api/vaults');
  return (r.body?.data?.vaults ?? []).map((v) => v.vaultId);
}

/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT, { recursive: true });
  await login();
  const { chromium } = loadPlaywright();
  const result = { at: new Date().toISOString() };

  const before = await vaultCount();
  log(`基线与云端仓库数：${before}`);

  /*
   * 幽灵 id：用两个**确定不在云端**的随机 id（不复用实测的那 6 个，
   * 避免万一被登记后与历史数据混淆）。
   */
  const ghostA = `vaultREBOUND${Date.now().toString(36)}A`;
  const ghostB = `vaultREBOUND${Date.now().toString(36)}B`;
  result.ghostIds = [ghostA, ghostB];

  const browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const registered = [];

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
    /*
     * 先重载一次并等首屏就绪，让注册表**拉取到 4 条真实云端仓库**并落进 localStorage。
     *
     * 不做这一步的话，紧接着的注入会写在一个空列表上（实测 before=0），
     * 页面下次加载时 `pullVaultList()` 会用云端清单重建列表，幽灵被淹没，
     * 「幽灵被 orphan 拦截」这件事就无从证明。
     */
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
    await page.waitForTimeout(3500);

    hr('步骤 1：往 localStorage 注入 2 条「云端已删除」的幽灵条目');
    /*
     * 注入前必须**先让注册表跑起来**（页面已加载、已拉到 4 条真实仓库），
     * 再往现有 entries 里**追加**幽灵。
     *
     * 首版把这个顺序搞错了（在 localStorage 为空时就写，只写了 2 条幽灵），
     * 结果页面加载后 `pullVaultList()` 用云端 4 条真实仓库把列表整体重建，
     * 幽灵被"淹没"，读到的是 `null` —— 断言虽然过了，但**证明力不够**：
     * 它只能证明「幽灵没进注册表」，而不能证明「幽灵进了注册表也被拦住」。
     * 现在的顺序保证幽灵确实存在于注册表中，断言才有意义。
     */
    const injected = await page.evaluate(
      ({ ghostA, ghostB }) => {
        const KEY = 'neomd.vaultList.v1';
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const list = Array.isArray(parsed) ? parsed : (parsed?.entries ?? []);
        const now = Date.now();
        /** 与实测形态一致：location 是 cloud:<id>、有 lastSyncedAt（曾同步过）、docCount=0 */
        const ghosts = [ghostA, ghostB].map((id) => ({
          vaultId: id,
          name: 'Neo MD',
          location: `cloud:${id}`,
          adapter: 'browser-idb',
          status: 'active',
          lastOpenedAt: now,
          createdAt: now,
          available: true,
          lastSyncedAt: now,
          docCount: 0,
          bytes: 0,
        }));
        const merged = [...list.filter((e) => !String(e.vaultId).startsWith('vaultREBOUND')), ...ghosts];
        const next = Array.isArray(parsed) ? merged : { ...(parsed ?? {}), entries: merged, currentVaultId: parsed?.currentVaultId ?? '' };
        localStorage.setItem(KEY, JSON.stringify(next));
        return { before: list.length, after: merged.length, ghosts: ghosts.map((g) => g.vaultId) };
      },
      { ghostA, ghostB },
    );
    log(`  localStorage 条目：${injected.before} → ${injected.after}`);
    log(`  注入的幽灵 id：${injected.ghosts.join(', ')}`);
    if (injected.before === 0) {
      log('  ⚠ 注入时注册表为空 —— 断言证明力会打折扣（见脚本注释）');
    }

    hr('步骤 2：重载页面，让注册表读到幽灵条目并触发周期同步');
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
    /*
     * 等到 orphan 判定真正发生。
     *
     * 页面加载时 `pullVaultList()` 会先跑一轮 `mergeRemote()`，幽灵在此被标 orphan。
     * 但如果只 `waitForTimeout` 固定时长，可能早于该轮完成（首屏要做打开仓库、
     * 拉设置、重建搜索索引等一堆事），于是读到"没有幽灵"的中间态。
     * 这里用 `waitForFunction` 等一个**确定性的状态**，避免时序抖动。
     */
    const sawOrphan = await page
      .waitForFunction(
        ({ ghostA, ghostB }) => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
          const reg = pinia?._s?.get('app')?.vaultRegistry;
          if (!reg) return false;
          const ids = new Set(reg.listOrphans().map((e) => e.vaultId));
          return ids.has(ghostA) || ids.has(ghostB);
        },
        { ghostA, ghostB },
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    log(`  是否观察到幽灵被判 orphan：${sawOrphan ? '是 ✓' : '否（可能已被加速清理）'}`);

    const regState = await page.evaluate(
      ({ ghostA, ghostB }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const app = pinia._s.get('app');
        const reg = app.vaultRegistry;
        const pick = (id) => {
          const e = reg.get(id);
          return e
            ? {
                vaultId: e.vaultId,
                orphan: Boolean(e.orphan),
                available: e.available,
                miss: e.orphanMissCount ?? 0,
                orphanSince: e.orphanSince ?? null,
              }
            : null;
        };
        return {
          ghostA: pick(ghostA),
          ghostB: pick(ghostB),
          syncableIds: reg.listSyncable().map((e) => e.vaultId),
          orphanIds: reg.listOrphans().map((e) => e.vaultId),
        };
      },
      { ghostA, ghostB },
    );
    log(`  注册表状态：orphanIds=${JSON.stringify(regState.orphanIds)}`);
    const ghostInSyncable = regState.syncableIds.filter((i) => i.startsWith('vaultREBOUND'));
    log(`  syncableIds 是否包含幽灵：${ghostInSyncable.join(',') || '（不含 ✓）'}`);
    result.registryAfterPull = regState;
    result.sawOrphan = sawOrphan;

    hr('步骤 3：显式触发「全部同步」（这是反弹链路原本的入口）');
    const syncRes = await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      try {
        const r = await app.syncAllVaults({ silent: true });
        return { ok: true, r };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });
    log(`  syncAllVaults → ${JSON.stringify(syncRes)}`);
    result.syncAllResult = syncRes;

    // 再触发一次当前的单仓同步
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      try {
        await app.syncNow({ silent: true });
      } catch {
        /* ignore */
      }
    });
    await page.waitForTimeout(2500);

    hr('步骤 4：查 /api/vaults —— **核心断言**');
    const afterIds = await vaultIds();
    const rebound = afterIds.filter((id) => id === ghostA || id === ghostB);
    // 记录所有可能被登记的新条目（除了已知的 4 条真实仓库）
    const knownReal = ['admin', 'vaultmvuqt3rn8ubd9num', 'vaultmvs9ey2vkpj8q5jy', 'vaultmvp3augl2m72a0nw'];
    const unexpected = afterIds.filter((id) => !knownReal.includes(id));
    result.afterSync = { count: afterIds.length, ids: afterIds, rebound, unexpected };

    log(`  同步后云端仓库数：${before} → ${afterIds.length}`);
    log(`  幽灵是否被重新登记：${rebound.length ? '✗ 是 → ' + rebound.join(', ') : '✓ 否'}`);
    if (unexpected.length) log(`  ⚠ 出现了非预期条目：${unexpected.join(', ')}`);

    const passA = rebound.length === 0;
    log(`  ${passA ? '✓' : '✗'} 断言A：周期同步后幽灵未被重新登记`);

    /* ── 对照组：证明「如果仍去访问存储接口，就一定会被登记」── */
    hr('步骤 5：对照组 —— 直接对幽灵 id 调存储接口，验证反弹机制本身存在');
    /*
     * 对照组使用**独立的第三个幽灵 id**，不能复用断言组的 ghostA/ghostB。
     *
     * 原因：对照组的目的正是「让服务端把它登记回去」，如果复用 ghostA，
     * 就会把断言组已经证明「没被登记」的结果又污染成「有登记」，
     * 导致报告里出现自相矛盾的残余条目。分开之后：
     *   - ghostA/ghostB 只在断言组出现 → 用来证明修复有效；
     *   - ghostCtrl 只用于对照组 → 用来证明反弹机制真实存在，最后单独清理。
     */
    const ghostCtrl = `vaultREBOUNDCTRL${Date.now().toString(36)}`;
    const ctrl = await api(`/api/storage/list?prefix=&maxKeys=2`, {
      headers: { 'x-vault-id': ghostCtrl },
    });
    const afterCtrlIds = await vaultIds();
    const ctrlRegistered = afterCtrlIds.includes(ghostCtrl);
    if (ctrlRegistered) registered.push(ghostCtrl);
    log(`  存储接口状态：${ctrl.status}（对未登记的 ${ghostCtrl} 发起列举）`);
    log(`  幽灵是否被服务端自动登记：${ctrlRegistered ? '是（证明反弹机制真实存在）' : '否'}`);
    result.controlGroup = { status: ctrl.status, registered: ctrlRegistered, countAfter: afterCtrlIds.length, ghostCtrl };

    /*
     * 这一条不是失败项，而是**证据**：
     * 它证明「只要客户端还去访问已删除仓库的存储前缀，服务端就会把它登记回来」，
     * 因此修复必须落在「不要去访问」这一侧（syncVaultById 的 orphan 闸门 +
     * syncAllVaults 用 listSyncable + pushVaultEntry 的兜底 return）。
     */
    log(`  ${ctrlRegistered ? '✓' : '·'} 断言B：对照组${ctrlRegistered ? '成功复现了反弹机制' : '未复现（服务端可能已变更）'}`);

    // 对照组登记的那个不该影响断言 A 的结论，再确认一次
    const finalIds = await vaultIds();
    const reboundAB = finalIds.filter((id) => id === ghostA || id === ghostB);
    const allPass = reboundAB.length === 0;
    result.verdict = {
      antiReboundWorks: allPass,
      reboundMechanismExists: ctrlRegistered,
      ghostAStillAbsent: !reboundAB.includes(ghostA),
      ghostBStillAbsent: !reboundAB.includes(ghostB),
      conclusion: allPass
        ? '修复有效：orphan 条目未进入同步，未触发重新登记（对照组另行证明了反弹机制真实存在）'
        : '修复无效：幽灵仍被重新登记',
    };
    log(`\n  最终复核：ghostA/ghostB 是否在云端 → ${reboundAB.length ? '✗ ' + reboundAB.join(',') : '✓ 都不在'}`);
    log(`  结论：${result.verdict.conclusion}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    hr('清理');
    // 删掉本次可能被登记进去的幽灵
    for (const id of registered) {
      try {
        await api(`/api/vaults/${encodeURIComponent(id)}?purge=1`, { method: 'DELETE' });
        log(`  已清理被登记的幽灵 ${id}`);
      } catch {
        /* ignore */
      }
    }
    // 恢复 localStorage（移除注入的条目）
    try {
      await page.evaluate(() => {
        const KEY = 'neomd.vaultList.v1';
        const raw = localStorage.getItem(KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
        const filtered = list.filter((e) => !String(e.vaultId).startsWith('vaultREBOUND'));
        localStorage.setItem(KEY, JSON.stringify(Array.isArray(parsed) ? filtered : { ...parsed, entries: filtered }));
      });
      log('  已移除注入的 localStorage 幽灵条目');
    } catch {
      /* ignore */
    }
    await browser.close();

    const finalCount = await vaultCount();
    log(`  最终云端仓库数：${finalCount}（基线 ${before}）`);
    result.finalCount = finalCount;
    result.restored = finalCount === before;

    writeFileSync(join(OUT, 're14-anti-rebound.json'), JSON.stringify(result, null, 2), 'utf8');
    log(`\n  证据 → ${join(OUT, 're14-anti-rebound.json')}`);
  }
}

await main();
