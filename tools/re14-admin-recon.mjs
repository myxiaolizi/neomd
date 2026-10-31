/**
 * Neo MD 1.4 · 后台组 T2 侦察脚本（只读，不发写请求）。
 *
 * 目的：在动手改代码前，用真实服务端把「后台客户端分发 / 插件市场 / 用户管理」三个
 * 模块的现状打出来，确认根因而不是猜根因。
 *
 * 用法：
 *   node tools/re14-admin-recon.mjs
 *   API_BASE=http://127.0.0.1:3200 node tools/re14-admin-recon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '6655';

let accessToken = '';

async function login() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ADMIN_USER, password: ADMIN_PASS }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`login failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  accessToken = json.data.accessToken;
  return json.data.user;
}

async function call(method, p, body) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function pkgVersion(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8')).version;
  } catch {
    return null;
  }
}

function head(label, value) {
  console.log(`\n===== ${label} =====`);
  if (value !== undefined) console.log(value);
}

const out = {};
const me = await login();
head('LOGIN', `ok id=${me.id} role=${me.role}`);

const apiPkg = pkgVersion('services/api/package.json');
const rootPkg = pkgVersion('package.json');
head('VERSION', `services/api/package.json=${apiPkg}  root package.json=${rootPkg}`);

// 1) 公开下载清单（download.js 的 DOWNLOAD_FILES 投影）
let r = await call('GET', '/api/download/list');
head('GET /api/download/list', `HTTP ${r.status}\n${JSON.stringify(r.json?.data, null, 2)}`);
out.downloadList = r.json?.data?.files?.map((f) => f.file) ?? [];

// 2) 后台客户端分发（admin.js /api/admin/releases，对象存储列举）
r = await call('GET', '/api/admin/releases');
head(
  'GET /api/admin/releases',
  `HTTP ${r.status} prefix=${r.json?.data?.prefix} files=${r.json?.data?.files?.length} message=${r.json?.data?.message ?? '-'}\n` +
    JSON.stringify((r.json?.data?.files ?? []).slice(0, 40), null, 2),
);
out.adminReleases = r.json?.data?.files ?? [];

// 3) 后台插件列表（前 3 条）
r = await call('GET', '/api/admin/plugins?page=1&pageSize=20');
head(
  'GET /api/admin/plugins?page=1&pageSize=20',
  `HTTP ${r.status} total=${r.json?.data?.total} page=${r.json?.data?.page} pageSize=${r.json?.data?.pageSize} items=${r.json?.data?.items?.length}`,
);
const plugins = r.json?.data?.items ?? [];
out.pluginTotal = r.json?.data?.total ?? 0;
console.log(
  plugins
    .slice(0, 5)
    .map((p) => `  #${p.id} ${p.pluginId} v${p.version} status=${p.status} name=${p.name}`)
    .join('\n') || '  (empty)',
);
if (plugins[0]) {
  console.log(`  first item keys: ${Object.keys(plugins[0]).join(', ')}`);
  console.log(`  has codeJs: ${typeof plugins[0].codeJs === 'string'} len=${plugins[0].codeJs?.length ?? 0}`);
}

// 4) 公开市场列表（客户端读取接口，T1 范围，这里只看现状）
r = await call('GET', '/api/plugins/market');
head(
  'GET /api/plugins/market',
  `HTTP ${r.status} items=${r.json?.data?.items?.length} hasTotal=${'total' in (r.json?.data ?? {})} hasPage=${'page' in (r.json?.data ?? {})}`,
);
out.marketCount = r.json?.data?.items?.length ?? 0;

// 5) 用户列表与详情形状
r = await call('GET', '/api/admin/users?page=1&pageSize=5');
head(
  'GET /api/admin/users?page=1&pageSize=5',
  `HTTP ${r.status} total=${r.json?.data?.total} page=${r.json?.data?.page}\n` +
    JSON.stringify(r.json?.data?.items?.slice(0, 2) ?? [], null, 2),
);
const firstUser = r.json?.data?.items?.[0] ?? null;
if (firstUser) {
  const d = await call('GET', `/api/admin/users/${firstUser.id}`);
  head(
    `GET /api/admin/users/${firstUser.id}`,
    `HTTP ${d.status} keys=${Object.keys(d.json?.data ?? {}).join(', ')}`,
  );
}

// 6) 审计日志里已有的 action 种类（判断能否聚合登录记录）
r = await call('GET', '/api/admin/audit?page=1&pageSize=100');
const actions = [...new Set((r.json?.data?.items ?? []).map((a) => a.action))].sort();
head('GET /api/admin/audit actions', `HTTP ${r.status} total=${r.json?.data?.total}\n  ${actions.join('\n  ')}`);

head('SUMMARY', JSON.stringify(out, null, 2));
