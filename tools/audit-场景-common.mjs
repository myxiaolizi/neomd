/**
 * 1.4.0 产品可用性审计 —— 共享基础设施
 * =============================================================================
 * 复用 `tools/re140/common.mjs`（1.4 门禁）已解决的三件事，不重复造轮子：
 *   1. `--disable-gpu` 启动参数（本机无头 Chrome 默认参数约 30s 崩）；
 *   2. 登录 429 限流退避（10 次/分钟）；
 *   3. `/api/settings` 拦截式假云端（settingsMode='fake'）—— 审计要改设置，
 *      但**绝不能**把审计值留在生产库的 admin 账号上。
 *
 * 本文件只补审计特有的三件事：
 *   - 场景结果记录（S1~S16 的「步骤/期望/实际/耗时/成败」）；
 *   - 截图归档到 docs/AUDIT-140/shots/；
 *   - 「临时文档」登记与 finally 清理（含云端对象）。
 *
 * ## 纪律
 * 审计是**只读产品代码**，发现问题只记录、不修改。
 * 唯一会写的是本文件与场景脚本产生的报告/截图/临时文档，临时文档在 finally 删除。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_SECTIONS,
  API,
  ARGS,
  BASE,
  LAUNCH_ARGS,
  THRESHOLD,
  authHeaders,
  check,
  cleanup,
  closeSettings,
  colorClose,
  contrastRatio,
  escapeSettings,
  fmt,
  httpJson,
  loadChromium,
  login,
  newSession,
  openSettings,
  openWorkbench,
  parseColor,
  readCssVars,
  readSaveBar,
  readTabContent,
  results,
  saveSettings,
  section,
  setMode,
  settingsStoreEval,
  settingsTabs,
  shot,
  sleep,
  snapshotSettings,
  storeEval,
  summary,
  waitResilient,
  cancelSettings,
  clickSettingsTab,
  state,
  STORE_EXPR,
  SETTINGS_STORE_EXPR,
  restoreSettings,
} from './re140/common.mjs';

export {
  ALL_SECTIONS,
  API,
  ARGS,
  BASE,
  LAUNCH_ARGS,
  THRESHOLD,
  authHeaders,
  check,
  cleanup,
  closeSettings,
  colorClose,
  contrastRatio,
  escapeSettings,
  fmt,
  httpJson,
  loadChromium,
  login,
  newSession,
  openSettings,
  openWorkbench,
  parseColor,
  readCssVars,
  readSaveBar,
  readTabContent,
  results,
  saveSettings,
  section,
  setMode,
  settingsStoreEval,
  settingsTabs,
  shot,
  sleep,
  snapshotSettings,
  storeEval,
  summary,
  waitResilient,
  cancelSettings,
  clickSettingsTab,
  state,
  STORE_EXPR,
  SETTINGS_STORE_EXPR,
  restoreSettings,
};

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 审计截图目录（与门禁的 docs/shots-140 分开，避免混淆两套证据） */
export const AUDIT_SHOT_DIR = path.join(ROOT, 'docs', 'AUDIT-140', 'shots');

/* ------------------------------------------------------------------ */
/* 场景步骤记录                                                        */
/*                                                                     */
/* 与门禁的 `check()` 的区别：门禁断言的是「需求是否满足」，            */
/* 审计记录的是「用户能不能完成这件事」，所以额外要「耗时」与           */
/* 「遇到的问题」两列 —— 报告里要回答「写一篇 500 字要多久」。          */
/* ------------------------------------------------------------------ */

/**
 * 审计场景结果。
 *
 * status 语义（不用 pass/fail，因为审计里「能用但难用」是重要结论）：
 *  - 'ok'      按预期完成
 *  - 'partial' 能完成但有明显缺陷/绕路
 *  - 'fail'    完不成
 *  - 'skip'    前置条件不满足（如注册未开放），必须写清原因
 */
export const scenarios = [];

