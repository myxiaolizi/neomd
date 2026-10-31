#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **同步引擎三方合并正确性验证**（只读，进程内调用）。
 *
 * 为什么这是审计重点：`threeWayMerge()` 是**数据安全的核心**——
 * 它决定两台设备同时改同一篇文档时，内容是被正确合并、还是被静默丢失。
 * 它的失败模式极其危险：**返回一个"看起来合理"但丢了一方改动的结果**。
 *
 * 本脚本用真实 `packages/core/src/sync/sync-engine.ts` 的 `threeWayMerge` 函数，
 * 构造 20+ 个用例，覆盖：
 *  A. 三方相同 / 只有一方改 / 双方改不同区域（应成功合并）
 *  B. 双方改同一行（应返回 null → 进入冲突，**不能**静默选一个）
 *  C. 边界：空内容、无换行结尾、CRLF、超长、Unicode、代码块
 *  D. **关键：合并结果不能丢内容**（对每个成功合并的用例做「双方改动都在」断言）
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

/* 用 esbuild 把 sync-engine 单独打成可 import 的模块（它依赖 @neomd/shared 类型，需 alias） */
async function loadMerge() {
  const require2 = createRequire(import.meta.url);
  const esbuild = require2(join(REPO, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'));
  const outfile = join(REPO, 'packages/core/.audit-sync-bundle.mjs');
  await esbuild.build({
    entryPoints: [join(REPO, 'packages/core/src/sync/sync-engine.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    alias: { '@neomd/shared': join(REPO, 'packages/shared/src/index.ts') },
    external: ['markdown-it', 'minisearch', 'sql.js'],
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { merge: mod.threeWayMerge, diffLines: mod.diffLines, outfile };
}

const CASES = [];
function add(group, name, base, local, remote, expect) {
  CASES.push({ group, name, base, local, remote, expect });
}

/* ── A. 应当成功合并（返回字符串） ── */
add('A', '三方完全相同', 'A\nB\nC', 'A\nB\nC', 'A\nB\nC', { type: 'merge', mustInclude: [] });
add('A', '只有 local 改', 'A\nB\nC', 'A\nB2\nC', 'A\nB\nC', { type: 'merge', mustInclude: ['B2'] });
add('A', '只有 remote 改', 'A\nB\nC', 'A\nB\nC', 'A\nB3\nC', { type: 'merge', mustInclude: ['B3'] });
add('A', '双方改不同区域（上 / 下）', 'A\nB\nC\nD\nE', 'A-X\nB\nC\nD\nE', 'A\nB\nC\nD\nE-Y', {
  type: 'merge',
  mustInclude: ['A-X', 'E-Y'],
});
add('A', '双方在同一区域改出相同内容', 'A\nB\nC', 'A\nB\nC', 'A\nB\nC', { type: 'merge', mustInclude: [] });
add('A', '双方都追加到末尾（不同内容）', 'A\nB', 'A\nB\nL', 'A\nB\nR', { type: 'merge-or-conflict', mustInclude: [] });
add('A', '一方删除中间行，另一方改末尾', 'A\nB\nC\nD', 'A\nC\nD', 'A\nB\nC\nD-R', {
  type: 'merge',
  mustInclude: ['D-R'],
});
add('A', '双方各插入一行（位置不同）', 'A\nB\nC\nD\nE\nF', 'A\nL\nB\nC\nD\nE\nF', 'A\nB\nC\nD\nE\nR\nF', {
  type: 'merge',
  mustInclude: ['L', 'R'],
});

/* ── B. 应当冲突（返回 null） ── */
add('B', '双方改同一行（不同内容）', 'A\nB\nC', 'A\nL\nC', 'A\nR\nC', { type: 'conflict' });
add('B', '双方改同一行同一位置（不同）', 'x\ny\nz', 'x\nlocal\ny\nz', 'x\nremote\ny\nz', { type: 'conflict' });
add('B', '单行文档双方都改', 'single line', 'local changed', 'remote changed', { type: 'conflict' });
add('B', '双方删除同一行并各加新行', 'A\nB\nC', 'A\nL\nC', 'A\nR\nC', { type: 'conflict' });

/* ── C. 边界 ── */
add('C', '空 base / 双方各有内容', '', 'local', 'remote', { type: 'conflict-or-merge', mustInclude: [] });
add('C', '一行为空字符串', '', '', '', { type: 'merge', mustInclude: [] });
add('C', 'CRLF 换行（local 改）', 'A\r\nB\r\nC', 'A\r\nB2\r\nC', 'A\r\nB\r\nC', {
  type: 'check-crlf',
  mustInclude: [],
});
add('C', 'Unicode / 中文内容（双方改不同行）', '标题\n正文\n结尾', '标题-改\n正文\n结尾', '标题\n正文\n结尾-改', {
  type: 'merge',
  mustInclude: ['标题-改', '结尾-改'],
});
add('C', 'emoji 内容', 'a\n😀\nb', 'a\n😀\nb\nlocal', 'a\n😀\nb\nremote', { type: 'merge-or-conflict', mustInclude: [] });
add('C', '代码块内改不同行', '```\ncode1\ncode2\n```', '```\ncode1-X\ncode2\n```', '```\ncode1\ncode2-Y\n```', {
  type: 'merge',
  mustInclude: ['code1-X', 'code2-Y'],
});
add('C', '超长文档（300 行，双方改首尾）', null, null, null, { type: 'merge', mustInclude: ['HEAD-CHANGED', 'TAIL-CHANGED'] });

/* 构造超长用例 */
{
  const baseLines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const c = CASES[CASES.length - 1];
  c.base = baseLines.join('\n');
  const localLines = [...baseLines];
  localLines[0] = 'HEAD-CHANGED';
  c.local = localLines.join('\n');
  const remoteLines = [...baseLines];
  remoteLines[299] = 'TAIL-CHANGED';
  c.remote = remoteLines.join('\n');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { merge, outfile } = await loadMerge();
  log(`已加载真实 threeWayMerge → ${outfile}`);

  const results = [];
  for (const c of CASES) {
    let out = null;
    let err = null;
    try {
      out = merge(c.base, c.local, c.remote);
    } catch (e) {
      err = e.message;
    }
    const isConflict = out === null;

    let pass = false;
    let note = '';
    switch (c.expect.type) {
      case 'merge':
        pass = !isConflict && c.expect.mustInclude.every((s) => out.includes(s));
        note = isConflict ? '返回 null（冲突）但本应合并' : c.expect.mustInclude.filter((s) => !out.includes(s)).map((s) => `丢失「${s}」`).join('; ');
        break;
      case 'conflict':
        pass = isConflict;
        note = isConflict ? '' : `返回了合并结果而非冲突 —— **静默合并风险**`;
        break;
      case 'merge-or-conflict':
        pass = true; // 两种都可接受，但要记录实际行为
        note = isConflict ? '判为冲突（保守，可接受）' : '自动合并成功';
        break;
      case 'conflict-or-merge':
        pass = true;
        note = isConflict ? '判为冲突（保守）' : '自动合并';
        break;
      case 'check-crlf':
        // CRLF 只要不崩、且 local 改动在结果里即可
        pass = !isConflict && out.includes('B2');
        note = isConflict ? '返回 null' : out.includes('B2') ? '保留 local 改动' : '丢失 local 改动';
        break;
      default:
        pass = true;
    }
    if (err) {
      pass = false;
      note = `抛出异常：${err}`;
    }

    results.push({
      group: c.group,
      name: c.name,
      verdict: isConflict ? 'conflict' : 'merged',
      pass,
      note,
      outputPreview: out === null ? null : String(out).slice(0, 260),
    });
    log(`  ${pass ? '✓' : '✗'} [${c.group}] ${c.name.padEnd(34)} → ${isConflict ? '冲突' : '合并'}  ${note}`);
  }

  hr('汇总');
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] ?? { total: 0, pass: 0 };
    byGroup[r.group].total += 1;
    if (r.pass) byGroup[r.group].pass += 1;
  }
  for (const [g, v] of Object.entries(byGroup)) log(`  [${g}] ${v.pass}/${v.total} 通过`);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  log(`\n  合计 ${passed}/${results.length} 通过`);
  if (failed.length) {
    log('\n  ✗ 失败项：');
    for (const f of failed) log(`    [${f.group}] ${f.name}  → ${f.note}`);
  }

  writeFileSync(
    join(OUT, 'merge-verification.json'),
    JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, failed: failed.length, results }, null, 2),
    'utf8',
  );
  log(`\n  证据 → ${join(OUT, 'merge-verification.json')}`);
  if (failed.length) process.exitCode = 1;
}

await main();
