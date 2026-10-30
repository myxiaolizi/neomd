#!/usr/bin/env node
/**
 * Neo MD 社区插件 · 本地开发 API 端到端冒烟测试
 * ==================================================================
 *   node plugin-market/deploy/local-smoke.mjs --help
 *   node plugin-market/deploy/local-smoke.mjs                                  # 匿名用例
 *   node plugin-market/deploy/local-smoke.mjs --base http://127.0.0.1:3211
 *   node plugin-market/deploy/local-smoke.mjs --token-file <path>              # 完整发布 + 校验
 *
 * 测试面（每项输出 PASS / FAIL / SKIP 与耗时）：
 *   1  匿名 GET /api/plugins/market → 200 且 data.items 为数组（记录基线条数）
 *   2  逐条发布 POST /api/plugins（Bearer）；409 PLUGIN_ID_TAKEN → PUT /api/plugins/{id} 更新
 *   3  发布后 GET /api/plugins/market → 断言产物中的 pluginId 全部出现
 *   4  逐个 POST /api/plugins/{id}/download → 取回 plugin.codeJs，与本地插件文件做 sha256 比对
 *   5  负向：codeJs 仅 3 字符 → 必须 400；缺失 description → 必须 400
 *   6  汇总（总数/通过/失败 + 失败明细 + 总耗时）→ plugin-market/reports/local-smoke.json
 *
 * 凭据来源（三选一，优先级从上到下；均不提供则鉴权用例 SKIP）：
 *   1) --token-file <path>
 *        · 内容形如 xxx.yyy.zzz（JWT）      → 直接作 Authorization: Bearer
 *        · 内容含 ":"（username:password）  → 先 POST /api/auth/login 换 accessToken
 *        · 其它                             → 视为原始 Bearer 令牌
 *   2) 环境变量 NEOMD_ADMIN_TOKEN           → 直接作 Bearer 令牌
 *   3) 环境变量 NEOMD_ADMIN_USER + NEOMD_ADMIN_PASSWORD → 登录换 accessToken
 *
 * 安全：任何情况下都不打印完整 token / 密码（最多打印前 6 位 + …）。
 *
 * 退出码：0 = 无 FAIL（含全部 SKIP 的情形）；1 = 存在 FAIL。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------- 路径与常量 ------------------------------- */

const here = dirname(fileURLToPath(import.meta.url)); // plugin-market/deploy
const root = resolve(here, '..'); // plugin-market
const DEFAULT_BASE = 'http://127.0.0.1:3211';
const DEFAULT_PAYLOAD = join(root, 'dist', 'plugins-payload.json');
const PLAN_PATH = join(root, 'PLAN.json');
const PLUGINS_DIR = join(root, 'plugins');
const REPORT_PATH = join(root, 'reports', 'local-smoke.json');

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REQ_TIMEOUT_MS = 30_000;
const BODY_TRUNC = 200;

/* --------------------------------- 小工具 --------------------------------- */

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256Text = (s) => createHash('sha256').update(Buffer.from(String(s ?? ''), 'utf8')).digest('hex');
const trunc = (s, n = BODY_TRUNC) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const mask = (t) => (t ? String(t).slice(0, 6) + '…' : '(无)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/**
 * 统一 HTTP 调用。连接失败不抛异常，返回 { network:false, error }。
 * 429 时按 retry-after 退避重试（最多 2 次），避免撞全局限流桶（300 次/分钟）。
 */
async function call(base, method, path, { token, body, timeoutMs = REQ_TIMEOUT_MS, retries = 2 } = {}) {
  const url = base.replace(/\/+$/, '') + path;
  for (let attempt = 0; ; attempt++) {
    const headers = { 'x-requested-with': 'neomd-local-smoke' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON 响应，保留 text */
      }
      const ms = Date.now() - t0;
      if (res.status === 429 && attempt < retries) {
        const ra = Number(res.headers.get('retry-after')) || 3;
        await sleep(Math.min(15, Math.max(1, ra)) * 1000);
        continue;
      }
      return { network: true, status: res.status, json, text, ms };
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : e?.message || String(e);
      return { network: false, status: 0, json: null, text: '', error: msg, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* --------------------------------- 参数解析 --------------------------------- */

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    tokenFile: '',
    payload: DEFAULT_PAYLOAD,
    skipPublish: false,
    help: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--skip-publish') out.skipPublish = true;
    else if (a === '--base') out.base = argv[++i] ?? out.base;
    else if (a === '--token-file') out.tokenFile = argv[++i] ?? '';
    else if (a === '--payload') out.payload = argv[++i] ?? out.payload;
    else out.unknown.push(a);
  }
  return out;
}

/* ---------------------------------- 帮助 ---------------------------------- */

function printHelp() {
  console.log(`Neo MD 插件市场 · 本地开发 API 端到端冒烟测试
${'='.repeat(66)}

用法
  node plugin-market/deploy/local-smoke.mjs [选项]

选项
  --base <url>          本地 API 基地址（默认 ${DEFAULT_BASE}）
  --token-file <path>   凭据文件：JWT / username:password / 原始令牌
  --payload <path>      发布产物 JSON（默认 plugin-market/dist/plugins-payload.json）
  --skip-publish        只跑只读用例（1 市场基线 / 3 市场复核 / 5 负向仍需凭据）
  --help, -h            显示本帮助

凭据三种来源（优先级从上到下；均不提供则鉴权用例标记 SKIP）
  1) --token-file <path>
       · 文件内容形如 xxx.yyy.zzz（JWT）    → 直接作 Authorization: Bearer
       · 文件内容含 ":"（username:password）→ 先 POST /api/auth/login 换 accessToken
       · 其它内容                           → 视为原始 Bearer 令牌
  2) 环境变量 NEOMD_ADMIN_TOKEN            → 直接作 Bearer 令牌
  3) 环境变量 NEOMD_ADMIN_USER + NEOMD_ADMIN_PASSWORD → 登录换 accessToken
     （登录体字段为 { account, password }，见 services/api/src/routes/auth.js）

  安全：脚本绝不打印完整 token / 密码，最多显示前 6 位 + …

测试面
  1  匿名 GET /api/plugins/market → 200 且 data.items 为数组（记录基线条数）
  2  逐条发布 POST /api/plugins（Bearer）；409 PLUGIN_ID_TAKEN → PUT 更新（版本号不变）
  3  发布后 GET /api/plugins/market → 断言产物中的 pluginId 全部出现
  4  逐个 POST /api/plugins/{id}/download → plugin.codeJs 与本地插件文件 sha256 比对
  5  负向：codeJs 仅 3 字符 → 400；缺失 description → 400
  6  汇总 + 失败明细（pluginId · HTTP 状态 · 响应体截断 ${BODY_TRUNC} 字）→ 报告文件

示例
  # 仅匿名用例（无凭据，2/3/4/5 标记 SKIP）
  node plugin-market/deploy/local-smoke.mjs --base http://127.0.0.1:3211

  # 先生成发布产物，再带凭据跑完整发布与校验
  node plugin-market/deploy/build-artifacts.mjs
  node plugin-market/deploy/local-smoke.mjs --base http://127.0.0.1:3211 ^
      --token-file "C:\\Data\\BAC\\neomd\\.token-admin.txt"

  # 用环境变量（PowerShell）
  $env:NEOMD_ADMIN_USER = "admin"; $env:NEOMD_ADMIN_PASSWORD = "********"
  node plugin-market/deploy/local-smoke.mjs --base http://127.0.0.1:3211

前置条件
  · 本地 API 已启动；默认端口 ${DEFAULT_BASE}，实际端口以 services/api/.env.local 的 PORT 为准，
    可用 --base 覆盖（例如 http://127.0.0.1:3200）。
  · 完整发布需先有产物：node plugin-market/deploy/build-artifacts.mjs
    产物缺失时，依赖它的用例（2/3/4）标记 SKIP 并给出提示，不抛堆栈。

退出码
  0   无 FAIL（包含「仅 SKIP」的情形，此时会显著提示鉴权用例未执行）
  1   存在 FAIL（明细见控制台与 plugin-market/reports/local-smoke.json）

报告
  每次运行覆盖写入 plugin-market/reports/local-smoke.json
`);
}

/* --------------------------------- 凭据解析 --------------------------------- */

/** 登录换 accessToken（字段名以 routes/auth.js 为准：account + password） */
async function login(base, user, password, source) {
  const r = await call(base, 'POST', '/api/auth/login', { body: { account: user, password } });
  const token = r.json?.data?.accessToken || r.json?.accessToken || '';
  if (r.network && r.status === 200 && token) {
    return { token, source, note: `登录成功（来源 ${source}，user=${user}，token=${mask(token)}）` };
  }
  const code = r.json?.error?.code ? ` ${r.json.error.code}` : '';
  const msg = r.json?.error?.message || r.error || '无 accessToken 返回';
  return { token: '', source, note: `登录失败（来源 ${source}，HTTP ${r.status}${code}）：${trunc(msg, 120)}` };
}

async function resolveToken(opts, base, reachable) {
  // 1) --token-file
  if (opts.tokenFile) {
    const p = abs(opts.tokenFile);
    if (!existsSync(p)) return { token: '', source: null, note: `--token-file 不存在：${p}` };
    let raw;
    try {
      raw = readFileSync(p, 'utf8').trim();
    } catch (e) {
      return { token: '', source: null, note: `--token-file 读取失败：${e.message}` };
    }
    if (!raw) return { token: '', source: null, note: '--token-file 内容为空' };
    // 允许文件里写 "Bearer xxx.yyy.zzz"
    const stripped = raw.replace(/^Bearer\s+/i, '').split(/\s+/).pop();
    if (JWT_RE.test(stripped)) return { token: stripped, source: 'token-file(JWT)', note: `已读取 JWT（来源 token-file，token=${mask(stripped)}）` };
    if (raw.includes(':')) {
      const i = raw.indexOf(':');
      if (!reachable) return { token: '', source: 'token-file(user:pass)', note: 'API 不可达，跳过登录' };
      return await login(base, raw.slice(0, i).trim(), raw.slice(i + 1).trim(), 'token-file(user:pass)');
    }
    return { token: stripped, source: 'token-file(raw)', note: `已读取原始令牌（来源 token-file，token=${mask(stripped)}）` };
  }
  // 2) NEOMD_ADMIN_TOKEN
  const envToken = String(process.env.NEOMD_ADMIN_TOKEN || '').trim();
  if (envToken) return { token: envToken, source: 'env NEOMD_ADMIN_TOKEN', note: `已读取环境变量令牌（token=${mask(envToken)}）` };
  // 3) NEOMD_ADMIN_USER + NEOMD_ADMIN_PASSWORD
  const envUser = String(process.env.NEOMD_ADMIN_USER || '').trim();
  const envPass = String(process.env.NEOMD_ADMIN_PASSWORD || '');
  if (envUser && envPass) {
    if (!reachable) return { token: '', source: 'env USER/PASSWORD', note: 'API 不可达，跳过登录' };
    return await login(base, envUser, envPass, 'env USER/PASSWORD');
  }
  if (envUser || envPass) {
    return { token: '', source: null, note: '环境变量 NEOMD_ADMIN_USER / NEOMD_ADMIN_PASSWORD 需成对提供' };
  }
  return { token: '', source: null, note: '未提供凭据（--token-file / NEOMD_ADMIN_TOKEN / NEOMD_ADMIN_USER+PASSWORD）' };
}

/* ------------------------------- 发布体构造 ------------------------------- */

const pick = (p, withId) => ({
  ...(withId ? { pluginId: p.pluginId } : {}),
  name: p.name,
  version: p.version || '1.0.0',
  category: p.category || 'writing',
  icon: p.icon || 'layers',
  description: p.description,
  readmeMd: p.readmeMd ?? '',
  codeJs: p.codeJs,
});

/* --------------------------------- 结果记录 --------------------------------- */

const results = [];
function record(id, name, status, detail = '', ms = 0, failures = [], extra = {}) {
  results.push({ id, name, status, detail, ms, failures, ...extra });
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  console.log(`${mark} [${status.padEnd(4)}] ${id} ${name}${ms ? ` (${ms}ms)` : ''}`);
  if (detail) console.log(`           ${detail}`);
  for (const f of failures.slice(0, 8)) {
    console.log(`           └─ ${f.pluginId} · HTTP ${f.status} · ${f.body}`);
  }
  if (failures.length > 8) console.log(`           └─ …另有 ${failures.length - 8} 条，详见报告`);
}

/* ---------------------------------- 用例 1 ---------------------------------- */

async function testBaseline(base) {
  const t0 = Date.now();
  const r = await call(base, 'GET', '/api/plugins/market');
  const ms = Date.now() - t0;
  if (!r.network) {
    record(1, '匿名 GET /api/plugins/market', 'FAIL', `无法连接 ${base}：${r.error}`, ms, [
      { pluginId: '-', status: 0, body: trunc(r.error) },
    ]);
    return { reachable: false, items: [] };
  }
  const items = r.json?.data?.items;
  if (r.status !== 200) {
    record(1, '匿名 GET /api/plugins/market', 'FAIL', `HTTP ${r.status}（期望 200）`, ms, [
      { pluginId: '-', status: r.status, body: trunc(r.text) },
    ]);
    return { reachable: true, items: [] };
  }
  if (!Array.isArray(items)) {
    record(1, '匿名 GET /api/plugins/market', 'FAIL', 'HTTP 200 但 data.items 不是数组', ms, [
      { pluginId: '-', status: r.status, body: trunc(r.text) },
    ]);
    return { reachable: true, items: [] };
  }
  record(1, '匿名 GET /api/plugins/market', 'PASS', `HTTP 200，data.items 为数组，基线 ${items.length} 条`, ms, [], {
    baseline: items.length,
  });
  return { reachable: true, items };
}

/* ---------------------------------- 用例 2 ---------------------------------- */

async function testPublish(base, token, payload) {
  const t0 = Date.now();
  const failures = [];
  let created = 0;
  let updated = 0;
  for (const p of payload) {
    const res = await call(base, 'POST', '/api/plugins', { token, body: pick(p, true) });
    if (res.network && (res.status === 200 || res.status === 201)) {
      created++;
      continue;
    }
    const code = res.json?.error?.code || '';
    if (res.status === 409 && code === 'PLUGIN_ID_TAKEN') {
      const put = await call(base, 'PUT', `/api/plugins/${encodeURIComponent(p.pluginId)}`, {
        token,
        body: pick(p, false),
      });
      if (put.network && put.status === 200) {
        updated++;
        continue;
      }
      failures.push({
        pluginId: p.pluginId,
        status: put.status,
        body: trunc(put.network ? put.text : `PUT 连接失败：${put.error}`),
      });
      continue;
    }
    failures.push({
      pluginId: p.pluginId,
      status: res.status,
      body: trunc(res.network ? res.text : `连接失败：${res.error}`),
    });
  }
  const ms = Date.now() - t0;
  record(
    2,
    '逐条发布 POST /api/plugins（409 → PUT 更新）',
    failures.length ? 'FAIL' : 'PASS',
    `共 ${payload.length} 款：新建 ${created} · 更新 ${updated} · 失败 ${failures.length}`,
    ms,
    failures,
    { created, updated },
  );
  return { created, updated, failures };
}

/* ---------------------------------- 用例 3 ---------------------------------- */

async function testMarketComplete(base, payload, planTotal) {
  const t0 = Date.now();
  const r = await call(base, 'GET', '/api/plugins/market');
  const ms = Date.now() - t0;
  if (!r.network || r.status !== 200) {
    record(3, '市场复核 pluginId 齐全 GET /api/plugins/market', 'FAIL', r.network ? `HTTP ${r.status}` : `连接失败：${r.error}`, ms, [
      { pluginId: '-', status: r.status, body: trunc(r.network ? r.text : r.error) },
    ]);
    return;
  }
  const items = Array.isArray(r.json?.data?.items) ? r.json.data.items : [];
  const present = new Set(items.map((x) => x.pluginId));
  const expect = payload.map((p) => p.pluginId);
  const missing = expect.filter((id) => !present.has(id));
  const failures = missing.map((id) => ({ pluginId: id, status: 200, body: '市场列表中未出现该 pluginId' }));
  let detail = `市场共 ${items.length} 条，应含 ${expect.length} 个 pluginId，缺失 ${missing.length}`;
  if (planTotal && expect.length < planTotal) detail += `（注意：产物为部分构建 ${expect.length}/${planTotal}，仅校验产物内条目）`;
  if (missing.length && items.length >= 200) detail += '（注意：市场 SQL LIMIT 200，条目过多可能被截断）';
  record(3, '市场复核 pluginId 齐全 GET /api/plugins/market', missing.length ? 'FAIL' : 'PASS', detail, ms, failures, {
    marketCount: items.length,
    expected: expect.length,
    missing: missing.length,
  });
}

/* ---------------------------------- 用例 4 ---------------------------------- */

async function testDownloadSha(base, payload, planMap) {
  const t0 = Date.now();
  const failures = [];
  let matched = 0;
  let byLocalFile = 0;
  let byPayload = 0;
  for (const p of payload) {
    const res = await call(base, 'POST', `/api/plugins/${encodeURIComponent(p.pluginId)}/download`);
    if (!res.network || res.status !== 200 || !res.json?.ok) {
      failures.push({
        pluginId: p.pluginId,
        status: res.status,
        body: trunc(res.network ? res.text : `连接失败：${res.error}`),
      });
      continue;
    }
    const remote = res.json?.data?.plugin?.codeJs;
    if (typeof remote !== 'string' || !remote) {
      failures.push({ pluginId: p.pluginId, status: res.status, body: '响应缺少 data.plugin.codeJs' });
      continue;
    }
    const got = sha256Text(remote);

    // 优先与本地插件文件（PLAN.json 的 file 字段）逐字节比对
    let want = null;
    let source = null;
    const file = planMap.get(p.pluginId);
    if (file) {
      const lp = join(PLUGINS_DIR, file);
      if (existsSync(lp)) {
        try {
          want = sha256Buf(readFileSync(lp));
          source = `本地文件 plugins/${file}`;
          byLocalFile++;
        } catch (e) {
          failures.push({ pluginId: p.pluginId, status: res.status, body: `本地文件读取失败：${e.message}` });
          continue;
        }
      }
    }
    // 回退：与产物中的 codeJs 比对
    if (want === null && typeof p.codeJs === 'string') {
      want = sha256Text(p.codeJs);
      source = '产物 codeJs（本地文件缺失，回退比对）';
      byPayload++;
    }
    if (want === null) {
      failures.push({ pluginId: p.pluginId, status: res.status, body: '本地文件与产物 codeJs 均不可用，无法比对' });
      continue;
    }
    if (got === want) matched++;
    else
      failures.push({
        pluginId: p.pluginId,
        status: res.status,
        body: `sha256 不一致（${source}）远端 ${got.slice(0, 12)}… 期望 ${want.slice(0, 12)}…`,
      });
  }
  const ms = Date.now() - t0;
  record(
    4,
    '下载回取并 sha256 比对 POST /api/plugins/{id}/download',
    failures.length ? 'FAIL' : 'PASS',
    `共 ${payload.length} 款：一致 ${matched}（本地文件 ${byLocalFile} · 产物回退 ${byPayload}）· 失败 ${failures.length}`,
    ms,
    failures,
    { matched },
  );
}

/* ---------------------------------- 用例 5 ---------------------------------- */

async function testNegative(base, token) {
  const t0 = Date.now();
  const failures = [];
  const ts = Date.now();
  const cases = [
    {
      label: 'codeJs 仅 3 字符',
      pluginId: `smoke-neg-short-${ts}`,
      body: {
        pluginId: `smoke-neg-short-${ts}`,
        name: '冒烟负向-超短代码',
        version: '1.0.0',
        category: 'writing',
        icon: 'layers',
        description: '负向用例：插件代码过短必须被服务端拒绝',
        readmeMd: '',
        codeJs: 'abc',
      },
    },
    {
      label: '缺失 description',
      pluginId: `smoke-neg-nodesc-${ts}`,
      body: {
        pluginId: `smoke-neg-nodesc-${ts}`,
        name: '冒烟负向-缺简介',
        version: '1.0.0',
        category: 'writing',
        icon: 'layers',
        readmeMd: '',
        codeJs:
          "export default { id: 'smoke-neg', name: '冒烟负向', version: '1.0.0', setup(api) { api.registerCommand({ id: 'smoke.neg', title: '负向用例', run() { api.notify('负向用例', 'info'); } }); } };",
      },
    },
  ];
  for (const c of cases) {
    const res = await call(base, 'POST', '/api/plugins', { token, body: c.body });
    if (res.network && res.status === 400) continue;
    // 意外创建成功 → 清理，避免污染市场
    if (res.network && (res.status === 200 || res.status === 201)) {
      await call(base, 'DELETE', `/api/plugins/${encodeURIComponent(c.pluginId)}`, { token });
    }
    failures.push({
      pluginId: c.label,
      status: res.status,
      body: trunc(res.network ? res.text : `连接失败：${res.error}`, BODY_TRUNC) || '期望 HTTP 400',
    });
  }
  const ms = Date.now() - t0;
  record(
    5,
    '负向校验（超短 codeJs / 缺失 description）POST /api/plugins',
    failures.length ? 'FAIL' : 'PASS',
    `2 个负向用例均返回 400${failures.length ? `，失败 ${failures.length}` : ''}`,
    ms,
    failures,
  );
}

/* ---------------------------------- 主流程 ---------------------------------- */

function loadPayload(payloadPath) {
  if (!existsSync(payloadPath)) {
    return {
      entries: [],
      available: false,
      reason: `未找到发布产物：${payloadPath}\n           请先运行：node plugin-market/deploy/build-artifacts.mjs\n           依赖该产物的用例（2 发布 / 3 市场复核 / 4 下载比对）将标记为 SKIP。`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(payloadPath, 'utf8'));
  } catch (e) {
    return { entries: [], available: false, reason: `发布产物解析失败：${e.message}` };
  }
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.plugins) ? raw.plugins : Array.isArray(raw?.items) ? raw.items : [];
  if (!entries.length) return { entries: [], available: false, reason: '发布产物为空或结构无法识别（期望数组或 { plugins: [...] }）' };
  const bad = entries.filter((e) => !e || !e.pluginId || typeof e.codeJs !== 'string');
  if (bad.length) {
    return {
      entries: [],
      available: false,
      reason: `发布产物有 ${bad.length} 条缺少 pluginId / codeJs 字段，无法用于发布校验`,
    };
  }
  return { entries, available: true, reason: '' };
}

function loadPlanMap() {
  const map = new Map();
  let total = 0;
  try {
    const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
    total = Number(plan?.total ?? plan?.plugins?.length ?? 0);
    for (const p of plan?.plugins || []) if (p?.id && p?.file) map.set(p.id, p.file);
  } catch {
    /* PLAN 不可读时，用例 4 回退到产物 codeJs 比对 */
  }
  return { map, total };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const base = String(opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const payloadPath = abs(opts.payload);

  console.log('');
  console.log('Neo MD 插件市场 · 本地开发 API 端到端冒烟测试');
  console.log('─'.repeat(66));
  console.log(`目标 API : ${base}`);
  console.log(`发布产物 : ${payloadPath}`);
  if (opts.unknown.length) console.log(`未识别参数（已忽略）：${opts.unknown.join(' ')}`);

  /* ---- 产物与 PLAN ---- */
  const { entries: payload, available: hasPayload, reason: payloadReason } = loadPayload(payloadPath);
  const { map: planMap, total: planTotal } = loadPlanMap();
  if (hasPayload) {
    console.log(`产物条目 : ${payload.length} 款${planTotal && payload.length < planTotal ? `（部分构建，PLAN 合计 ${planTotal}）` : ''}`);
  } else {
    console.log(`产物条目 : 不可用`);
    console.log('');
    console.log(`⚠ ${payloadReason}`);
  }
  console.log(`本地插件 : PLAN 映射 ${planMap.size} 条（用于 sha256 比对）`);

  /* ---- 用例 1：匿名市场基线（同时探测连通性） ---- */
  console.log('─'.repeat(66));
  const { reachable } = await testBaseline(base);

  /* ---- 凭据 ---- */
  const auth = reachable
    ? await resolveToken(opts, base, true)
    : { token: '', source: null, note: 'API 不可达，跳过凭据解析' };
  const hasToken = Boolean(auth.token);
  console.log(`凭据     : ${auth.note}`);
  console.log('─'.repeat(66));

  const skip = (id, name, reason) => record(id, name, 'SKIP', reason);
  const NO_AUTH = '无可用凭据 → 鉴权用例未执行';
  const NO_PAYLOAD = '无发布产物 → 请先运行 node plugin-market/deploy/build-artifacts.mjs';

  if (!reachable) {
    skip(2, '逐条发布 POST /api/plugins（409 → PUT 更新）', `API 不可达（${base}）`);
    skip(3, '市场复核 pluginId 齐全 GET /api/plugins/market', 'API 不可达');
    skip(4, '下载回取并 sha256 比对 POST /api/plugins/{id}/download', 'API 不可达');
    skip(5, '负向校验（超短 codeJs / 缺失 description）POST /api/plugins', 'API 不可达');
  } else {
    // 用例 2
    if (!hasToken) skip(2, '逐条发布 POST /api/plugins（409 → PUT 更新）', NO_AUTH);
    else if (!hasPayload) skip(2, '逐条发布 POST /api/plugins（409 → PUT 更新）', NO_PAYLOAD);
    else if (opts.skipPublish) skip(2, '逐条发布 POST /api/plugins（409 → PUT 更新）', '--skip-publish 已显式跳过');
    else await testPublish(base, auth.token, payload);

    // 用例 3
    if (!hasPayload) skip(3, '市场复核 pluginId 齐全 GET /api/plugins/market', NO_PAYLOAD);
    else if (!hasToken || opts.skipPublish)
      skip(3, '市场复核 pluginId 齐全 GET /api/plugins/market', !hasToken ? NO_AUTH : '--skip-publish（未发布，复核无意义）');
    else await testMarketComplete(base, payload, planTotal);

    // 用例 4
    if (!hasToken) skip(4, '下载回取并 sha256 比对 POST /api/plugins/{id}/download', NO_AUTH);
    else if (!hasPayload) skip(4, '下载回取并 sha256 比对 POST /api/plugins/{id}/download', NO_PAYLOAD);
    else if (opts.skipPublish) skip(4, '下载回取并 sha256 比对 POST /api/plugins/{id}/download', '--skip-publish 已显式跳过');
    else await testDownloadSha(base, payload, planMap);

    // 用例 5（只需凭据，不依赖产物）
    if (!hasToken) skip(5, '负向校验（超短 codeJs / 缺失 description）POST /api/plugins', NO_AUTH);
    else await testNegative(base, auth.token);
  }

  finish({ base, payloadPath, hasPayload, payloadCount: payload.length, planTotal, planMapped: planMap.size, hasToken, authSource: auth.source, reachable });
}

/* ---------------------------------- 汇总 ---------------------------------- */

/**
 * 优雅退出：先关闭 undici 全局连接池再让进程自然结束。
 * 直接 process.exit() 会在 Windows 上触发 libuv 断言崩溃
 * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），退出码变成 0xC0000409。
 */
async function shutdown(code) {
  process.exitCode = code;
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher')];
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch {
    /* 关闭失败不影响退出码 */
  }
}

async function finish(meta) {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
  const allFailures = results.flatMap((r) => (r.failures || []).map((f) => ({ test: r.id, ...f })));
  const baseline = results.find((r) => r.id === 1)?.baseline;

  console.log('─'.repeat(66));
  console.log(`汇总：共 ${results.length} 项 · PASS ${pass} · FAIL ${fail} · SKIP ${skip} · 累计耗时 ${totalMs}ms`);
  if (baseline !== undefined) console.log(`市场基线条数：${baseline}`);

  if (!meta.hasToken) {
    console.log('');
    console.log('┌' + '─'.repeat(64) + '┐');
    console.log('│  ⚠ 鉴权用例未执行（2 发布 / 3 市场复核 / 4 下载比对 / 5 负向 已 SKIP）');
    console.log('│    提供凭据后重跑以完成完整发布与校验，三选一：');
    console.log('│      --token-file <path>            （JWT 或 username:password）');
    console.log('│      NEOMD_ADMIN_TOKEN=<jwt>');
    console.log('│      NEOMD_ADMIN_USER + NEOMD_ADMIN_PASSWORD');
    console.log('└' + '─'.repeat(64) + '┘');
  }
  if (!meta.hasPayload) {
    console.log('');
    console.log('提示：发布产物缺失，请先运行 node plugin-market/deploy/build-artifacts.mjs');
  }

  if (allFailures.length) {
    console.log('');
    console.log(`失败明细（pluginId · HTTP 状态 · 响应体截断 ${BODY_TRUNC} 字）：`);
    for (const f of allFailures.slice(0, 40)) console.log(`  [用例${f.test}] ${f.pluginId} · HTTP ${f.status} · ${f.body}`);
    if (allFailures.length > 40) console.log(`  …另有 ${allFailures.length - 40} 条，详见报告文件`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    base: meta.base,
    reachable: meta.reachable,
    payloadPath: meta.payloadPath,
    payloadAvailable: meta.hasPayload,
    payloadCount: meta.payloadCount,
    planTotal: meta.planTotal || null,
    planMapped: meta.planMapped,
    authUsed: meta.hasToken,
    authSource: meta.authSource || null,
    baselineMarketCount: baseline ?? null,
    summary: { total: results.length, pass, fail, skip, durationMs: totalMs },
    results: results.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      detail: r.detail || '',
      ms: r.ms || 0,
      failures: r.failures || [],
    })),
    failures: allFailures,
    exitCode: fail > 0 ? 1 : 0,
  };
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('');
    console.log('报告：' + REPORT_PATH);
  } catch (e) {
    console.log('');
    console.log(`⚠ 报告写入失败：${e.message}`);
  }

  await shutdown(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log('');
  console.log('✗ 冒烟测试异常终止：' + (e?.message || String(e)));
  try {
    record(0, '未捕获异常', 'FAIL', trunc(e?.stack || e?.message || e, 400));
  } catch {
    /* 记录失败也要给出退出码 */
  }
  finish({ base: '(异常)', payloadPath: '', hasPayload: false, payloadCount: 0, planTotal: 0, planMapped: 0, hasToken: false, authSource: null, reachable: false });
});
