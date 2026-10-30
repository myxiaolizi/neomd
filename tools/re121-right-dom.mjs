#!/usr/bin/env node
/**
 * 1.2.1 缺陷5 · 右侧栏「历史版本」区块的 **DOM 级**取证脚本。
 *
 * 为什么需要独立脚本：
 *   DSH 的共享 browser_* 工具被多条并行工作流（T1/T2/T4 与其它项目）同时占用，
 *   页面会被别的会话导航走（实测反复落到 8781 / jdy.zhengl.vip / about:blank），
 *   拿不到稳定的截图帧。本脚本用**自己的 Chromium 实例**跑，不干扰任何人。
 *
 * 验证内容（对应 lead 的 6 条要求）：
 *   1. 打开 5178 并登录 admin/6655；
 *   2. 新建临时仓库 + 临时文档（标题前缀 RE121-RIGHT-），连续保存 5 次不同内容；
 *   3. 打开右侧栏「历史版本」区块，**DOM 断言**列出 ≥5 条、内容各异；
 *   4. 点其中一条（非最新版），确认预览内容 ≠ 最新版正文；
 *   5. 截图存 docs/shots-121/re121-*；
 *   6. finally 清理临时文档与云端对象（含服务端仓库登记）。
 *
 * 用法：node tools/re121-right-dom.mjs
 */

import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = process.env.NEOMD_WEB || 'http://127.0.0.1:5178';
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const SHOTS = join(REPO, 'docs/shots-121');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n=== ${t} ===`);

/* ---------------- Playwright（用全局安装的 playwright-core + 已下载的 chromium） ---------------- */

async function loadPlaywright() {
  /*
   * playwright-core 不在本仓库依赖里（本仓库不跑 e2e），但机器上已有两处副本：
   *  - 全局 npm root（`npm ls -g` 曾报 playwright-core@1.64.1，但实际未落在 npm root 下）；
   *  - 另一业务仓库的 e2e 工作目录（实测可用，版本 1.64.1）。
   * 按「本仓库 → 环境变量 → 已知绝对路径」的顺序探测，全部失败才报错。
   */
  const candidates = [
    process.env.NEOMD_PLAYWRIGHT_CORE || '',
    join(REPO, 'node_modules/playwright-core'),
    'C:/Data/DSH/jdy-push/_work/pwtest/node_modules/playwright-core',
    'C:/Data/DSH/jdy-push/_work/_pw-scratch/node_modules/playwright-core',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      return require(p);
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error(`未找到 playwright-core，尝试过：\n  ${candidates.join('\n  ')}`);
}

/** 直接指定已下载的 chromium 可执行文件，绕过 PLAYWRIGHT_BROWSERS_PATH 解析 */
function chromeExe() {
  const base = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  return join(base, 'chromium-1248', 'chrome-win64', 'chrome.exe');
}

/* ---------------- API（仅用于 finally 清理） ---------------- */

let token = '';
async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(init.json) };
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}`);
  return await res.json();
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(SHOTS, { recursive: true });

  // 登录一次（仅用于清理阶段调服务端 API；限流 10 次/分钟，全程只登录 1 次）
  const loginBody = await api('/api/auth/login', { method: 'POST', json: { username: USER, password: PASS } });
  token = loginBody?.data?.accessToken ?? '';
  if (!token) throw new Error('登录失败：响应缺少 accessToken');

  const browser = await chromium.launch({ executablePath: chromeExe(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  const vaultName = `re121rightdom${Date.now().toString(36)}`;
  let vaultId = '';
  let docId = '';
  let exitCode = 0;
  const results = {};

  try {
    hr('1. 打开工作台并登录');
    await page.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    /*
     * 注入 token 跳过 UI 登录表单（更快且不占登录限流）。
     *
     * 键名必须与 `apps/web/src/api/client.ts:38-39` 一致：
     *   TOKEN_KEY   = 'neomd.access'
     *   REFRESH_KEY = 'neomd.refresh'
     * 以及 `apps/web/src/stores/auth.ts:5` 的 USER_CACHE_KEY = 'neomd.user.cache'。
     * 写错键名不会报错，但 `getAccessToken()` 返回 null → `canSync()` false →
     * 云端归档整条链路静默不工作（首版脚本正是踩了这个坑：listDocVersions 返回 0）。
     */
    await page.evaluate(async ({ api, user, pass }) => {
      const res = await fetch(`${api}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const body = await res.json();
      const d = body?.data;
      if (!d?.accessToken) throw new Error('登录失败：' + JSON.stringify(body).slice(0, 200));
      localStorage.setItem('neomd.access', d.accessToken);
      localStorage.setItem('neomd.refresh', d.refreshToken);
      localStorage.setItem('neomd.user.cache', JSON.stringify(d.user));
    }, { api: API, user: USER, pass: PASS });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app', { timeout: 20_000 });

    // 等 store 就绪
    await page.waitForFunction(() => {
      const el = document.querySelector('#app');
      const pinia = el?.__vue_app__?.config.globalProperties?.$pinia;
      return Boolean(pinia?._s?.get('app')?.vault);
    }, { timeout: 25_000 });
    log('✓ 工作台已就绪');

    /*
     * 前置断言：登录态 + canSync()。
     *
     * 这两项是「云端历史版本」能否存在的**充要前提**：
     *  - 未登录 → buildSyncEngine() 返回 null → putRemoteVersion 不会发生；
     *  - canSync() false → saveActiveTab 里连 prevContent 都不读 → 归档永不触发。
     * 提前断言可以避免「版本数 0」这种下游症状掩盖真正的上游原因。
     */
    const pre = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      const auth = pinia._s.get('auth');
      return {
        isLoggedIn: auth.isLoggedIn,
        username: auth.user?.username ?? null,
        hasToken: Boolean(localStorage.getItem('neomd.access')),
        canSync: app.canSync(),
      };
    });
    log(`登录态：isLoggedIn=${pre.isLoggedIn} user=${pre.username} token=${pre.hasToken} canSync=${pre.canSync}`);
    if (!pre.isLoggedIn || !pre.canSync) {
      console.error('✗ 前置条件不满足：未登录或 canSync()=false，云端归档不可能发生');
      throw new Error('前置条件不满足：登录态 / canSync()');
    }
    log('✓ 登录态与 canSync() 均就绪');

    hr('2. 新建临时仓库 + 临时文档，连续保存 5 次不同内容');
    const setup = await page.evaluate(async ({ vaultName }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const app = pinia._s.get('app');
      const settings = pinia._s.get('settings');
      window.__app = app;
      // 关掉本地留痕，走真实产品形态（历史全在云端）
      settings.settings.localVault.keepVersions = false;
      // 右侧栏只开「历史版本」区块
      settings.updateLayout({ rightPanelOpen: true, rightPanelSections: ['history'] });

      await app.createAndSwitchVault(vaultName);
      await sleep(1200);
      await app.createDoc({ title: 'RE121-RIGHT-历史版本', content: '# 版本 0\n\n初始内容 RE121-RIGHT-0\n' });
      const docId = app.activeTab.docId;
      const tabId = app.activeTab.id;
      const bodies = ['# 版本 0\n\n初始内容 RE121-RIGHT-0\n'];
      for (let i = 1; i <= 5; i += 1) {
        const body = `# 版本 ${i}\n\n第 ${i} 次保存的正文，唯一标记 RE121-RIGHT-${i}。\n` + `正文行 ${i}。\n`.repeat(i);
        bodies.push(body);
        app.updateTabContent(tabId, body);
        await app.saveActiveTab();
        await sleep(300);
      }
      await sleep(1800);
      const merged = await app.listDocVersions(docId);
      const contents = [];
      for (const v of merged) contents.push(await app.readVersionContent(v));
      return {
        vaultId: app.vault.vaultId,
        docId,
        docPath: app.vault.get(docId)?.path,
        rev: app.vault.get(docId)?.rev,
        mergedCount: merged.length,
        mergedRevs: merged.map((v) => v.rev),
        distinctContents: new Set(contents).size,
        contents,
        bodies,
      };
    }, { vaultName });
    vaultId = setup.vaultId;
    docId = setup.docId;
    results.setup = { ...setup, contents: undefined, bodies: undefined };
    log(`临时仓库 ${vaultId}`);
    log(`临时文档 ${docId}  path=${setup.docPath}  rev=${setup.rev}`);
    log(`listDocVersions → ${setup.mergedCount} 版，内容 ${setup.distinctContents} 种`);

    if (setup.mergedCount < 5) {
      console.error(`✗ 版本数量不足：期望 ≥5，实际 ${setup.mergedCount}`);
      exitCode = 1;
    } else {
      log(`✓ 版本数量 ${setup.mergedCount} ≥ 5`);
    }
    if (setup.distinctContents !== setup.mergedCount) {
      console.error(`✗ 内容有重复：${setup.mergedCount} 条 / ${setup.distinctContents} 种`);
      exitCode = 1;
    } else {
      log(`✓ 内容全部不同（${setup.distinctContents} 种）`);
    }

    hr('3. 右侧栏「历史版本」区块 DOM 断言');
    // 触发一次 dirty 变化，让右侧栏 watch 重跑并拿到刚产生的版本
    await page.evaluate(() => {
      const app = window.__app;
      const tab = app.tabs.find((t) => t.docId === app.activeTab.docId);
      app.updateTabContent(tab.id, tab.content + ' ');
      setTimeout(() => {
        app.updateTabContent(tab.id, tab.content.slice(0, -1));
        tab.dirty = false;
      }, 300);
    });
    await page.waitForTimeout(2500);
    // 缩窄右侧栏让它完整可见并放大字号（仅注入样式，不改源码）
    await page.addStyleTag({
      content: `
        .rightstack { background: #fffbe6 !important; outline: 4px solid #ff4d4f; outline-offset: -4px;
                      min-height: 420px; }
        .rightstack__pane { min-height: 380px; }
        .verrow { font-size: 17px !important; padding: 10px 14px !important;
                  border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 6px;
                  display: flex !important; gap: 14px; align-items: center; }
        .verrow__rev { font-size: 17px !important; font-weight: 700 !important; color: #1677ff !important; min-width: 46px; }
        .verrow__time { font-size: 15px !important; color: #444 !important; min-width: 96px; }
        .verrow__label { font-size: 14px !important; color: #888 !important; }
        .rsection__title { font-size: 15px !important; font-weight: 700 !important; }
      `,
    });
    await page.waitForTimeout(600);

    const dom = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.verrow')];
      const rs = document.querySelector('.rightstack');
      const r = rs?.getBoundingClientRect();
      return {
        rightstackPresent: Boolean(rs),
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        rowCount: rows.length,
        rows: rows.map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
        moreBtn: document.querySelector('.rsection__more')?.textContent?.trim() ?? null,
        emptyText: document.querySelector('.rsection__empty')?.textContent?.trim() ?? null,
        panelText: rs?.innerText?.slice(0, 400) ?? null,
      };
    });
    results.dom = dom;
    log(`rightstack 存在=${dom.rightstackPresent} rect=${JSON.stringify(dom.rect)}`);
    log(`DOM .verrow 行数=${dom.rowCount}`);
    for (const t of dom.rows) log(`    ${t}`);
    if (dom.rowCount >= 5) log(`✓ 右侧栏 DOM 渲染 ${dom.rowCount} 条 ≥ 5`);
    else {
      console.error(`✗ 右侧栏 DOM 行数不足：${dom.rowCount}`);
      exitCode = 1;
    }

    const shot1 = join(SHOTS, 're121-right-history-rows.png');
    await page.screenshot({ path: shot1, fullPage: false });
    results.shot1 = shot1;
    log(`整页截图 → ${shot1}`);

    /*
     * 元素级截图：只截右侧栏本身。
     *
     * 整页图（1440×900）里右侧栏只占 399×800，缩到汇报里根本看不清版本行；
     * 直接对 `.rightstack` 元素截图可以得到一张**自证性最强**的图：
     * 图上就是「版本历史」标题 + v6…v1 六行 + 查看全部版本。
     */
    const shotEl = join(SHOTS, 're121-right-history-panel.png');
    const rsEl = await page.$('.rightstack');
    if (rsEl) {
      await rsEl.screenshot({ path: shotEl });
      results.shotEl = shotEl;
      log(`右侧栏元素截图 → ${shotEl}`);
    }

    hr('4. 点非最新版，断言预览内容 ≠ 最新版');
    // 右侧栏的行只负责「打开弹窗」（RightSection.vue: `@click="emit('openVersion')"`），
    // 因此这里先点最老的一行 → 弹窗打开；再在弹窗内点最老版 → 真正选中并渲染差异。
    const clickInfo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.verrow')];
      if (!rows.length) return { err: 'no rows' };
      const target = rows[rows.length - 1];
      const label = target.textContent.replace(/\s+/g, ' ').trim();
      target.click();
      return { clicked: label, index: rows.length - 1 };
    });
    await page.waitForTimeout(1500);

    // 弹窗内点最老版（时间倒序列表的最后一条 = 最旧），触发 pick() → 渲染 diff
    const modalClick = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.history .ver')];
      if (!rows.length) return { err: 'modal rows empty' };
      const target = rows[rows.length - 1];
      const label = target.textContent.replace(/\s+/g, ' ').trim();
      target.click();
      return { clicked: label, count: rows.length };
    });
    await page.waitForTimeout(1800);

    const preview = await page.evaluate(async (docId) => {
      const app = window.__app;
      const merged = await app.listDocVersions(docId);
      if (!merged.length) {
        return { err: '合并结果为 0 版，无法比对', mergedCount: 0 };
      }
      const oldest = merged[merged.length - 1];
      const newest = merged[0];
      const oldestBody = await app.readVersionContent(oldest);
      const newestBody = await app.readVersionContent(newest);
      const live = await app.vault.read(docId);
      return {
        mergedCount: merged.length,
        oldestRev: oldest.rev,
        newestRev: newest.rev,
        oldestHead: oldestBody.slice(0, 60),
        newestHead: newestBody.slice(0, 60),
        liveHead: live.slice(0, 60),
        oldestDiffersFromNewest: oldestBody !== newestBody,
        oldestDiffersFromLive: oldestBody !== live,
        modalOpen: Boolean(document.querySelector('.history')),
        modalRowCount: document.querySelectorAll('.history .ver').length,
        modalSelectedRow: document.querySelector('.history .ver.is-active')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        modalSource: document.querySelector('.history__source')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        modalPreviewHead: document.querySelector('.history__code')?.innerText?.slice(0, 200) ?? null,
        modalDiffStat: document.querySelector('.history .diffstat')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      };
    }, docId);
    results.preview = preview;
    if (preview.err) {
      console.error(`✗ ${preview.err}`);
      exitCode = 1;
    } else {
      log(`右侧栏点击行：${clickInfo.clicked}`);
      log(`弹窗内选中行：${modalClick.clicked}（共 ${modalClick.count} 行）`);
      log(`最老版 rev=${preview.oldestRev} head="${preview.oldestHead.split('\n')[0]}"`);
      log(`最新版 rev=${preview.newestRev} head="${preview.newestHead.split('\n')[0]}"`);
      log(`当前正文 head="${preview.liveHead.split('\n')[0]}"`);
      log(`弹窗选中态：${preview.modalSelectedRow}`);
      log(`差异统计：${preview.modalDiffStat}`);
      if (preview.oldestDiffersFromNewest && preview.oldestDiffersFromLive) {
        log('✓ 预览的最老版内容 ≠ 最新版 ≠ 当前正文');
      } else {
        console.error('✗ 预览内容与最新版/当前正文相同，说明版本没有真正区分');
        exitCode = 1;
      }
      log(`历史弹窗已打开=${preview.modalOpen} 行数=${preview.modalRowCount} source="${preview.modalSource}"`);
      if (!preview.modalPreviewHead) {
        console.error('! 弹窗预览区为空（diff 未渲染）');
        exitCode = 1;
      }
    }

    const shot2 = join(SHOTS, 're121-right-history-preview.png');
    await page.screenshot({ path: shot2, fullPage: false });
    results.shot2 = shot2;
    log(`整页截图 → ${shot2}`);

    // 历史弹窗元素级截图（含左侧版本列表 + 右侧差异预览）
    const shotModal = join(SHOTS, 're121-right-history-modal.png');
    const modalEl = await page.$('.history');
    if (modalEl) {
      await modalEl.screenshot({ path: shotModal });
      results.shotModal = shotModal;
      log(`历史弹窗元素截图 → ${shotModal}`);
    }

    // 附：把断言汇总写一份 JSON，便于验收报告引用
    const evidence = join(SHOTS, 're121-right-dom-evidence.json');
    await writeFile(evidence, JSON.stringify({ at: new Date().toISOString(), web: WEB, exitCode, ...results }, null, 2), 'utf8');
    log(`证据 JSON → ${evidence}`);
  } finally {
    /*
     * 清理（finally 保证必执行）：
     *  1. 关闭浏览器；
     *  2. 删除临时仓库（服务端登记 + 云端前缀对象，purge=1）。
     * 只操作本次新建的 `re121rightdom*` 仓库，绝不影响 admin 既有笔记。
     */
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    if (vaultId) {
      try {
        const del = await api(`/api/vaults/${encodeURIComponent(vaultId)}?purge=1`, { method: 'DELETE' });
        log(`\n已清理临时仓库 ${vaultId}，云端对象 ${del?.data?.purgedObjects ?? 0} 个`);
      } catch (e) {
        /*
         * 404 = 仓库从未登记到服务端（例如前置断言失败、或首同步尚未完成）。
         * 这种情况没有残留可清，属于正常路径，不能当成清理失败。
         */
        if (/→ 404/.test(e.message)) log(`\n临时仓库 ${vaultId} 未登记到服务端（404），无需清理`);
        else console.error(`! 清理临时仓库 ${vaultId} 失败：${e.message}`);
      }
    }
    // 无论清理是否成功，都列出当前仓库清单里是否还残留 re121 前缀的条目
    try {
      const list = await api('/api/vaults');
      const leftover = (list?.data?.vaults ?? []).filter((v) => /^re121/i.test(String(v.vaultId)));
      if (leftover.length) console.error(`! 仍有 re121 前缀残留：${leftover.map((v) => v.vaultId).join(', ')}`);
      else log('✓ 服务端无 re121 前缀残留');
    } catch {
      /* ignore */
    }
    try {
      await rm(join(tmpdir(), 'neomd-re121-right'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (exitCode !== 0) process.exitCode = exitCode;
    hr(exitCode === 0 ? '全部断言通过' : `存在失败断言（exitCode=${exitCode}）`);
  }
}

await main();
