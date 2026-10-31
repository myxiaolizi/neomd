#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **adminOnly 覆盖度逐个核对**（只读，静态分析）。
 *
 * lead 的要求：「逐个核对 admin.js 的每条路由是否都挂了 adminOnly，漏一个就是越权」。
 *
 * 做法：
 *  1. 解析 `admin.js` 里每一次 `app.<method>(` 注册；
 *  2. 取该注册的完整参数区间（到下一个 `app.<method>(` 或文件尾）；
 *  3. 在该区间内查找 `preHandler` 数组里是否包含鉴权/管理员守卫；
 *  4. 输出「无守卫」的路由清单 —— 这些就是潜在越权点，需人工确认。
 *
 * 同时核对服务端是否在**插件级**统一挂了守卫（若 `app.register(adminRoutes, { prefix })`
 * 时统一加了 preHandler，则单条路由不必重复挂）——这一点必须先查 server.js。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/AUDIT-140');
const ADMIN = join(REPO, 'services/api/src/routes/admin.js');
const SERVER = join(REPO, 'services/api/src/server.js');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

const adminSrc = readFileSync(ADMIN, 'utf8');
const serverSrc = readFileSync(SERVER, 'utf8');

const report = { at: new Date().toISOString() };

/* ------------------------------------------------------------------ */
/* 0. 先看守卫是否在插件级统一挂载                                       */
/* ------------------------------------------------------------------ */

hr('0. 守卫是否在插件级统一挂载（决定「单条路由不挂」是否是问题）');

/** 找 server.js 里注册 adminRoutes 的地方 */
const regMatches = [...serverSrc.matchAll(/register\s*\(\s*adminRoutes\s*([\s\S]{0,220}?)\)\s*;/g)];
report.pluginRegistration = regMatches.map((m) => m[0].replace(/\s+/g, ' ').slice(0, 260));
if (regMatches.length) {
  for (const m of regMatches) log(`  register(adminRoutes ...) → ${m[0].replace(/\s+/g, ' ').slice(0, 220)}`);
} else {
  log('  未找到 register(adminRoutes ...) 调用');
}

/** admin.js 内部是否用 addHook 统一挂 preHandler */
const hookMatches = [...adminSrc.matchAll(/app\.addHook\s*\(\s*['"]preHandler['"]/g)];
log(`  admin.js 内部 addHook('preHandler') 出现 ${hookMatches.length} 次`);
if (hookMatches.length) {
  const i = adminSrc.indexOf("addHook('preHandler'");
  const j = i >= 0 ? i : adminSrc.indexOf('addHook("preHandler"');
  log(`  片段：${adminSrc.slice(j, j + 400).replace(/\s+/g, ' ')}`);
}
report.adminAddHookPreHandler = hookMatches.length;

/** 全局 decorate / 全局 preHandler */
const globalHook = [...serverSrc.matchAll(/addHook\s*\(\s*['"]preHandler['"]\s*,\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
report.globalPreHandlers = globalHook;
log(`  server.js 全局 preHandler: ${globalHook.length ? globalHook.join(', ') : '（无）'}`);

/* ------------------------------------------------------------------ */
/* 1. 逐个解析 admin.js 的路由注册                                       */
/* ------------------------------------------------------------------ */

hr('1. 逐条核对 admin.js 路由的守卫情况');

/**
 * 用正则扫描所有 `app.<method>('path', ...)` 的起点，
 * 并取到下一个注册起点或文件尾作为该路由的"参数区间"。
 */
const regRe = /\bapp\.(get|post|put|patch|delete|head)\s*\(\s*$/gm;
const starts = [];
{
  const re = /\bapp\.(get|post|put|patch|delete|head)\s*\(/g;
  let m;
  while ((m = re.exec(adminSrc))) starts.push({ index: m.index, method: m[1] });
}
report.routeCount = starts.length;

/** 守卫标识：任一出现即认为该路由有鉴权 */
const GUARD_PATTERNS = [
  { id: 'adminOnly', re: /\badminOnly\b/ },
  { id: 'authenticate', re: /\bauthenticate\b/ },
  { id: 'requireAdmin', re: /\brequireAdmin\b/ },
  { id: 'adminGuard', re: /\badminGuard\b/ },
  { id: 'preHandler', re: /preHandler\s*:/ },
];

const routes = [];
for (let i = 0; i < starts.length; i += 1) {
  const s = starts[i];
  const end = i + 1 < starts.length ? starts[i + 1].index : adminSrc.length;
  const chunk = adminSrc.slice(s.index, end);
  // 路由路径：取注册后的第一个字符串字面量
  const pm = /\(\s*['"`]([^'"`]+)['"`]/.exec(adminSrc.slice(s.index, s.index + 300));
  const path = pm ? pm[1] : '(无法解析)';
  const guards = GUARD_PATTERNS.filter((g) => g.re.test(chunk)).map((g) => g.id);
  // 行号
  const line = adminSrc.slice(0, s.index).split(/\r?\n/).length;
  routes.push({ line, method: s.method.toUpperCase(), path, guards, guarded: guards.length > 0 });
}
report.routes = routes;

const unguarded = routes.filter((r) => !r.guarded);
log(`  共解析到 ${routes.length} 条路由注册`);
log(`  含守卫的 ${routes.length - unguarded.length} 条，**无守卫的 ${unguarded.length} 条**`);

if (unguarded.length) {
  log('\n  ⚠ 无任何守卫的路由（需人工确认是否依赖插件级钩子）：');
  for (const r of unguarded) log(`     :${String(r.line).padStart(5)}  ${r.method.padEnd(6)} ${r.path}`);
} else {
  log('\n  ✓ 所有路由都显式挂了守卫');
}

/* ------------------------------------------------------------------ */
/* 2. 守卫实现本身的正确性                                             */
/* ------------------------------------------------------------------ */

hr('2. 守卫实现（adminOnly）的实际逻辑');

const idx = adminSrc.indexOf('adminOnly');
if (idx >= 0) {
  // 往前找函数定义
  const before = adminSrc.slice(Math.max(0, idx - 1200), idx + 900);
  const defIdx = before.lastIndexOf('function adminOnly');
  const snippet = defIdx >= 0 ? before.slice(defIdx, defIdx + 1200) : before.slice(-1200);
  log(snippet);
  report.adminOnlySnippet = snippet;
} else {
  log('  admin.js 里没有 adminOnly 定义，可能来自 middleware/auth.js');
  const authSrc = readFileSync(join(REPO, 'services/api/src/middleware/auth.js'), 'utf8');
  const ai = authSrc.indexOf('adminOnly');
  if (ai >= 0) {
    const from = Math.max(0, ai - 200);
    log(authSrc.slice(from, ai + 900));
    report.adminOnlySnippet = authSrc.slice(from, ai + 900);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 汇总                                                             */
/* ------------------------------------------------------------------ */

hr('3. 汇总');
const byMethod = {};
for (const r of routes) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
log(`  按方法分布：${Object.entries(byMethod).map(([k, v]) => `${k}=${v}`).join('  ')}`);
log(`  插件级 addHook('preHandler') 次数：${report.adminAddHookPreHandler}`);
log(`  无守卫路由数：${unguarded.length}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'adminonly-coverage.json'), JSON.stringify(report, null, 2), 'utf8');
log(`\n  证据 → ${join(OUT, 'adminonly-coverage.json')}`);
