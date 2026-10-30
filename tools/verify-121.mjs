/**
 * Neo MD 1.2.1 缺陷回归门禁（可独立运行）
 * =============================================================================
 * 这是 1.2.1 的**发布门禁**：六项用户缺陷各对应一个 section，任何一条断言失败
 * 即视为不可发布（退出码非 0）。
 *
 * 用法：
 *   node tools/verify-121.mjs                             # 跑 A~F（默认，约 8 分钟）
 *   node tools/verify-121.mjs --only=A,B                  # 只跑指定段
 *   node tools/verify-121.mjs --only=A --shots            # 顺带截图到 docs/shots-121/
 *   node tools/verify-121.mjs --with-regression           # 追加 G 段（vitest/tsc/119门禁）
 *   node tools/verify-121.mjs --negative-control          # 追加 N 段（证明断言非恒真）
 *   node tools/verify-121.mjs --json=report.json          # 额外输出机器可读结果
 *   node tools/verify-121.mjs --base=http://127.0.0.1:5178 --api=http://127.0.0.1:3200
 *
 * 覆盖段落：
 *   A 行距正常（行高比 / 两层叠加 / 段落净空白 / 空行=一行 / 空行可逆 / 档位语义）
 *   B 分屏右侧配色（浅色 + 深色：背景 / 文字 / 字号行高与主编辑器一致）
 *   C 设置字体不被自动恢复（3 个字体值 x 95s + focus/visibilitychange）
 *   D 保存后空换行不丢（段落间 2 空行 + 文末 3 空行 + 代码块内 2 空行，字节级）
 *   E 历史版本多版本可用（>=5 条 + >=3 条互不相同 + 第 2 版预览!=最新 + 恢复生效）
 *   F 设置项无重复（全页签遍历：控件级 + 语义级 + 字段容器级去重）
 *   N 负向对照（注入修复前样式 -> 原断言必须失败）        需 --negative-control
 *   G 回归门禁（vitest / vue-tsc / tsc / 119-full / node --check）  需 --with-regression
 *   P 零污染自证（本脚本未向生产库写设置 / 未建仓库）
 *
 * 实现拆分：本文件只做「编排 + 汇总」，各 section 在 tools/re121/ 下。
 * 拆分原因：单文件 2300+ 行时一次编辑失误就会让整份门禁不可运行；
 * 拆分后每个文件可单独 node --check，坏了也好定位。
 *
 * 设计约束：
 *  1. 只读产品代码，不改 apps/**、packages/**、services/**。
 *  2. 不污染生产数据：
 *     - 设置类全程由浏览器内「假云端」拦截（PUT/GET 都不出浏览器）
 *     - 文档类只用 QA121- 前缀的临时文档，finally 删文档 + 删云端 versions/docs 对象
 *     - 固定 deviceId = qa-verify-121，避免云端 index 文件堆积
 *  3. 每条断言输出「断言名 / 期望 / 实测 / 通过与否」，失败项附复现步骤。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ALL_SECTIONS,
  ARGS,
  BASE,
  API,
  ONLY,
  check,
  cleanup,
  fmt,
  httpJson,
  authHeaders,
  loadChromium,
  login,
  results,
  section,
  snapshotProd,
  state,
  summary,
} from './re121/common.mjs';

import { sectionA } from './re121/a.mjs';
import { sectionB } from './re121/b.mjs';
import { sectionC } from './re121/c.mjs';
import { sectionD } from './re121/d.mjs';
import { sectionE } from './re121/e.mjs';
import { sectionF } from './re121/f.mjs';
import { sectionN } from './re121/n.mjs';
import { sectionG } from './re121/g.mjs';

/**
 * [P] 零污染自证。
 *
 * 为什么按「本脚本自身写请求」而不是「生产数据是否变化」断言：
 * 并行的修复组会自己建/删临时仓库、也会改自己的设置，
 * 那些变化不能归因于本脚本。真正能证明「我没污染」的，是本脚本自己
 * 有没有发过那类写请求（Playwright 拦截的假云端请求不经过 httpJson，天然不计入）。
 */
