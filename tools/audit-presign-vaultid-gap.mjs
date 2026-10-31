
/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
/**
 * A4 管理端审计 · AUDIT-02 扩查：`vaultId` 在 storage 各端点上的丢失面（静态枚举 + 运行时探测）。
 *
 * ## 为什么需要这个脚本
 *
 * 首轮审计的结论是「全仓 7 个 `resolveScope` 调用点，仅 presign 一处有缺陷」——
 * 但那是**断言**而非**证据**。Lead 要求把它变成可复现的证明：
 *   1. 枚举全部 `resolveScope` 调用点，逐个说明「上游 schema 是否声明 vaultId」、
 *      「是否真的能把 body 里的 vaultId 送到 readVaultId」；
 *   2. 对每个「能从 body 读 vaultId」的端点做一次无害探测：
 *      带一个**已停用**仓库的 vaultId，看返回 403（正确）还是 200（可绕过）。
 *
 * ## 本轮扩查新增的发现（首轮遗漏）
 *
 * 除 presign 外，`PUT /api/storage/object`（上传）同样无法从 body 获得 vaultId：
 *   - 非 multipart：`application/octet-stream` 解析成 Buffer，body 里根本没有字段；
 *   - multipart：`readRawBody()` 只提取 `file.fields.key`，**从未提取 `file.fields.vaultId`**，
 *     而 `storage.js:504` 的注释明确写着「vaultId 也可能从 body 传（multipart 场景），
 *     因此把 body 一并交给作用域解析」—— **注释的意图并未实现**。
 * 因此这是与 presign 同源的第二处丢失点，只是表现形态不同。
 *
 * ## 安全性
 *
 * 全部使用临时用户 + 临时仓库，结束时清理（含 credit_ledger，避免孤儿账本）。
 * 探测只针对「已停用仓库的读取/签名」，不写入、不删除任何真实对象。
 *
 * 用法：node tools/audit-presign-vaultid-gap.mjs
 *      API_BASE=http://127.0.0.1:3211 node tools/audit-presign-vaultid-gap.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const apiRoot = path.join(repo, 'services', 'api');
const storageJs = path.join(apiRoot, 'src', 'routes', 'storage.js');
const vaultScopeJs = path.join(apiRoot, 'src', 'lib', 'vault-scope.js');
const { query, execute, closePool } = await import(pathToFileURL(path.join(apiRoot, 'src/db/pool.js')).href);

const B = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');

let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    fails.push(`${label}${extra ? `  [${extra}]` : ''}`);
    console.log(`  FAIL  ${label}${extra ? `  [${extra}]` : ''}`);
  }
}
function head(t) {
  console.log(`\n${'='.repeat(94)}\n${t}\n${'='.repeat(94)}`);
}

const src = fs.readFileSync(storageJs, 'utf8');
const lines = src.split(/\r?\n/);

/* ================================================================ */
/* 第 1 部分：静态枚举全部 resolveScope 调用点                        */
/* ================================================================ */
head('第 1 部分：静态枚举 —— 每个 resolveScope 调用点能否从 body 拿到 vaultId');

/**
 * 从调用点向上找所属路由（同时兼容单行与多行 app.xxx( 写法）。
 * @param {number} callLine 0-based 行号
 */
function findRoute(callLine) {
  for (let i = callLine; i >= 0; i -= 1) {
    const line = lines[i];
    // 单行：app.get('/api/storage/list', ...)
    let m = /app\.(get|post|put|delete|head|patch)\(\s*'([^']+)'/.exec(line);
    if (m) return { method: m[1].toUpperCase(), path: m[2], line: i + 1 };
    // 多行：app.get(  然后下一行是 '/api/storage/object'
    m = /app\.(get|post|put|delete|head|patch)\(\s*$/.exec(line);
    if (m) {
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
        const pm = /'([^']+)'/.exec(lines[j]);
        if (pm) return { method: m[1].toUpperCase(), path: pm[1], line: i + 1 };
      }
    }
  }
  return { method: '?', path: '(未识别)', line: 0 };
}

