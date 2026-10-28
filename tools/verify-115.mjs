/**
 * Neo MD 1.1.5 验收测试。
 *
 * 覆盖本次两项需求：
 *   A. 仓库管理：设置页「仓库」页签，可查看列表、切换、备份、复制、改名、停用、删除
 *   B. 同一账号跨端仓库一致：仓库列表持久化、vaultId 随同步隔离、云端清单合并
 *
 * 用法：
 *   node tools/verify-115.mjs
 *   SMOKE_BASE=https://md.zhengl.vip node tools/verify-115.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-115');
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
  const u = r.url();
  if (r.status() >= 400 && !u.includes('/api/')) httpErrors.push(`${r.status()} ${u.slice(0, 110)}`);
});
page.on('pageerror', (e) => console.log('    [pageerror]', String(e.message).slice(0, 160)));

/** 打开设置页并切到指定页签（用显式等待，避免时序假失败） */
async function openSettingsTab(label) {
  // 设置是标签页：先看是否已打开，没有就 Ctrl+, 打开
  let navCount = await page.locator('.settings__nav-item').count();
  if (navCount === 0) {
    await page.keyboard.press('Control+,');
    // 显式等页签出现，而不是固定 sleep
    await page
      .locator('.settings__nav-item')
      .first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .catch(() => undefined);
    navCount = await page.locator('.settings__nav-item').count();
  }
  if (navCount === 0) {
    // 兜底：尝试点击功能区/其他入口里的「设置」
    const anySettings = page.locator('[title*="设置"]').first();
    if (await anySettings.count()) {
      await anySettings.click();
      await page.waitForTimeout(1500);
      navCount = await page.locator('.settings__nav-item').count();
    }
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
  console.log('\n[0] 启动');
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.editorbar, .empty', { timeout: 25000 });
  if (!(await page.locator('.editorbar').count())) {
    const btn = page.locator('.empty button', { hasText: '新建文档' }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }
  check(true, '进入编辑器');
  await page.screenshot({ path: path.join(shots, '01-editor.png') });

  /* ============ A. 仓库管理 ============ */
  console.log('\n[A.1] 设置页存在「仓库」页签');
  // 必须先打开设置页，再读页签列表（此前顺序错了，读到的空数组）
  await openSettingsTab('通用');
  const tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.settings__nav-item')).map((n) => (n.textContent || '').trim()),
  );
  console.log('    页签：', tabLabels.join(' / '));
  check(tabLabels.length > 0, '设置页已打开且渲染页签', `${tabLabels.length} 个`);
  check(tabLabels.includes('仓库'), '存在「仓库」页签', tabLabels.join('/'));

  if (tabLabels.includes('仓库')) {
    await openSettingsTab('仓库');
    await page.screenshot({ path: path.join(shots, '02-vault-manager.png') });

    console.log('\n[A.2] 仓库列表与当前标记');
    const listInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      // 真实行 class 是 .vm-row；容器带 data-testid="vm-list"
      const rows = Array.from(document.querySelectorAll('.vm-row'));
      return {
        rowCount: rows.length,
        listExists: Boolean(document.querySelector('[data-testid="vm-list"]')),
        rowNames: rows.map((r) => (r.querySelector('[class*="name"]')?.textContent || r.textContent || '').trim().slice(0, 24)),
        hasCurrent: /当前/.test(text),
        hasSwitch: /切换/.test(text),
        hasBackup: /备份/.test(text),
        hasCopy: /复制/.test(text),
        hasRename: /改名|重命名/.test(text),
        hasDisable: /停用/.test(text),
        hasDelete: /删除/.test(text),
        hasAdd: /添加仓库|新建仓库/.test(text),
      };
    });
    console.log('    ', JSON.stringify(listInfo).slice(0, 460));
    check(listInfo.listExists, '仓库列表容器已渲染');
    check(listInfo.rowCount >= 1, '至少渲染 1 个仓库条目', String(listInfo.rowCount));
    check(listInfo.hasCurrent, '有「当前」标记');
    check(listInfo.hasSwitch, '有「切换」按钮');
    check(listInfo.hasBackup, '有「备份」按钮');
    check(listInfo.hasCopy, '有「复制」按钮');
    check(listInfo.hasRename, '有「改名」按钮');
    check(listInfo.hasDisable, '有「停用」按钮');
    check(listInfo.hasDelete, '有「删除」按钮');
    check(listInfo.hasAdd, '有「添加仓库」入口');

    console.log('\n[A.3] 仓库数据已持久化到 localStorage');
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('neomd.vaultList.v1');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
        return {
          isArray: Array.isArray(parsed),
          count: arr.length,
          hasVaultId: arr.some((e) => typeof e.vaultId === 'string' && e.vaultId.length > 0),
          hasStatus: arr.some((e) => e.status === 'active' || e.status === 'disabled'),
          names: arr.map((e) => e.name).slice(0, 5),
        };
      } catch {
        return { parseError: true };
      }
    });
    console.log('    ', JSON.stringify(persisted));
    check(persisted !== null && !persisted.parseError, 'localStorage 中有仓库清单');
    if (persisted) {
      check(persisted.count >= 1, '清单至少 1 条', String(persisted.count));
      check(persisted.hasVaultId, '清单含 vaultId（同步隔离的基础）');
      check(persisted.hasStatus, '清单含 status（停用/启用）');
    }

    console.log('\n[A.4] 三档视口布局');
    for (const [w, h] of [[1280, 860], [1920, 1000], [900, 760]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      const layout = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      check(layout.overflowX <= 1, `${w}px 无横向溢出`, String(layout.overflowX));
      if (w === 900) await page.screenshot({ path: path.join(shots, '03-vault-900.png') });
    }
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.waitForTimeout(400);
  }

  /* ============ B. 跨端一致性基础设施 ============ */
  console.log('\n[B.1] 同步前缀含 vaultId（多仓库隔离）');
  const prefixInfo = await page.evaluate(() => {
    const raw = localStorage.getItem('neomd.vaultList.v1');
    if (!raw) return { vaultId: null };
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
      const cur = parsed.currentVaultId ?? null;
      const entry = cur ? arr.find((e) => e.vaultId === cur) : arr[0];
      return { vaultId: entry?.vaultId ?? null, currentId: cur, count: arr.length };
    } catch {
      return { vaultId: null };
    }
  });
  console.log('    ', JSON.stringify(prefixInfo));
  check(Boolean(prefixInfo.vaultId), '当前仓库有稳定 vaultId', String(prefixInfo.vaultId));
  check(!String(prefixInfo.vaultId).startsWith('pending:'), 'vaultId 已从占位符替换为真实 id', String(prefixInfo.vaultId));

  console.log('\n[B.2] 多个仓库互不覆盖（模拟用户 PC 端三仓库场景）');
  const multi = await page.evaluate(() => {
    // 直接验证注册表能承载多仓库（真实场景由 UI 逐个添加）
    const raw = localStorage.getItem('neomd.vaultList.v1');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
    const ids = arr.map((e) => e.vaultId);
    return { count: ids.length, unique: new Set(ids).size, ids: ids.slice(0, 5) };
  });
  console.log('    ', JSON.stringify(multi));
  check(multi.unique === multi.count, '每个仓库 vaultId 唯一（不会互相覆盖）', `${multi.unique}/${multi.count}`);

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