async function sectionP() {
  section('P', '零污染自证（本脚本自身未向生产库写设置 / 未建仓库）');

  const s = await httpJson(`${API}/api/settings?platform=desktop`, { headers: authHeaders(state.token) });
  const afterVersion = s.status === 200 && s.body?.ok ? Number(s.body.data.version ?? 0) : -1;
  const settingsWrites = state.selfWrites.filter((w) => /\/api\/settings/.test(w.url));
  check(
    'P1 本脚本未向生产库写设置（设置类改动全程走浏览器内假云端）',
    '自证口径：本脚本自身对 /api/settings 的 PUT 请求为 0 条（Playwright 拦截的请求不经过 httpJson，不计入）',
    `自身写请求 ${settingsWrites.length} 条；生产设置版本 跑测前=${state.prodSettings?.version ?? '?'} 跑测后=${afterVersion}`,
    settingsWrites.length === 0,
    { note: '版本号变化也可能来自并行任务/其它设备；真正能归因的是「本脚本有没有发过 PUT」' },
  );

  const v = await httpJson(`${API}/api/vaults`, { headers: authHeaders(state.token) });
  const list = v.status === 200 && v.body?.ok ? (v.body.data?.vaults ?? v.body.data ?? []) : [];
  const ids = (Array.isArray(list) ? list : []).map((x) => x.vaultId).filter(Boolean);
  const before = new Set(state.prodVaults?.ids ?? []);
  const added = ids.filter((id) => !before.has(id));
  const vaultWrites = state.selfWrites.filter((w) => /\/api\/vaults/.test(w.url));
  check(
    'P2 本脚本未发起任何建仓/改仓请求',
    '自证口径：本脚本自身对 /api/vaults 的写请求为 0 条',
    `自身写请求 ${vaultWrites.length} 条；仓库集合变化 ${added.length ? `新增 ${fmt(added)}（来自并行任务，不计入本脚本污染）` : '无'}`,
    vaultWrites.length === 0,
    { note: '并行修复组会建/删自己的临时仓库，总数变化不可归因于本脚本' },
  );
}

function printHelp() {
  const text = fs.readFileSync(new URL(import.meta.url), 'utf8');
  console.log(text.split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*\*\s?/gm, ''));
}

async function main() {
  if (ARGS.help) {
    printHelp();
    process.exit(0);
  }

  const t0 = Date.now();
  console.log('Neo MD 1.2.1 缺陷回归门禁');
  console.log(`  BASE=${BASE}  API=${API}`);
  console.log(
    `  sections=${[...ONLY].join(',')}${ARGS.withRegression ? ' + G(regression)' : ''}${ARGS.negativeControl ? ' + N(negative-control)' : ''}`,
  );

  /* ---------- 环境前置检查 ----------
   * 只打本地（5178 / 3200），不打生产域名。
   * 先确认本地服务健康，否则任何断言结果都不可信
   * （5178 曾因 esbuild 预转换失败崩过一次，表现为整页白屏、所有 selector 都找不到）。
   */
  const health = await httpJson(`${API}/api/health`);
  console.log(`  本地 API 健康检查：status=${health.status} ${fmt(health.body)}`);
  if (health.status !== 200) {
    console.error(`\n本地 API 不可用（${API}/api/health -> ${health.status}），门禁结果不可信，终止。`);
    process.exit(2);
  }
  const page0 = await fetch(`${BASE}/app`).catch(() => null);
  console.log(`  前端 dev 健康检查：status=${page0?.status ?? 'unreachable'}`);
  if (!page0 || page0.status !== 200) {
    console.error(`\n前端 dev 不可用（${BASE}/app -> ${page0?.status ?? 'unreachable'}），门禁结果不可信，终止。`);
    process.exit(2);
  }

  await login();
  console.log(`  登录成功：${state.user?.username}`);
  await snapshotProd();
  console.log(
    `  生产快照（只读）：设置 version=${state.prodSettings?.version ?? '?'}；仓库 ${state.prodVaults?.count ?? '?'} 个`,
  );

  const chromium = await loadChromium();
  try {
    if (ONLY.has('A')) await sectionA(chromium);
    if (ONLY.has('B')) await sectionB(chromium);
    if (ONLY.has('C')) await sectionC(chromium);
    if (ONLY.has('D')) await sectionD(chromium);
    if (ONLY.has('E')) await sectionE(chromium);
    if (ONLY.has('F')) await sectionF(chromium);

    const wantN = ONLY.has('N') && (ARGS.negativeControl || Boolean(ARGS.only?.includes('N')));
    if (wantN) await sectionN(chromium);

    const wantG = ONLY.has('G') && (ARGS.withRegression || Boolean(ARGS.only?.includes('G')));
    if (wantG) await sectionG();

    await sectionP();
  } finally {
    try {
      await cleanup(chromium);
    } catch (e) {
      console.log(`  清理异常：${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  const { failed } = summary();
  const report = {
    base: BASE,
    api: API,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    sections: [...ONLY],
    results: ALL_SECTIONS.flatMap((sec) => results.filter((r) => r.section === sec)),
  };
  if (ARGS.json) {
    const out = path.resolve(process.cwd(), ARGS.json);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n机器可读报告：${ARGS.json}`);
  }
  console.log(`\n耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n门禁脚本异常终止：', e);
  process.exit(2);
});
