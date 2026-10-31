#!/usr/bin/env node
/**
 * A3 审计 · 核实 `sql.js` / `metadata-store.ts` 是否真的「无调用方」（静态 import 分析）。
 *
 * 为什么需要专门核实：
 *   我在报告里写了「sql.js 不必要，唯一使用者 metadata-store.ts 只被 index.ts 导出、无调用方」，
 *   lead 要求确认这是**静态 import 分析**得出的，并写清「移除后需要验证哪些功能仍正常」。
 *
 * 分析方法（三层，逐层缩小）：
 *   1. **符号引用**：全仓搜 `MetadataStore` / `addVersion` / `pruneVersions` 等导出符号的使用点；
 *   2. **模块路径**：全仓搜 `metadata-store` 的 import 路径；
 *   3. **运行时可达性**：从 `apps/web/src/main.ts` 出发，沿着 import 图能否到达该模块。
 *
 * 同时输出「移除后必须回归验证的功能清单」（基于该模块的导出能力反推）。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-base21', 'dist-t117', 'dist-t117b', 'dist-artifacts', '.gradle', 'build', 'releases', '.shots', 'plugin-market', 'android']);
function walk(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const all = walk(REPO);
const srcFiles = all.filter((p) => /\.(ts|vue|js|mjs)$/.test(p));
const rel = (p) => relative(REPO, p).replace(/\\/g, '/');
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

const TARGET_MODULE = join(REPO, 'packages/core/src/db/metadata-store.ts');
const relTarget = rel(TARGET_MODULE);

hr('0. 目标模块的导出符号');
const targetSrc = read(TARGET_MODULE);
const exportSymbols = [
  ...targetSrc.matchAll(/^export\s+(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/gm),
].map((m) => m[1]);
log(`  ${relTarget}`);
log(`  行数 ${targetSrc.split(/\r?\n/).length}，导出符号 ${exportSymbols.length} 个：`);
log(`    ${exportSymbols.join(', ')}`);

hr('1. 符号引用分析：全仓谁真正使用了这些符号');
/*
 * 必须排除**审计脚本自身**：本文件为了分析而提到 `MetadataStore` 字符串，
 * 若不排除会把自己的检测文本当成「真实使用点」，得出「有使用」的错误结论。
 * 这是静态分析里的经典自指干扰。
 */
const SELF = rel(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '/'));
const symbolHits = {};
for (const sym of exportSymbols) {
  const hits = [];
  for (const p of srcFiles) {
    if (p === TARGET_MODULE) continue;
    const r = rel(p);
    // 跳过审计脚本自身
    if (r.startsWith('tools/audit140-')) continue;
    // 跳过 barrel 文件（纯粹的 re-export，不算真实使用）
    const isBarrel = /packages\/core\/src\/index\.ts$/.test(r) || /packages\/shared\/src\/index\.ts$/.test(r);
    const t = read(p);
    const re = new RegExp(`\\b${sym.replace(/[$]/g, '\\$')}\\b`, 'g');
    const count = (t.match(re) ?? []).length;
    if (count) hits.push({ file: r, count, isBarrel });
  }
  symbolHits[sym] = hits;
}
let anyRealUse = false;
for (const [sym, hits] of Object.entries(symbolHits)) {
  const real = hits.filter((h) => !h.isBarrel);
  if (real.length) anyRealUse = true;
  const label = real.length ? '**真实使用**' : hits.length ? '仅 barrel 导出' : '无引用';
  log(`  ${sym.padEnd(28)} → ${label}${real.length ? '  ' + real.map((h) => h.file).join(', ') : ''}`);
}

hr('2. 模块路径引用分析');
const pathHits = [];
for (const p of srcFiles) {
  if (p === TARGET_MODULE) continue;
  const t = read(p);
  if (/metadata-store/.test(t)) {
    const lines = t.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /metadata-store/.test(l));
    pathHits.push({ file: rel(p), lines: lines.map(([n, l]) => ({ line: n, code: l.trim().slice(0, 120) })) });
  }
}
for (const h of pathHits) {
  log(`  ${h.file}`);
  for (const l of h.lines) log(`     :${l.line}  ${l.code}`);
}
if (!pathHits.length) log('  无任何文件引用 metadata-store 路径');

hr('3. 运行时可达性：从 apps/web/src/main.ts 出发能否到达');
/*
 * 简易 import 图遍历：从入口出发，解析相对路径与 @/ 别名，追踪能否到达目标模块。
 * 这不是完整的 bundler 解析，但对「能否到达」这个判定足够。
 */
