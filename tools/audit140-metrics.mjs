#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · 量化指标采集脚本（只读）。
 *
 * 一次采集全部可量化指标，避免在报告里出现「大约/大概」这类模糊表述。
 * 所有数字都来自本脚本实测输出，报告直接引用。
 *
 * 用法：
 *   node tools/audit140-metrics.mjs            # 全量
 *   node tools/audit140-metrics.mjs --json     # 仅 JSON（便于二次处理）
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO, 'docs/AUDIT-140');
const JSON_ONLY = process.argv.includes('--json');

const log = (...a) => {
  if (!JSON_ONLY) console.log(...a);
};
const hr = (t) => log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
const rel = (p) => relative(REPO, p).replace(/\\/g, '/');

/** 遍历目录，跳过依赖与产物 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-base21', 'dist-t117', 'dist-t117b',
  'dist-artifacts', '.gradle', 'build', 'releases', '.shots', 'plugin-market',
]);

function walk(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(REPO);
const srcFiles = allFiles.filter((p) => /\.(ts|vue|js|mjs|cjs)$/.test(p));
const textCache = new Map();
function readText(p) {
  if (textCache.has(p)) return textCache.get(p);
  let s = '';
  try {
    s = readFileSync(p, 'utf8');
  } catch {
    s = '';
  }
  textCache.set(p, s);
  return s;
}
const lineCount = (p) => readText(p).split(/\r?\n/).length;
const kb = (p) => Math.round((statSync(p).size / 1024) * 10) / 10;

const report = { at: new Date().toISOString(), version: '' };
try {
  report.version = JSON.parse(readText(join(REPO, 'package.json'))).version;
} catch {
  /* ignore */
}

/* ------------------------------------------------------------------ */
/* 1. 文件体量                                                          */
/* ------------------------------------------------------------------ */

hr('1. 文件体量 TOP（源码，排除产物）');

const webSrc = allFiles.filter((p) => p.includes(join('apps', 'web', 'src')) && /\.(ts|vue)$/.test(p));
const coreSrc = allFiles.filter((p) => p.includes(join('packages', 'core', 'src')) && /\.(ts)$/.test(p));
const apiSrc = allFiles.filter((p) => p.includes(join('services', 'api', 'src')) && /\.(js)$/.test(p));

