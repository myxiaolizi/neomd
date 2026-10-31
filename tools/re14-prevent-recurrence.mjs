#!/usr/bin/env node
/**
 * 1.4.0 需求10 **防复发验证**：模拟「新设备首次登录」，断言不会新增重复仓库条目。
 *
 * ## 验证什么
 *
 * `lib/vault-scope.js` 的 `assertVaultUsable()` 已加三层收敛：
 *  a) 同 name 复用（有意义的名字 → 已有同名 active 仓库则复用，不新增）
 *  b) 来源标记（新建写 auto_registered=1）
 *  c) 上限兜底（≥20 个 active 时拒绝）
 *
 * 本脚本直接**调用真实的服务端函数**（不是 HTTP，避免污染生产数据），
 * 用 mock 的 `user_vaults` 行验证这三层逻辑，不写生产库。
 *
 * 只用内存态模拟：把 `assertVaultUsable` 依赖的 DB 调用替换掉。
 *
 * 用法：node tools/re14-prevent-recurrence.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/shots-140');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n=== ${t} ===`);

/**
 * 用 esbuild 把 `vault-scope.js` 单独 bundle 成可在 Node 里 import 的模块。
 *
 * 难点：它 `import { execute, queryOne } from '../db/pool.js'`，直接加载会建真连接池。
 * 解决：用 esbuild 的 `alias` 把 `../db/pool.js` 指向一个**内存实现的桩文件**，
 * 这样 bundle 出来的模块里 DB 操作全是内存态，绝不碰生产库。
 */
/**
 * 加载 `assertVaultUsable` 的**真实实现**，但用内存桩替换 DB 与 HttpError。
 *
 * ## 为什么用「源码文本改写」而不是 esbuild bundle
 *
 * 试过三条更"正规"的路，都因为依赖链太重而失败（每一步都记在下面，避免后人重踩）：
 *  1. 直接 `import('vault-scope.js')` → 会拉起真实 `db/pool.js` 建 MySQL 连接池；
 *  2. esbuild bundle + alias 桩 pool → esbuild 的 alias **不接受绝对路径**（Invalid alias name）；
 *  3. 改用 onResolve 插件桩 pool → 通过，但传递引入 `config.js` 需要 `JWT_SECRET` 等环境变量；
 *     再桩 config → `oss.js` 又 import 了 `platformStorage`，桩必须完整复刻它的导出面。
 *
 * 而本测试真正要验证的只有 `assertVaultUsable()` 里的**分支逻辑**
 * （同 name 复用 / auto_registered 标记 / 上限兜底），它只依赖两个东西：
 * `queryOne/execute`（DB）与 `HttpError`（错误）。
 *
 * 因此最稳的做法是：读源码 → 把 import 换成桩 → 写成临时 .mjs → import。
 * 这样跑的仍是**仓库里那份真实的 `assertVaultUsable` 源码**（不是重写一份），
 * 依赖面却收敛到最小，不会有环境变量/传递依赖问题。
 */
