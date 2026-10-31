/**
 * Neo MD 1.4 缺陷回归门禁（可独立运行）
 * =============================================================================
 * 1.4 的**发布门禁**：把本版 16 项需求变成可复跑断言，任何一条失败即退出码非 0。
 *
 * 用法：
 *   node tools/verify-140.mjs                        # 跑 A~E（默认，约 8~12 分钟）
 *   node tools/verify-140.mjs --only=A,C             # 只跑指定段
 *   node tools/verify-140.mjs --only=A --shots       # 顺带截图到 docs/shots-140/
 *   node tools/verify-140.mjs --negative-control     # 追加 N 段（证明断言非恒真）
 *   node tools/verify-140.mjs --with-regression      # 追加 G 段（含 verify-121 回归）
 *   node tools/verify-140.mjs --json=report.json     # 机器可读报告
 *   node tools/verify-140.mjs --hold-ms=5000         # 缩短长等待（冒烟用）
 *
 * 覆盖段落：
 *   A 插件     需求1/6/17  社区插件端到端 + 内置插件逐款可用
 *   B 后台     需求2/3/4/5 市场编辑 / 翻页20 / 分发最新版 / 用户管理增强
 *   C 布局     需求7/8     分屏拖动跟手 <3px / 右侧上限3+替换最上+拖动排序+刷新保持
 *   D 设置主题 需求11~16   分割线对比度 / 三档作用域 / 颜色细化 / 全项有效 / 无工具栏 / 保存语义
 *   E 数据     需求9/10    命名模板与 AI 提示词乱码 / admin 仓库残留
 *   N 负向对照             px→% 换算回旧版、主题白名单回旧版 → 原断言必须失败
 *   G 回归                 vitest / vue-tsc / tsc / **verify-121（1.3.1 六项不得回归）** / node --check
 *   P 零污染自证           本脚本自身对生产 settings / vaults 的写请求计数
 *
 * 实现拆分：tools/re140/ 下每段一个文件，单文件 < 40KB。
 * 硬约束（本仓库踩过两次 GBK 事故）：所有含中文的源文件只用 write/edit 工具写，
 * 绝不用 PowerShell 的 Set-Content / Out-File / > 重定向。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ALL_SECTIONS,
  API,
  ARGS,
  BASE,
  ONLY,
  authHeaders,
  check,
  cleanup,
  fmt,
  httpJson,
  loadChromium,
  login,
  results,
  section,
  snapshotProd,
  state,
  summary,
} from './re140/common.mjs';

import { sectionA } from './re140/a.mjs';
import { sectionB } from './re140/b.mjs';
import { sectionC } from './re140/c.mjs';
import { sectionD } from './re140/d.mjs';
import { sectionE } from './re140/e.mjs';
import { sectionN } from './re140/n.mjs';
import { sectionG } from './re140/g.mjs';

/**
 * [P] 零污染自证。
 *
 * 按「本脚本自身写请求」断言，而不是「生产数据是否变化」：
 * 并行修复组会自建临时仓库、改自己的设置，那些变化不能归因于本脚本。
 * Playwright 内被拦截的假云端请求不经过 httpJson，天然不计入。
 */
async function sectionP() {
  section('P', '零污染自证（本脚本自身未向生产库写设置 / 未建仓库）');

  const s = await httpJson(`${API}/api/settings?platform=desktop`, { headers: authHeaders(state.token) });
  const afterVersion = s.status === 200 && s.body?.ok ? Number(s.body.data.version ?? 0) : -1;
  const settingsWrites = state.selfWrites.filter((w) => /\/api\/settings/.test(w.url));
  check(
    'P1 本脚本未向生产库写设置（设置类改动走浏览器内假云端）',
    '自证口径：本脚本自身对 /api/settings 的 PUT 请求为 0 条',
    `自身写请求 ${settingsWrites.length} 条；生产设置版本 跑测前=${state.prodSettings?.version ?? '?'} 跑测后=${afterVersion}`,
    settingsWrites.length === 0,
    { note: '版本号变化也可能来自并行任务；能归因的是「本脚本有没有发过 PUT」' },
  );

  const vaultWrites = state.selfWrites.filter((w) => /\/api\/vaults/.test(w.url));
  const v = await httpJson(`${API}/api/vaults`, { headers: authHeaders(state.token) });
  const list = v.status === 200 && v.body?.ok ? (v.body.data?.vaults ?? []) : [];
  const ids = (Array.isArray(list) ? list : []).map((x) => x.vaultId).filter(Boolean);
  const before = new Set(state.prodVaults?.ids ?? []);
  const added = ids.filter((id) => !before.has(id));
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
  console.log('Neo MD 1.4 缺陷回归门禁');
  console.log(`  BASE=${BASE}  API=${API}`);
  console.log(
    `  sections=${[...ONLY].join(',')}${ARGS.withRegression ? ' + G(regression)' : ''}${ARGS.negativeControl ? ' + N(negative-control)' : ''}`,
  );

  /* ---------- 环境前置检查 ----------
   * 只打本地（5178 / 3200）。先确认本地服务健康，否则断言结果不可信
   * （1.3.1 期间 5178 因 esbuild 预转换失败崩过一次，表现为整页白屏）。
   */
  const health = await httpJson(`${API}/api/health`);
  console.log(`  本地 API：status=${health.status} ${fmt(health.body)}`);
  if (health.status !== 200) {
    console.error(`\n本地 API 不可用（${API}/api/health -> ${health.status}），门禁结果不可信，终止。`);
    process.exit(2);
  }
  const front = await fetch(`${BASE}/app`).catch(() => null);
  console.log(`  前端 dev：status=${front?.status ?? 'unreachable'}`);
  if (!front || front.status !== 200) {
    console.error(`\n前端 dev 不可用（${BASE}/app -> ${front?.status ?? 'unreachable'}），门禁结果不可信，终止。`);
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
    if (ONLY.has('B')) await sectionB();
    if (ONLY.has('C')) await sectionC(chromium);
    if (ONLY.has('D')) await sectionD(chromium);
    if (ONLY.has('E')) await sectionE();

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
    fs.mkdirSync(path.dirname(out), { recursive: true });
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