function topBy(files, n = 15) {
  return files
    .map((p) => ({ path: rel(p), kb: kb(p), lines: lineCount(p) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, n);
}

report.topWeb = topBy(webSrc, 15);
report.topCore = topBy(coreSrc, 10);
report.topApi = topBy(apiSrc, 12);

for (const [name, list] of [
  ['前端 apps/web/src', report.topWeb],
  ['核心 packages/core/src', report.topCore],
  ['后端 services/api/src', report.topApi],
]) {
  log(`\n[${name}] 共 ${name.startsWith('前端') ? webSrc.length : name.startsWith('核心') ? coreSrc.length : apiSrc.length} 个文件`);
  for (const f of list) log(`  ${String(f.kb).padStart(7)} KB  ${String(f.lines).padStart(5)} 行  ${f.path}`);
}

// 前端总行数占比
const webTotalLines = webSrc.reduce((s, p) => s + lineCount(p), 0);
const webTotalKb = webSrc.reduce((s, p) => s + kb(p), 0);
const top3 = report.topWeb.slice(0, 3);
const top3Kb = top3.reduce((s, f) => s + f.kb, 0);
const top3Lines = top3.reduce((s, f) => s + f.lines, 0);
report.webTotals = {
  files: webSrc.length,
  kb: Math.round(webTotalKb),
  lines: webTotalLines,
  top3Kb,
  top3Lines,
  top3KbPct: Math.round((top3Kb / webTotalKb) * 1000) / 10,
  top3LinesPct: Math.round((top3Lines / webTotalLines) * 1000) / 10,
};
log(
  `\n  前端源码合计 ${Math.round(webTotalKb)} KB / ${webTotalLines} 行；` +
    `TOP3 占 ${top3Kb} KB (${report.webTotals.top3KbPct}%) / ${top3Lines} 行 (${report.webTotals.top3LinesPct}%)`,
);

/* ------------------------------------------------------------------ */
/* 2. stores 规模与职责                                                */
/* ------------------------------------------------------------------ */

hr('2. 状态管理 stores 规模');
const storeFiles = allFiles.filter((p) => /apps[\\/]web[\\/]src[\\/]stores[\\/][^\\/]+\.ts$/.test(p));
report.stores = storeFiles
  .map((p) => {
    const t = readText(p);
    const exported = (t.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm) ?? []).length;
    const returnKeys = (() => {
      // 取 defineStore 返回对象里的键数量（近似度量「对外 API 面」）
      const m = /\n\s*return\s*\{([\s\S]*?)\n\s*\};?\s*\n/.exec(t);
      if (!m) return null;
      return (m[1].match(/^\s{4}\w+,?\s*$/gm) ?? []).length;
    })();
    return { path: rel(p), kb: kb(p), lines: lineCount(p), functions: exported, returnKeys };
  })
  .sort((a, b) => b.kb - a.kb);
for (const s of report.stores) {
  log(`  ${String(s.kb).padStart(7)} KB ${String(s.lines).padStart(5)} 行  fn=${String(s.functions).padStart(3)}  API键=${s.returnKeys ?? '?'}  ${s.path}`);
}

/* ------------------------------------------------------------------ */
/* 3. 类型安全                                                          */
/* ------------------------------------------------------------------ */

hr('3. 类型安全统计（any / @ts-ignore / as any）');

const TYPE_PATTERNS = [
  { id: 'as-any', re: /\bas\s+any\b/g, label: 'as any' },
  { id: 'ts-ignore', re: /@ts-ignore/g, label: '@ts-ignore' },
  { id: 'ts-expect-error', re: /@ts-expect-error/g, label: '@ts-expect-error' },
  { id: 'any-annotation', re: /:\s*any\b/g, label: ': any 注解' },
  { id: 'any-generic', re: /<any>|any\[\]/g, label: '<any> / any[]' },
];

const typeStats = { totals: {}, byFile: [] };
for (const pat of TYPE_PATTERNS) typeStats.totals[pat.id] = 0;

const typeScanTargets = [...webSrc, ...coreSrc];
for (const p of typeScanTargets) {
  const t = readText(p);
  const per = {};
  let sum = 0;
  for (const pat of TYPE_PATTERNS) {
    const n = (t.match(pat.re) ?? []).length;
    if (n) {
      per[pat.id] = n;
      sum += n;
      typeStats.totals[pat.id] += n;
    }
  }
  if (sum) typeStats.byFile.push({ path: rel(p), total: sum, ...per });
}
typeStats.byFile.sort((a, b) => b.total - a.total);
report.types = typeStats;

for (const pat of TYPE_PATTERNS) log(`  ${pat.label.padEnd(20)} ${typeStats.totals[pat.id]}`);
log(`\n  分布 TOP 10（共 ${typeStats.byFile.length} 个文件命中）：`);
for (const f of typeStats.byFile.slice(0, 10)) {
  const detail = Object.entries(f)
    .filter(([k]) => !['path', 'total'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  log(`    ${String(f.total).padStart(4)}  ${f.path}  (${detail})`);
}

/* ------------------------------------------------------------------ */
/* 4. 死代码检测（未被任何文件 import 的源文件）                        */
/* ------------------------------------------------------------------ */

hr('4. 死代码检测：全仓无 import 的源文件');

/** 收集所有「被 import / 动态 import 引用过的路径」 */
const importTargets = new Set();
const importSyntaxRe = [
  /from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

for (const p of srcFiles) {
  const t = readText(p);
  for (const re of importSyntaxRe) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) importTargets.add(m[1]);
  }
}

/** 把 import 说明符解析成候选文件名（同时支持相对路径与 @/ 别名） */
function matchesImport(filePath, spec) {
  const base = filePath.split(/[\\/]/).pop();
  const noExt = base.replace(/\.(ts|vue|js|mjs|cjs)$/, '');
  if (spec.endsWith(`/${noExt}`) || spec === noExt) return true;
  if (spec.endsWith(`/${base}`) || spec === base) return true;
  // '@/components/x/Y.vue' / './Y' / '../Y'
  return false;
}

const deadCandidates = [];
for (const p of srcFiles) {
  const r = rel(p);
  // 只检查「有导出」的模块（脚本类 tool 与入口除外）
  const base = p.split(/[\\/]/).pop();
  if (/\.(mjs|cjs)$/.test(base)) continue;
  if (/\/(main|index|vite-env|env)\.(ts|js)$/.test(r)) continue;
  if (r.includes('__tests__') || /\.test\.ts$/.test(r) || /\.spec\./.test(r)) continue;
  if (r.startsWith('tools/')) continue;

  const t = readText(p);
  const hasExport = /^\s*export\s/m.test(t);
  if (!hasExport) continue;

  const noExt = base.replace(/\.(ts|vue|js)$/, '');
  let referenced = false;
  for (const spec of importTargets) {
    if (matchesImport(p, spec)) {
      referenced = true;
      break;
    }
  }
  if (!referenced) deadCandidates.push({ path: r, kb: kb(p), lines: lineCount(p) });
}

deadCandidates.sort((a, b) => b.kb - a.kb);
report.deadCandidates = deadCandidates;
log(`  候选 ${deadCandidates.length} 个（需人工复核：可能经动态注册 / 路由懒加载引用）`);
for (const d of deadCandidates) log(`    ${String(d.kb).padStart(7)} KB ${String(d.lines).padStart(5)} 行  ${d.path}`);

/* ------------------------------------------------------------------ */
/* 5. 测试覆盖                                                          */
/* ------------------------------------------------------------------ */

hr('5. 测试文件与被测模块');
const testFiles = allFiles.filter((p) => /__tests__[\\/].*\.test\.ts$/.test(p));
report.tests = testFiles.map((p) => ({ path: rel(p), kb: kb(p), lines: lineCount(p), cases: (readText(p).match(/\b(it|test)\s*\(/g) ?? []).length }));
for (const t of report.tests) log(`  ${String(t.cases).padStart(3)} 用例  ${String(t.lines).padStart(5)} 行  ${t.path}`);
report.testTotals = {
  files: report.tests.length,
  cases: report.tests.reduce((s, t) => s + t.cases, 0),
};

/* 被测模块 vs 全量模块 —— 找出「零测试覆盖」的核心模块 */
const testedNames = new Set(report.tests.map((t) => t.path.split('/').pop().replace('.test.ts', '')));
const coreModules = coreSrc.filter((p) => !p.includes('__tests__')).map((p) => ({ path: rel(p), name: p.split(/[\\/]/).pop().replace(/\.ts$/, ''), lines: lineCount(p) }));
report.coreModules = coreModules;
report.untestedCore = coreModules.filter((m) => !testedNames.has(m.name) && m.lines > 100).sort((a, b) => b.lines - a.lines);
log(`\n  core 源码模块 ${coreModules.length} 个，零测试覆盖且 >100 行的有 ${report.untestedCore.length} 个：`);
for (const m of report.untestedCore.slice(0, 15)) log(`    ${String(m.lines).padStart(5)} 行  ${m.path}`);

/* ------------------------------------------------------------------ */
/* 6. 依赖方向 / 循环依赖                                              */
/* ------------------------------------------------------------------ */

hr('6. 包依赖方向');
const pkgs = [
  ['@neomd/shared', join(REPO, 'packages/shared')],
  ['@neomd/core', join(REPO, 'packages/core')],
  ['@neomd/ui', join(REPO, 'packages/ui')],
  ['@neomd/web', join(REPO, 'apps/web')],
];
report.deps = {};
for (const [name, dir] of pkgs) {
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) continue;
  try {
    const j = JSON.parse(readText(pj));
    const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
    const internal = Object.keys(deps).filter((d) => d.startsWith('@neomd/'));
    report.deps[name] = internal;
    log(`  ${name.padEnd(16)} → ${internal.length ? internal.join(', ') : '（无内部依赖）'}`);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 7. 后端路由与鉴权点                                                 */
/* ------------------------------------------------------------------ */

hr('7. 后端路由注册与鉴权');
const routeFiles = apiSrc.filter((p) => /routes[\\/].*\.js$/.test(p));
report.routes = [];
for (const p of routeFiles) {
  const t = readText(p);
  const regs = (t.match(/\bapp\.(get|post|put|patch|delete|head)\s*\(/g) ?? []).length;
  const withAuth = (t.match(/preHandler\s*:\s*\[[^\]]*authenticate/g) ?? []).length;
  const withAdmin = (t.match(/adminOnly|requireAdmin|adminGuard/g) ?? []).length;
  report.routes.push({ path: rel(p), kb: kb(p), lines: lineCount(p), registrations: regs, withAuth, withAdmin });
}
for (const r of report.routes.sort((a, b) => b.lines - a.lines)) {
  log(`  ${String(r.lines).padStart(5)} 行  注册=${String(r.registrations).padStart(3)}  authenticate=${String(r.withAuth).padStart(3)}  adminGuard=${String(r.withAdmin).padStart(3)}  ${r.path}`);
}

/* ------------------------------------------------------------------ */
/* 8. 凭据泄露扫描（管理员密码 6655 / AK / SK）                         */
/* ------------------------------------------------------------------ */

hr('8. 凭据泄露扫描');
const SECRET_PATTERNS = [
  { id: 'admin-pass', re: /\b6655\b/g, label: '管理员密码 6655' },
  { id: 'oss-ak', re: /\bLTAI[0-9A-Za-z]{12,}\b/g, label: '疑似阿里云 AccessKeyId' },
  { id: 'jwt-secret', re: /JWT_SECRET\s*=\s*['"]?[^\s'"]{8,}/g, label: 'JWT_SECRET 明文' },
  { id: 'generic-pass', re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, label: 'password= 明文' },
];
report.secrets = {};
for (const pat of SECRET_PATTERNS) {
  const hits = [];
  for (const p of allFiles) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|zip|apk|exe|jar|class|so|dll|woff2?|ttf|map|sqlite|db)$/i.test(p)) continue;
    const t = readText(p);
    if (!t) continue;
    pat.re.lastIndex = 0;
    const m = t.match(pat.re);
    if (m) hits.push({ path: rel(p), count: m.length });
  }
  hits.sort((a, b) => b.count - a.count);
  report.secrets[pat.id] = { label: pat.label, files: hits.length, occurrences: hits.reduce((s, h) => s + h.count, 0), detail: hits };
  log(`  ${pat.label.padEnd(22)} 命中 ${String(hits.length).padStart(3)} 文件 / ${String(hits.reduce((s, h) => s + h.count, 0)).padStart(4)} 次`);
}

mkdirSync(OUT_DIR, { recursive: true });
const outJson = join(OUT_DIR, 'metrics.json');
writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
hr('输出');
log(`  ${outJson}`);