async function loadAssertVaultUsable() {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');

  const src = rf(join(REPO, 'services/api/src/lib/vault-scope.js'), 'utf8');

  /*
   * 只截取到 `assertVaultUsable` 与 `isAutoRegisteredShell` 定义结束为止之前的
   * 依赖 import 区，替换成桩；保留函数体原样。
   *
   * 做法：把顶部三条 import 全部换成桩实现，其余内容原样保留。
   */
  let patched = src;
  // 1. DB 桩
  patched = patched.replace(
    /import\s*\{\s*execute,\s*queryOne\s*\}\s*from\s*'\.\.\/db\/pool\.js';/,
    `
const g = globalThis;
g.__RE14_ROWS__ = g.__RE14_ROWS__ ?? [];
g.__RE14_INSERTED__ = g.__RE14_INSERTED__ ?? [];
g.__RE14_UPDATED__ = g.__RE14_UPDATED__ ?? [];

async function query(sql, params = []) {
  const rows = g.__RE14_ROWS__;
  const s = String(sql).replace(/\\s+/g, ' ').trim();
  if (/^SELECT \\* FROM user_vaults WHERE user_id = \\? AND vault_id = \\?/i.test(s)) {
    return rows.filter((r) => r.user_id === params[0] && r.vault_id === params[1]);
  }
  if (/^SELECT \\* FROM user_vaults WHERE user_id = \\? AND name = \\? AND status = 'active'/i.test(s)) {
    return rows.filter((r) => r.user_id === params[0] && r.name === params[1] && (r.status ?? 'active') === 'active');
  }
  if (/^SELECT COUNT\\(\\*\\) AS total FROM user_vaults WHERE user_id = \\? AND status = 'active'/i.test(s)) {
    const n = rows.filter((r) => r.user_id === params[0] && (r.status ?? 'active') === 'active').length;
    return [{ total: n }];
  }
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function execute(sql, params = []) {
  const s = String(sql).replace(/\\s+/g, ' ').trim();
  const rows = g.__RE14_ROWS__;
  if (/^INSERT INTO user_vaults/i.test(s)) {
    const row = {
      user_id: params[0], vault_id: params[1], name: params[2],
      doc_count: 0, bytes: 0, status: 'active',
      last_synced_at: null, auto_registered: 1, auto_registered_at: new Date(),
      updated_at: new Date(),
    };
    if (!rows.some((r) => r.user_id === row.user_id && r.vault_id === row.vault_id)) rows.push(row);
    g.__RE14_INSERTED__.push(row);
    return { affectedRows: 1 };
  }
  if (/^UPDATE user_vaults SET updated_at/i.test(s)) {
    g.__RE14_UPDATED__.push({ user_id: params[0], vault_id: params[1] });
    return { affectedRows: 1 };
  }
  return { affectedRows: 0 };
}
`,
  );
  // 2. HttpError 桩（保留真实形状：statusCode/status + code + message）
  patched = patched.replace(
    /import\s*\{\s*HttpError\s*\}\s*from\s*'\.\/http\.js';/,
    `
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}
`,
  );
  // 3. oss.js → 只用到 PLATFORM_PREFIX
  patched = patched.replace(
    /import\s*\{\s*PLATFORM_PREFIX\s*\}\s*from\s*'\.\/oss\.js';/,
    `const PLATFORM_PREFIX = 'mdadmin/neomd/';`,
  );

  // 校验三条替换都成功（否则说明源码 import 写法变了，必须让人知道）
  const leftovers = [
    /from '\.\.\/db\/pool\.js'/,
    /from '\.\/http\.js'/,
    /from '\.\/oss\.js'/,
  ].filter((re) => re.test(patched));
  if (leftovers.length) {
    throw new Error(`import 替换失败（剩余 ${leftovers.length} 条）：源码 import 写法可能已变更`);
  }

  const out = join(REPO, 'services/api/.re14-vault-scope-patched.mjs');
  wf(out, patched, 'utf8');
  const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
  return { mod, outfile: out };
}