/** 开始一个场景，返回一个用于记录步骤的句柄 */
export function beginScenario(id, title, goal) {
  const started = Date.now();
  const rec = {
    id,
    title,
    goal,
    steps: [],
    status: 'ok',
    notes: [],
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  scenarios.push(rec);
  console.log(`\n${'='.repeat(78)}\n[${id}] ${title}\n  目标：${goal}\n${'='.repeat(78)}`);
  return {
    /** 记录一步操作 */
    step(action, expect, actual, ok, note = '') {
      const s = { action, expect: fmt(expect), actual: fmt(actual), ok: Boolean(ok), note };
      rec.steps.push(s);
      console.log(`  ${ok ? '\u2713' : '\u2717'} ${action}`);
      console.log(`      期望: ${s.expect}`);
      console.log(`      实测: ${s.actual}`);
      if (note) console.log(`      备注: ${note}`);
      if (!ok && rec.status === 'ok') rec.status = 'partial';
      return Boolean(ok);
    },
    /** 记一条「能用但难用」的观察 */
    observe(text) {
      rec.notes.push(text);
      console.log(`      \u2298 观察: ${text}`);
    },
    /** 标记场景整体失败 */
    fail(reason) {
      rec.status = 'fail';
      rec.notes.push(`失败：${reason}`);
      console.log(`      \u2717 场景失败：${reason}`);
    },
    /** 标记跳过 */
    skip(reason) {
      rec.status = 'skip';
      rec.notes.push(`跳过：${reason}`);
      console.log(`      \u2298 跳过：${reason}`);
    },
    /** 结束并结算耗时 */
    end() {
      rec.durationMs = Date.now() - started;
      console.log(`  -> ${rec.id} 结论：${rec.status}（${(rec.durationMs / 1000).toFixed(1)}s，${rec.steps.length} 步）`);
      return rec;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 截图                                                               */
/* ------------------------------------------------------------------ */

/** 审计截图（总是保存，不受 --shots 开关影响：审计结论必须有证据） */
export async function auditShot(page, name) {
  fs.mkdirSync(AUDIT_SHOT_DIR, { recursive: true });
  const file = path.join(AUDIT_SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`      (截图: docs/AUDIT-140/shots/${name}.png)`);
  return `docs/AUDIT-140/shots/${name}.png`;
}

/* ------------------------------------------------------------------ */
/* 临时文档登记与清理                                                  */
/* ------------------------------------------------------------------ */

/**
 * 登记一个临时文档，供 `finally` 里删除。
 *
 * 为什么审计也必须登记：S4/S5/S9 要反复新建文档验证保存/往返/历史版本，
 * 如果不清理，生产库里会堆出一批「审计测试文档」，污染真实用户的文件列表。
 */
export function trackDoc(docId, title) {
  if (!docId) return;
  state.createdDocs.push({ docId, title, path: title });
}

/** 通过 store 删除本脚本创建的临时文档（尽力而为，失败不阻断） */
export async function deleteTrackedDocs(page) {
  if (!state.createdDocs.length) return { deleted: 0, failed: 0 };
  let deleted = 0;
  let failed = 0;
  for (const d of state.createdDocs) {
    const r = await page
      .evaluate(
        async ({ expr, id }) => {
          // eslint-disable-next-line no-eval
          const s = eval(expr);
          try {
            await s.deleteDoc(id);
            return { ok: true };
          } catch (e) {
            return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
          }
        },
        { expr: STORE_EXPR, id: d.docId },
      )
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e).slice(0, 120) }));
    if (r.ok) deleted += 1;
    else {
      failed += 1;
      console.log(`  临时文档删除失败 ${d.title ?? d.docId}: ${r.reason}`);
    }
  }
  console.log(`  临时文档清理：删除 ${deleted} / 失败 ${failed}`);
  return { deleted, failed };
}

/* ------------------------------------------------------------------ */
/* 报告用的小工具                                                      */
/* ------------------------------------------------------------------ */

/** 把场景结果写成 JSON，方便报告引用精确数字 */
export function writeScenarioJson(name, extra = {}) {
  const dir = path.join(ROOT, 'docs', 'AUDIT-140');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const payload = { generatedAt: new Date().toISOString(), scenarios, ...extra };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n场景 JSON 已写：docs/AUDIT-140/${name}`);
  return file;
}

/** 场景汇总（按 status 计数） */
export function scenarioSummary() {
  const ok = scenarios.filter((s) => s.status === 'ok').length;
  const partial = scenarios.filter((s) => s.status === 'partial').length;
  const fail = scenarios.filter((s) => s.status === 'fail').length;
  const skip = scenarios.filter((s) => s.status === 'skip').length;
  console.log(`\n${'='.repeat(78)}\n场景汇总\n${'='.repeat(78)}`);
  for (const s of scenarios) {
    const dur = (s.durationMs / 1000).toFixed(1);
    console.log(`  ${s.id.padEnd(4)} ${s.status.padEnd(8)} ${dur.padStart(6)}s  ${s.title}`);
    for (const n of s.notes) console.log(`         · ${n}`);
  }
  console.log(`\n  完整可用 ${ok} / 有缺陷 ${partial} / 不可用 ${fail} / 跳过 ${skip}（共 ${scenarios.length}）`);
  return { ok, partial, fail, skip, total: scenarios.length };
}

/** 简单的耗时测量助手 */
export async function timed(fn) {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* 零污染保险：审计绝不改生产数据                                       */
/*                                                                     */
/* ## 为什么审计比门禁更需要这个                                        */
/*                                                                     */
/* 门禁只在最后跑一次设置断言；审计要**反复**改设置（S15 全项设置、S16 插件） */
/* 还要新建/删除文档、建仓库。任何一处漏拦都会把测试值留到 admin 的线上配置上 */
/* ——1.4.0 期间已经发生过一次（靠手工归零基线才恢复）。                  */
/*                                                                     */
/* 手段（三层，逐层收紧）：                                             */
/*  1. `newSession({settingsMode:'fake'})` 拦截 `/api/settings*`（re140/common 已实现）；*/
/*  2. 本文件的 `installWriteGuard(page)` 额外拦截**浏览器侧**所有非 GET 请求， */
/*     命中白名单外的写操作直接 abort 并记账；                          */
/*  3. finally 里 `assertZeroWrites()` 输出「本脚本发出的写请求数」= 0 自证。*/
/* ------------------------------------------------------------------ */

/**
 * 允许放行的写请求（白名单）。
 *
 * 判据：只放行「鉴权」「纯查询型 POST」以及**被测功能本身的写入路径**。
 *
 * ## 为什么 `/api/storage/**` 必须放行
 *
 * 文档保存的真实路径就是 `PUT /api/storage/object?key=docs/<docId>/<rev>-<hash>.md`。
 * 第一版把它当「危险写」拦了，结果**保存永远不落库**，重开必然为空 ——
 * 于是我把「保存功能正常」误判成「内容丢失」。
 * 这类误判比漏测更糟：它会让报告出现假缺陷，浪费修复资源。
 *
 * 放行后如何保证不污染：由调用方登记创建的文档，在 finally 里逐个
 * `deleteDoc()`，再用「文档对象数基线对比」自证。
 *
 * ## 为什么 `/api/vaults` **不在**白名单（必须继续拦）
 *
 * 实测事故：全新浏览器上下文（本地仓库为空）打开工作台时，客户端会
 * `POST /api/vaults` 把 `docCount`/`bytes` 上报成 0。而服务端
 * （`services/api/src/routes/vaults.js:127`）直接
 * `ON DUPLICATE KEY UPDATE doc_count = VALUES(doc_count)` ——
 * **真实统计被 0 覆盖**，数据一条没少，但用户会看到「0 篇文档」。
 *
 * 这是本次审计发现的真实产品缺陷（会写进报告）；对审计脚本而言，
 * 拦掉它既避免污染、又让「统计归零」这个缺陷能被稳定复现（见缺陷脚本）。
 */
export const WRITE_ALLOWLIST = [
  /\/api\/auth\/login$/,
  /\/api\/auth\/refresh$/,
  /\/api\/auth\/logout$/,
  /\/api\/ai\/(chat|complete|test|credits)/,
  /\/api\/ai\/providers/,
  /\/api\/ai\/platform-models/,
  /\/api\/storage\/(probe|list|object|presign|multipart)/,
  /\/api\/download\//,
  /\/api\/plugins\/market/,
  /\/api\/health/,
];

/** 明确**必须拦截**的写路径（即使将来有人把白名单放宽，也不能放行这些） */
export const WRITE_HARD_BLOCK = [
  { re: /\/api\/vaults$/, why: '客户端会用它把 docCount/bytes 上报成 0，覆盖真实统计' },
  { re: /\/api\/settings/, why: '会覆盖 admin 的生产设置（1.4.0 期间已污染过一次）' },
];

/** 本次运行所有被拦截的写请求（用于自证） */
export const blockedWrites = [];
/** 本次运行所有放行的写请求（用于说明「为什么它无害」） */
export const allowedWrites = [];

/**
 * 给页面装写请求守卫：除白名单外，一切 POST/PUT/PATCH/DELETE 都 abort。
 *
 * 注意只拦 `/api/**`（页面自身的静态资源不在此列）。
 * 返回一个卸载函数。
 */
export async function installWriteGuard(page, { log = true } = {}) {
  const handler = async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = req.url();
    if (!/\/api\//.test(url)) return route.continue();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
    // 硬拦截优先：即便命中白名单也不放行（白名单是「可以放行」，不是「优先放行」）
    const hard = WRITE_HARD_BLOCK.find((h) => h.re.test(url));
    if (hard) {
      blockedWrites.push({ method, url, why: hard.why });
      if (log) console.log(`      [写守卫] 已阻断 ${method} ${url.replace(BASE, '')} —— ${hard.why}`);
      return route.abort('blockedbyclient');
    }
    if (WRITE_ALLOWLIST.some((re) => re.test(url))) {
      allowedWrites.push({ method, url });
      return route.continue();
    }
    blockedWrites.push({ method, url });
    if (log) console.log(`      [写守卫] 已阻断 ${method} ${url.replace(BASE, '')}`);
    return route.abort('blockedbyclient');
  };
  await page.route('**/api/**', handler);
  return () => page.unroute('**/api/**', handler);
}

/**
 * 零污染自证：输出本脚本发出/被拦截的写请求统计。
 *
 * 期望：`blocked` 里全是「本来就不该发生」的写；`allowed` 里全是白名单内的无害请求。
 * 报告里要写明这两个数字 —— 这是「审计没有污染生产库」的唯一硬证据。
 */
export function assertZeroWrites(label = '') {
  console.log(`\n----- 零污染自证 ${label} -----`);
  console.log(`  被拦截的写请求：${blockedWrites.length} 条`);
  for (const w of blockedWrites.slice(0, 12)) console.log(`    × ${w.method} ${w.url.replace(BASE, '')}`);
  console.log(`  放行的白名单写请求：${allowedWrites.length} 条（鉴权/查询型，不改用户数据）`);
  const byUrl = new Map();
  for (const w of allowedWrites) {
    const key = `${w.method} ${w.url.replace(BASE, '').split('?')[0]}`;
    byUrl.set(key, (byUrl.get(key) ?? 0) + 1);
  }
  for (const [k, n] of byUrl) console.log(`    \u2713 ${k} ×${n}`);
  return { blocked: blockedWrites.length, allowed: allowedWrites.length };
}

/**
 * 记录云端「数据基线」，供 finally 对比是否被污染。
 *
 * 只记录**数量类**指标：文档数、仓库数、设置版本号。数量变了就说明写进去了。
 *
 * ## 为什么要「稳定读」（连续两次一致才采信）
 *
 * 实测踩到的坑：删完临时文档后立刻查 `/api/vaults`，会拿到 sync 过程中的
 * **中间态**——`docCount` 短暂返回 0，基线对比于是报出「admin 文档数 281→0」
 * 这种骇人结论，而实际上一条文档都没少（连查 3 次都是 283）。
 *
 * 审计报告里出现「数据丢失」是最严重的误报，必须用稳定读消掉：
 * 连续两次读数完全一致才返回，否则重试；始终不稳则标注 `unstable: true`，
 * 由调用方在结论里写明「统计波动，未采信」，而不是当成事实。
 */
export async function snapshotCloudBaseline({ attempts = 4, intervalMs = 800 } = {}) {
  const read = async () => {
    const h = authHeaders(state.token);
    const vaults = await httpJson(`${API}/api/vaults`, { headers: h });
    const list = vaults.status === 200 && vaults.body?.ok ? (vaults.body.data?.vaults ?? []) : [];
    const settings = await httpJson(`${API}/api/settings?platform=web`, { headers: h });
    return {
      at: new Date().toISOString(),
      vaultCount: Array.isArray(list) ? list.length : 0,
      docCounts: Object.fromEntries(
        (Array.isArray(list) ? list : []).map((v) => [v.vaultId, Number(v.docCount ?? 0)]),
      ),
      settingsVersion: settings.status === 200 && settings.body?.ok ? Number(settings.body.data.version ?? 0) : 0,
    };
  };
  let prev = await read();
  for (let i = 1; i < attempts; i += 1) {
    await sleep(intervalMs);
    const cur = await read();
    if (JSON.stringify(cur.docCounts) === JSON.stringify(prev.docCounts) && cur.vaultCount === prev.vaultCount) {
      return { ...cur, stable: true, samples: i + 1 };
    }
    prev = cur;
  }
  return { ...prev, stable: false, samples: attempts };
}

/** 对比基线，返回差异（空 = 零污染） */
export async function diffCloudBaseline(base) {
  const now = await snapshotCloudBaseline();
  const diffs = [];
  if (!now.stable) {
    console.log(`\n----- 云端数据基线对比（\u26a0 统计不稳定，结论仅供参考） -----`);
  } else {
    console.log(`\n----- 云端数据基线对比 -----`);
  }
  if (now.vaultCount !== base.vaultCount) diffs.push(`仓库数 ${base.vaultCount}→${now.vaultCount}`);
  for (const [id, n] of Object.entries(base.docCounts)) {
    const cur = now.docCounts[id];
    if (cur !== undefined && cur !== n) diffs.push(`仓库 ${id} 文档数 ${n}→${cur}`);
  }
  for (const id of Object.keys(now.docCounts)) {
    if (!(id in base.docCounts)) diffs.push(`新增仓库 ${id}`);
  }
  // 设置版本号变化只作提示，不当作污染（其他并行任务也会推设置）
  const settingsChanged = now.settingsVersion !== base.settingsVersion;
  console.log(`  基线：${base.vaultCount} 个仓库，设置版本 ${base.settingsVersion}`);
  console.log(`  现在：${now.vaultCount} 个仓库，设置版本 ${now.settingsVersion}（采样 ${now.samples} 次，稳定=${now.stable}）`);
  console.log(`  文档数：基线 ${JSON.stringify(base.docCounts)}`);
  console.log(`          现在 ${JSON.stringify(now.docCounts)}`);
  if (settingsChanged) {
    console.log(`  \u26a0 设置版本变化 ${base.settingsVersion}→${now.settingsVersion}（可能为并行任务推送，非本脚本）`);
  }
  const hardDiffs = diffs.filter((d) => !/设置版本/.test(d));
  console.log(`  ${hardDiffs.length ? `\u2717 数据差异：${hardDiffs.join('; ')}` : '\u2713 文档/仓库零差异（审计未改动生产数据）'}`);
  return hardDiffs;
}

/**
 * 等待某个谓词在页面上成立（轮询，带超时）。
 * 审计里大量「点完之后等界面反映出结果」的断言用它，避免固定 sleep 造成的假失败/慢测试。
 */
export async function waitUntil(page, predFn, { timeout = 15000, interval = 250, arg = null } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await page.evaluate(predFn, arg).catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}