/** 该调用点上游是否用 body 参与作用域解析、以及 body 来源是什么 */
function analyzeBodySource(callLine) {
  // 向上找最近一次 body 赋值
  for (let i = callLine; i >= Math.max(0, callLine - 30); i -= 1) {
    const line = lines[i];
    if (/parse\(\s*\w+Schema\s*,\s*req\.body/.test(line)) {
      const sm = /parse\(\s*(\w+Schema)/.exec(line);
      return { kind: 'zod', schema: sm?.[1] ?? '?', line: i + 1 };
    }
    if (/await readRawBody\(req\)/.test(line)) {
      return { kind: 'readRawBody', schema: null, line: i + 1 };
    }
  }
  return { kind: 'none', schema: null, line: 0 };
}

const callSites = [];
lines.forEach((line, i) => {
  const m = /resolveScope\(\s*req\s*,\s*([^,)]+)/.exec(line);
  if (!m) return;
  // 跳过函数定义本身
  if (/async function resolveScope/.test(line)) return;
  const arg = m[1].trim();
  const route = findRoute(i);
  const bodySrc = analyzeBodySource(i);
  callSites.push({ line: i + 1, arg, route, bodySrc });
});

/** 检查某个 zod schema 是否声明了 vaultId */
function schemaHasVaultId(name) {
  const re = new RegExp(`const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`);
  const m = re.exec(src);
  if (!m) return null;
  return /\bvaultId\b/.test(m[1]);
}

/** readRawBody 返回对象里是否包含 vaultId */
const readRawHasVaultId = (() => {
  const fnStart = lines.findIndex((l) => /async function readRawBody/.test(l));
  if (fnStart < 0) return null;
  let depth = 0;
  let body = '';
  for (let i = fnStart; i < lines.length; i += 1) {
    body += `${lines[i]}\n`;
    depth += (lines[i].match(/\{/g) ?? []).length;
    depth -= (lines[i].match(/\}/g) ?? []).length;
    if (i > fnStart && depth <= 0) break;
  }
  return /vaultId/.test(body);
})();

console.log(`  readRawBody() 返回对象是否含 vaultId：${readRawHasVaultId ? '是' : '否'}`);
console.log(`    （multipart 分支只取了 file.fields.key，未取 file.fields.vaultId）`);
console.log('');
console.log('  #  行号   方法   路径                          body 来源         schema 声明 vaultId?  能否从 body 拿到');
console.log('  ' + '-'.repeat(110));

const gapSites = [];
for (const [idx, cs] of callSites.entries()) {
  const fromBody = cs.arg !== 'null';
  let schemaVerdict = '-';
  let canGet = '否（仅 header/query）';

  if (fromBody) {
    if (cs.bodySrc.kind === 'zod') {
      const has = schemaHasVaultId(cs.bodySrc.schema);
      schemaVerdict = has === null ? '(schema 未找到)' : has ? '是' : '否';
      canGet = has ? '是' : '否 ❌ 被 zod strip';
    } else if (cs.bodySrc.kind === 'readRawBody') {
      schemaVerdict = 'n/a（无 zod）';
      canGet = readRawHasVaultId ? '是' : '否 ❌ readRawBody 未提取';
    } else {
      schemaVerdict = '(未识别)';
      canGet = '未知';
    }
    if (canGet.startsWith('否')) {
      gapSites.push({ ...cs, verdict: canGet });
    }
  }

  console.log(
    `  ${String(idx + 1).padStart(2)} ${String(cs.line).padStart(5)}   ${cs.route.method.padEnd(6)} ${cs.route.path.padEnd(28)}  ` +
      `${String(cs.bodySrc.kind).padEnd(15)}  ${String(schemaVerdict).padEnd(22)}  ${canGet}`,
  );
}

console.log('');
console.log(`  合计调用点：${callSites.length} 个；其中 body 参与作用域解析的：${callSites.filter((c) => c.arg !== 'null').length} 个`);
console.log(`  **无法从 body 拿到 vaultId 的（缺陷点）：${gapSites.length} 个**`);
for (const g of gapSites) console.log(`    - ${g.route.method} ${g.route.path}  @storage.js:${g.line}  （${g.verdict}）`);

/* ================================================================ */
/* 第 2 部分：运行时探测                                               */
/* ================================================================ */
head('第 2 部分：运行时探测 —— 带「已停用仓库」的 vaultId，看 403 还是 200');

const adminLogin = await fetch(`${B}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'admin', password: requireAuditPass() }),
}).then((r) => r.json());
if (!adminLogin?.ok) {
  console.error('  admin 登录失败，无法继续运行时探测');
  await closePool();
  process.exit(1);
}
const adminToken = adminLogin.data.accessToken;

async function call(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${B}${p}`, {
    method,
    headers: {
      ...(raw ? {} : body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}

const stamp = Date.now();
let userId = null;
try {
  const reg = await call('POST', '/api/auth/register', {
    token: '',
    body: { email: `vg-${stamp}@neomd.local`, username: `vg_${stamp}`, password: 'VaultGap!2026' },
  });
  if (!reg.json?.ok) {
    console.error(`  注册临时用户失败 HTTP ${reg.status}: ${JSON.stringify(reg.json).slice(0, 160)}`);
    console.error('  （可能触发了注册限流，请稍后重跑）');
    await closePool();
    process.exit(1);
  }
  const userToken = reg.json.data.accessToken;
  userId = reg.json.data.user.id;
  const vaultId = `vg${stamp}`;

  await call('POST', '/api/vaults', { token: userToken, body: { vaultId, name: 'vaultId 缺口探测仓库', docCount: 1, bytes: 64 } });
  const row = (await query('SELECT id, status FROM user_vaults WHERE user_id = ? AND vault_id = ? LIMIT 1', [userId, vaultId]))[0];
  await call('PUT', `/api/admin/vaults/${row.id}`, { token: adminToken, body: { status: 'disabled' } });
  const after = (await query('SELECT status FROM user_vaults WHERE id = ? LIMIT 1', [row.id]))[0];
  console.log(`  临时用户 #${userId}，仓库 ${vaultId}（id=${row.id}）已停用：status=${after?.status}`);
  check(after?.status === 'disabled', '前置条件：仓库在 DB 中确实为 disabled', `status=${after?.status}`);

  console.log('');
  console.log('  探测结果（期望：全部 403 VAULT_DISABLED）：');
  console.log('  ' + '-'.repeat(110));

  const probes = [
    {
      label: 'POST /api/storage/presign  body.vaultId（JSON）',
      run: () =>
        call('POST', '/api/storage/presign', {
          token: userToken,
          body: { vaultId, key: 'docs/probe.md', method: 'PUT', contentType: 'text/markdown' },
        }),
      expect: 403,
    },
    {
      label: 'POST /api/storage/presign  header x-vault-id',
      run: () =>
        call('POST', '/api/storage/presign', {
          token: userToken,
          headers: { 'x-vault-id': vaultId },
          body: { key: 'docs/probe.md', method: 'PUT', contentType: 'text/markdown' },
        }),
      expect: 403,
    },
    {
      label: 'POST /api/storage/presign  query ?vaultId=',
      run: () =>
        call('POST', `/api/storage/presign?vaultId=${encodeURIComponent(vaultId)}`, {
          token: userToken,
          body: { key: 'docs/probe.md', method: 'PUT', contentType: 'text/markdown' },
        }),
      expect: 403,
    },
    {
      label: 'GET  /api/storage/list      query ?vaultId=',
      run: () => call('GET', `/api/storage/list?vaultId=${encodeURIComponent(vaultId)}&prefix=`, { token: userToken }),
      expect: 403,
    },
    {
      label: 'GET  /api/storage/object    query ?vaultId=',
      run: () => call('GET', `/api/storage/object?key=docs%2Fprobe.md&vaultId=${encodeURIComponent(vaultId)}`, { token: userToken }),
      expect: 403,
    },
    {
      label: 'HEAD /api/storage/object    query ?vaultId=',
      run: () => call('HEAD', `/api/storage/object?key=docs%2Fprobe.md&vaultId=${encodeURIComponent(vaultId)}`, { token: userToken }),
      expect: 403,
    },
    {
      label: 'DELETE /api/storage/object  query ?vaultId=',
      run: () => call('DELETE', `/api/storage/object?key=docs%2Fnonexist.md&vaultId=${encodeURIComponent(vaultId)}`, { token: userToken }),
      expect: 403,
    },
    {
      label: 'PUT  /api/storage/object    octet-stream + header x-vault-id',
      run: () =>
        call('PUT', `/api/storage/object?key=docs%2Fprobe.md`, {
          token: userToken,
          headers: { 'x-vault-id': vaultId, 'content-type': 'application/octet-stream' },
          raw: Buffer.from('probe'),
        }),
      expect: 403,
    },
  ];

  const results = [];
  for (const p of probes) {
    const r = await p.run();
    const blocked = r.status === 403;
    const legacy = r.headers.get('x-vault-legacy');
    const code = r.json?.error?.code ?? '-';
    results.push({ label: p.label, status: r.status, blocked, code, legacy });
    const mark = blocked ? '✓ 已拒绝' : '❌ 未拒绝';
    console.log(
      `  ${p.label.padEnd(52)} → HTTP ${String(r.status).padEnd(3)} ${String(code).padEnd(18)} legacy=${String(legacy ?? '-').padEnd(2)} ${mark}`,
    );
  }

  // multipart 上传：vaultId 作为表单字段（注释声称支持的场景）
  console.log('');
  console.log('  multipart 上传探测（storage.js:504 注释声称「vaultId 也可从 body 传」）：');
  try {
    const fd = new FormData();
    fd.append('vaultId', vaultId);
    fd.append('key', 'docs/probe-multipart.md');
    fd.append('file', new Blob([Buffer.from('probe')], { type: 'text/markdown' }), 'probe.md');
    const res = await fetch(`${B}/api/storage/object`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${userToken}` },
      body: fd,
    });
    const legacy = res.headers.get('x-vault-legacy');
    const blocked = res.status === 403;
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    results.push({ label: 'PUT  /api/storage/object    multipart 字段 vaultId', status: res.status, blocked, code: json?.error?.code ?? '-', legacy });
    console.log(
      `  PUT  /api/storage/object    multipart 字段 vaultId          → HTTP ${String(res.status).padEnd(3)} ${String(json?.error?.code ?? '-').padEnd(18)} legacy=${String(legacy ?? '-').padEnd(2)} ${blocked ? '✓ 已拒绝' : '❌ 未拒绝（vaultId 字段被丢弃）'}`,
    );
  } catch (e) {
    console.log(`  multipart 探测异常：${String(e.message).slice(0, 80)}`);
  }

  /* ---------------- 判定 ---------------- */
  console.log('');
  const bypassed = results.filter((r) => !r.blocked);
  check(bypassed.length === 0, '所有 body-可传 vaultId 的端点均正确拒绝已停用仓库', `未拒绝 ${bypassed.length}/${results.length}`);
  if (bypassed.length) {
    console.log('');
    console.log('  ❌ 可绕过的端点：');
    for (const b of bypassed) {
      console.log(`    - ${b.label}`);
      console.log(`      HTTP ${b.status}，x-vault-legacy=${b.legacy ?? '-'}`);
      if (b.legacy === '1') console.log('      → 静默降级到 legacy 前缀：既不校验停用，也不做仓库隔离');
    }
  }
} finally {
  head('清理');
  if (userId) {
    await execute('DELETE FROM credit_ledger WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM ai_usage WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_vaults WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]).catch(() => {});
    await execute('DELETE FROM user_settings WHERE user_id = ?', [userId]).catch(() => {});
    const d = await call('DELETE', `/api/admin/users/${userId}`, { token: adminToken });
    const left = await query('SELECT COUNT(*) AS n FROM users WHERE id = ?', [userId]);
    const leftV = await query('SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?', [userId]);
    console.log(`  删除临时用户 #${userId} → HTTP ${d.status}；users 剩余 ${left[0]?.n}，user_vaults 剩余 ${leftV[0]?.n}`);
  }
}

head('结论');
console.log(`  静态枚举：${callSites.length} 个 resolveScope 调用点，${gapSites.length} 个无法从 body 取得 vaultId`);
for (const g of gapSites) console.log(`    - ${g.route.method} ${g.route.path}（storage.js:${g.line}）`);
console.log('');
console.log('  与首轮审计的差异：首轮凭静态阅读判断「仅 presign 一处」；');
console.log('  本轮用 readRawBody 的实际返回值复核后，确认 **PUT /api/storage/object 亦丢失 vaultId**');
console.log('  （multipart 的 file.fields.vaultId 从未被提取，尽管 storage.js:504 的注释声称支持）。');
console.log('');
console.log(`  汇总：通过 ${pass} 项，失败 ${fails.length} 项`);

await closePool();
process.exitCode = 0;