/* ------------------------------------------------------------------ */

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { mod, outfile } = await loadAssertVaultUsable();
  const { assertVaultUsable, isAutoRegisteredShell, MAX_ACTIVE_VAULTS_PER_USER } = mod;
  if (typeof assertVaultUsable !== 'function') throw new Error('加载后没有 assertVaultUsable');
  log(`已加载真实源码（import 已桩化）→ ${outfile}`);

  const USER = 1;
  const g = globalThis;

  hr('场景 1：同 name 复用（堵住「每次新 profile 造一条 Neo MD」）');
  g.__RE14_ROWS__ = [
    { user_id: USER, vault_id: 'vaultREAL', name: 'Neo MD', doc_count: 436, bytes: 100, status: 'active', last_synced_at: new Date() },
  ];
  g.__RE14_INSERTED__ = [];
  const before1 = g.__RE14_ROWS__.length;
  const reused = await assertVaultUsable(USER, 'vaultNEWRANDOM1', 'Neo MD');
  const after1 = g.__RE14_ROWS__.length;
  check('传有意义的名字 → 复用已有同名仓库', reused.vault_id === 'vaultREAL', `返回 vault_id=${reused.vault_id}`);
  check('不新增行', after1 === before1, `${before1} → ${after1}`);
  check('未执行 INSERT', g.__RE14_INSERTED__.length === 0, `INSERT 次数=${g.__RE14_INSERTED__.length}`);

  hr('场景 2：name 为空/等于 vaultId 时**不做**同名复用（避免不同仓库数据互撞）');
  g.__RE14_ROWS__ = [
    { user_id: USER, vault_id: 'vaultOTHER', name: 'vaultOTHER', doc_count: 5, bytes: 10, status: 'active', last_synced_at: null },
  ];
  g.__RE14_INSERTED__ = [];
  const r2 = await assertVaultUsable(USER, 'vaultBRANDNEW2', '');
  check('新建了独立行（name 退化成新 vaultId）', r2.vault_id === 'vaultBRANDNEW2', `返回 vault_id=${r2.vault_id}`);
  check('确实 INSERT 了', g.__RE14_INSERTED__.length === 1);
  check('新行带 auto_registered=1 标记', g.__RE14_INSERTED__[0]?.auto_registered === 1, `auto_registered=${g.__RE14_INSERTED__[0]?.auto_registered}`);

  hr('场景 3：上限兜底（≥20 个 active 时拒绝）');
  g.__RE14_ROWS__ = Array.from({ length: MAX_ACTIVE_VAULTS_PER_USER }, (_, i) => ({
    user_id: USER, vault_id: `vaultFULL${i}`, name: `v${i}`, doc_count: 1, bytes: 1, status: 'active', last_synced_at: null,
  }));
  g.__RE14_INSERTED__ = [];
  let limitErr = null;
  try {
    await assertVaultUsable(USER, 'vaultOVERLIMIT', '');
  } catch (e) {
    limitErr = e;
  }
  check('达到上限时抛错', Boolean(limitErr), limitErr ? `${limitErr.code ?? limitErr.statusCode ?? ''} ${limitErr.message}` : '未抛错');
  check('错误码是 VAULT_LIMIT_REACHED', limitErr?.code === 'VAULT_LIMIT_REACHED', `code=${limitErr?.code}`);
  check('未 INSERT 新行', g.__RE14_INSERTED__.length === 0);

  hr('场景 4：模拟「新设备首次登录」—— 反复以相同名字自动登记');
  g.__RE14_ROWS__ = [];
  g.__RE14_INSERTED__ = [];
  g.__RE14_UPDATED__ = [];
  // 第 1 次：真的新建（这条不走复用分支，因此也不产生 UPDATE）
  await assertVaultUsable(USER, 'vaultDEV1', 'Neo MD');
  const afterFirst = g.__RE14_ROWS__.length;
  // 第 2-5 次：不同设备的随机 vaultId，但同名 → 全部走复用
  for (let i = 2; i <= 5; i += 1) {
    await assertVaultUsable(USER, `vaultDEV${i}`, 'Neo MD');
  }
  check('第 1 次自动登记创建了 1 行', afterFirst === 1, `实际 ${afterFirst} 行`);
  check('5 次自动登记后仍然只有 1 行', g.__RE14_ROWS__.length === 1, `实际 ${g.__RE14_ROWS__.length} 行`);
  check('只 INSERT 过 1 次', g.__RE14_INSERTED__.length === 1, `INSERT 次数=${g.__RE14_INSERTED__.length}`);
  /*
   * 复用的 4 次都会 UPDATE updated_at（第 1 次走新建分支，不 UPDATE）。
   * 这条断言的意义：证明后 4 次确实进了「复用」分支，而不是静默什么都没做。
   */
  check('后 4 次全部走复用分支（UPDATE updated_at）', g.__RE14_UPDATED__.length === 4, `UPDATE 次数=${g.__RE14_UPDATED__.length}`);

  hr('场景 5：isAutoRegisteredShell 判据（清理脚本复用）');
  const cases = [
    { row: { auto_registered: 1, doc_count: 0, bytes: 0, last_synced_at: null, name: 'Neo MD', vault_id: 'v1' }, expect: true, why: '典型空壳' },
    { row: { auto_registered: 1, doc_count: 0, bytes: 0, last_synced_at: null, name: 'v2', vault_id: 'v2' }, expect: true, why: 'name=vaultId' },
    { row: { auto_registered: 0, doc_count: 0, bytes: 0, last_synced_at: null, name: 'Neo MD', vault_id: 'v3' }, expect: false, why: '未标记自动登记 → 保守保留' },
    { row: { auto_registered: 1, doc_count: 5, bytes: 100, last_synced_at: null, name: 'Neo MD', vault_id: 'v4' }, expect: false, why: '有文档 → 不是空壳' },
    { row: { auto_registered: 1, doc_count: 0, bytes: 0, last_synced_at: new Date(), name: 'Neo MD', vault_id: 'v5' }, expect: false, why: '曾同步过 → 保守保留' },
    { row: { auto_registered: 1, doc_count: 0, bytes: 0, last_synced_at: null, name: '我的笔记', vault_id: 'v6' }, expect: false, why: '用户自定义名 → 保留' },
  ];
  for (const c of cases) {
    const got = isAutoRegisteredShell(c.row);
    check(`isAutoRegisteredShell(${c.why}) = ${c.expect}`, got === c.expect, `实际 ${got}`);
  }

  hr('汇总');
  const passed = results.filter((r) => r.pass).length;
  log(`  ${passed}/${results.length} 项通过`);
  const out = join(OUT, 're14-prevent-recurrence.json');
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2), 'utf8');
  log(`  证据 → ${out}`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();