const ENTRY = join(REPO, 'apps/web/src/main.ts');
const visited = new Set();
const queue = [ENTRY];
const edges = new Map();
function resolveSpec(fromFile, spec) {
  const cands = [];
  if (spec.startsWith('@/')) {
    cands.push(join(REPO, 'apps/web/src', spec.slice(2)));
  } else if (spec.startsWith('.')) {
    cands.push(join(dirname(fromFile), spec));
  } else if (spec === '@neomd/core') {
    cands.push(join(REPO, 'packages/core/src/index.ts'));
  } else if (spec.startsWith('@neomd/')) {
    cands.push(join(REPO, 'packages', spec.slice('@neomd/'.length), 'src/index.ts'));
  } else {
    return [];
  }
  const out = [];
  for (const c of cands) {
    for (const ext of ['', '.ts', '.vue', '.js', '/index.ts', '/index.js']) {
      const p = c + ext;
      try {
        readFileSync(p);
        out.push(p);
        break;
      } catch {
        /* next */
      }
    }
  }
  return out;
}
while (queue.length) {
  const cur = queue.shift();
  if (visited.has(cur)) continue;
  visited.add(cur);
  const t = read(cur);
  const specs = [
    ...t.matchAll(/from\s+['"]([^'"]+)['"]/g),
    ...t.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  const nexts = [];
  for (const s of specs) nexts.push(...resolveSpec(cur, s));
  edges.set(cur, nexts);
  for (const n of nexts) if (!visited.has(n)) queue.push(n);
}
const reachable = visited.has(TARGET_MODULE);
log(`  从 ${rel(ENTRY)} 出发可达文件数：${visited.size}`);
log(`  能否到达 ${relTarget}：${reachable ? '**能**（仍在包内）' : '**不能**'}`);
/*
 * 注意：即使「能到达」，也可能只是因为 packages/core/src/index.ts 的 `export *`
 * 把整个模块拖进了依赖图。要看它是否**有副作用**（顶层执行代码）。
 */
const hasSideEffects = /^(?!\s*(\/\/|\*|\/\*)).*\b(initSqlJs|locateFile|new SQL\.|await\s)/m.test(targetSrc);
log(`  该模块是否有顶层副作用（会拖入 wasm）：${hasSideEffects ? '是/需确认' : '否（只有 class 定义）'}`);

hr('4. 结论');
const realSymbolUses = Object.entries(symbolHits).filter(([, hits]) => hits.some((h) => !h.isBarrel));
let verdict;
if (realSymbolUses.length === 0) {
  verdict = 'DEAD';
  log('  ✓ **确认为死代码**：所有导出符号仅被 barrel（index.ts）re-export，无任何真实使用点');
  log('    → sql.js 仅为该模块的 import 而存在，属于**可移除的未使用依赖**');
} else {
  verdict = 'USED';
  log('  ✗ **有真实使用**，不能直接移除：');
  for (const [sym, hits] of realSymbolUses) {
    log(`     ${sym} ← ${hits.filter((h) => !h.isBarrel).map((h) => h.file).join(', ')}`);
  }
}

hr('5. 移除后必须回归验证的功能清单（基于该模块导出能力反推）');
/*
 * 从 metadata-store.ts 的导出接口反推它「本应提供什么能力」，
 * 这样移除/懒加载后知道该验证哪些用户可见功能。
 */
const capabilities = [];
if (/versions\(|addVersion|pruneVersions/.test(targetSrc)) capabilities.push('历史版本列表与裁剪（版本历史面板）');
if (/search|Search/i.test(targetSrc)) capabilities.push('全文搜索');
if (/docs|documents|listDocs|insertDoc/.test(targetSrc)) capabilities.push('文档元数据列表');
if (/initSqlJs|SQL\.Database/.test(targetSrc)) capabilities.push('WASM SQLite 初始化（构建产物体积）');
for (const c of capabilities) log(`  · ${c}`);

log('\n  建议的验证步骤：');
log('    1. 移除 dependencies 里的 sql.js → pnpm install');
log('    2. pnpm --filter @neomd/web build，对比产物体积（预期减少约 1MB+ wasm）');
log('    3. 手工回归：打开仓库 → 文档列表正常 → 搜索能出结果 → 版本历史能列出并回滚');
log('    4. npx vitest run 全绿（当前 295 用例）');
log('    5. vue-tsc 0 错误');

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'sqljs-necessity-check.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      module: relTarget,
      lines: targetSrc.split(/\r?\n/).length,
      exportSymbols,
      symbolHits,
      pathHits,
      reachableFromEntry: reachable,
      reachableFileCount: visited.size,
      hasSideEffects,
      verdict,
      realUses: realSymbolUses.map(([sym, hits]) => ({ symbol: sym, files: hits.filter((h) => !h.isBarrel).map((h) => h.file) })),
      capabilitiesToVerify: capabilities,
    },
    null,
    2,
  ),
  'utf8',
);
log(`\n  证据 → ${join(OUT, 'sqljs-necessity-check.json')}`);
