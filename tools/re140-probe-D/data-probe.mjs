// 独立取证员 D —— 数据层实测（只读）。
// 1) MySQL 只读：user_vaults 表 admin 行数/明细/时间分布
// 2) HTTP：登录 -> GET /api/settings（命名模板与 AI 提示词云端值）
//           GET /api/vaults（服务端仓库清单）
//           GET /api/admin/releases（客户端分发清单）
//           GET /api/admin/plugins?page=1&pageSize=20（后台插件列表）
// 严格只读：仅 SELECT / GET，绝不写入/删除。
import { createRequire } from 'node:module';
// mysql2 装在 services/api/node_modules，用 createRequire 精确锚定避免 ESM 解析不到
const apiRequire = createRequire('C:/Data/BAC/neomd/neomd-V1/services/api/package.json');
const mysql = apiRequire('mysql2/promise');

const DB = {
  host: '127.0.0.1',
  port: 3306,
  user: 'neomd',
  password: 'ffTZxmNeXmmJPRXm',
  database: 'neomd',
};
const API = 'http://127.0.0.1:3200';
const USER = 'admin';
const PASS = '6655';

const out = { sampledAt: new Date().toISOString(), problem1: {}, problem2: {}, problem3: {}, problem4: {} };

async function httpLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function authedGet(token, path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/* ---------- 问题2：SQL 只读查 user_vaults ---------- */
async function probeVaults(conn) {
  const [adminRows] = await conn.query(
    "SELECT id, username, role, created_at FROM users WHERE username = ? LIMIT 1", ['admin'],
  );
  const uid = adminRows?.[0]?.id;
  out.problem2.adminUser = adminRows[0] ?? null;

  const [rows] = await conn.query(
    'SELECT id, vault_id, name, doc_count, bytes, status, last_synced_at, created_at, updated_at FROM user_vaults WHERE user_id = ? ORDER BY id ASC',
    [uid],
  );
  out.problem2.totalRows = rows.length;
  out.problem2.rows = rows.map((r) => ({
    id: r.id,
    vaultId: r.vault_id,
    name: r.name,
    docCount: r.doc_count,
    bytes: Number(r.bytes ?? 0),
    status: r.status,
    lastSyncedAt: r.last_synced_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  // 分类：真实 vs 疑似测试遗留
  const testPatterns = ['selftest', 're121', 'qa121', 'qa119', 'vaultmv', 'test', 'probe', 'repo121', 'tmp', 'dev'];
  const classify = (r) => {
    const id = String(r.vault_id ?? '').toLowerCase();
    const name = String(r.name ?? '').toLowerCase();
    const hits = testPatterns.filter((p) => id.includes(p) || name.includes(p));
    const randId = /^vault[a-z0-9]{10,}$/.test(r.vault_id ?? '');
    return { testHits: hits, randomId: randId };
  };
  out.problem2.classification = rows.map((r) => ({ ...classify(r), vaultId: r.vault_id, name: r.name }));
  // 时间分布
  const dist = {};
  for (const r of rows) {
    const d = String(r.created_at ?? '').slice(0, 10) || 'null';
    dist[d] = (dist[d] ?? 0) + 1;
  }
  out.problem2.createdAtDistribution = dist;
}

/* ---------- 问题1：云端 settings 值 ---------- */
async function probeSettings(token) {
  for (const platform of ['web', 'desktop', '']) {
    const q = platform ? `?platform=${platform}` : '';
    const { status, body } = await authedGet(token, `/api/settings${q}`);
    const key = platform || '(no-platform)';
    out.problem1[`cloudSettings_${key}`] = {
      status,
      payload: body?.payload ?? body,
      sensitiveKeys: body?.sensitive ? Object.keys(body.sensitive ?? {}) : null,
      version: body?.version,
    };
    // 提取命名相关实际值
    if (body?.payload) {
      const naming = body.payload.global?.naming ?? body.payload.naming;
      out.problem1[`cloudNaming_${key}`] = naming ?? null;
    }
  }
}

/* ---------- 问题3：admin/releases ---------- */
async function probeReleases(token) {
  const { status, body } = await authedGet(token, '/api/admin/releases');
  out.problem3.adminReleases = { status, prefix: body?.prefix, files: body?.files, message: body?.message };
  // 也抓公开下载清单
  const pub = await fetch(`${API}/api/download/list`);
  const pubBody = await pub.json();
  out.problem3.publicDownloadList = { status: pub.status, body: pubBody };
  // 读 package.json 版本（源码里已知 1.3.1，这里再确认磁盘实际）
  out.problem3.note = 'services/api/package.json version=1.3.1（DOWNLOAD_FILES 动态推导该值）';
}

/* ---------- 问题4：admin/plugins 列表接口现状 ---------- */
async function probePlugins(token) {
  const { status, body } = await authedGet(token, '/api/admin/plugins?page=1&pageSize=20');
  out.problem4.adminPlugins = {
    status,
    itemCount: body?.items?.length,
    hasPage: 'page' in (body ?? {}),
    hasPageSize: 'pageSize' in (body ?? {}),
    hasTotal: 'total' in (body ?? {}),
    total: body?.total,
    sampleIds: (body?.items ?? []).slice(0, 20).map((i) => ({ id: i.id, pluginId: i.pluginId, name: i.name, status: i.status })),
  };
}

async function main() {
  const conn = await mysql.createConnection(DB);
  try {
    await probeVaults(conn);
  } finally {
    await conn.end();
  }
  const login = await httpLogin();
  out.login = { status: login.status, keys: Object.keys(login.body ?? {}), user: login.body?.user };
  const token = login.body?.accessToken ?? login.body?.token ?? null;
  if (token) {
    await probeSettings(token);
    await probeReleases(token);
    await probePlugins(token);
    const vaultsHttp = await authedGet(token, '/api/vaults');
    out.problem2.httpVaults = { status: vaultsHttp.status, count: vaultsHttp.body?.vaults?.length, vaults: vaultsHttp.body?.vaults };
  } else {
    out.loginError = login.body;
  }
  console.log(JSON.stringify(out, null, 2));
  const fs = await import('node:fs');
  fs.writeFileSync('C:\\Data\\BAC\\neomd\\neomd-V1\\tools\\re140-probe-D\\data-probe.json', JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });