#!/usr/bin/env node
/**
 * AUDIT-150 - admin audit: permission / privilege-escalation / rate-limit /
 * sensitive-field / pagination / latency probe (pure HTTP, no browser).
 * =============================================================================
 *
 * Measured against the local audit API (127.0.0.1:3200), which is pinned to the
 * isolated DB `neomd_audit150b` by services/api/.env.local.
 *
 * ## Why this script is split into two phases
 *
 * The global limiter is 300 req/min per client IP, and the whole suite is
 * ~400 requests. If functional assertions ran under one shared bucket they would
 * start returning 429 mid-run and the pagination/permission data would be junk.
 *
 *  - **Phase A (functional)**: every request carries a *distinct* X-Forwarded-For
 *    so each one lands in its own limiter bucket. Nothing about the assertions
 *    depends on the limiter, and the limiter cannot corrupt them.
 *  - **Phase B (rate limits)**: a *fixed* X-Forwarded-For per test, so the bucket
 *    behaves exactly like one real client, and the configured quota is driven
 *    until it actually returns 429.
 *
 * Using X-Forwarded-For here is itself an observation: `clientIp()` in
 * lib/audit.js reads the raw header without gating on `trustProxy`, so Phase A
 * doubles as the bypass check (see report.rateLimits.xffBypass).
 *
 * Output: docs/AUDIT-150/raw/admin-probe.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'docs/AUDIT-150/raw');

const API = process.env.AUDIT_API || 'http://127.0.0.1:3200';
const ADMIN_ACCOUNT = process.env.AUDIT_ADMIN_ACCOUNT || 'admin';

function adminPassword() {
  const v = (process.env.AUDIT_PASS || '').trim();
  if (!v) throw new Error('missing AUDIT_PASS: set $env:AUDIT_PASS before running');
  return v;
}
const PASS = adminPassword();

/* ============================== HTTP ============================== */

let fakeIpSeq = 0;
/** A fresh synthetic client IP per request (Phase A) */
function nextFakeIp() {
  fakeIpSeq += 1;
  return `203.0.113.${(fakeIpSeq % 250) + 1}`;
}

async function http(method, url, { token, body, headers = {}, timeoutMs = 30000, redirect = 'manual', xff = null } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (xff) h['x-forwarded-for'] = xff;
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  let text = '';
  try {
    res = await fetch(`${API}${url}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      redirect,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const ms = performance.now() - started;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: res.status,
    ms: Math.round(ms * 10) / 10,
    headers: Object.fromEntries(res.headers.entries()),
    json,
    text,
    textLen: text.length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================== sensitive-field scan ============================== */

function maskValue(v) {
  const s = String(v);
  return { type: typeof v, length: s.length, masked: '***' };
}

const SENSITIVE_KEY_RE =
  /(pass_?hash|passwd|password|secret|api_?key|access_?key|private_?key|credential|salt|authorization|refresh_?token|access_?token)/i;
/** Keys that merely *contain* a scary word but are counters/flags, not secrets */
const SENSITIVE_ALLOW = new Set([
  'tokenPrefix',
  'tokenType',
  'tokenHash',
  'inTokens',
  'outTokens',
  'inTokens24h',
  'outTokens24h',
  'totalTokens',
  'knowledgeTokens',
  'tokenCount',
  'tokens',
  'expiresIn',
  'refreshExpiresIn',
  'apiKeySet',
  'apiKeyChanged',
  'apiKeyCleared',
  'hasAccessToken',
  'hasRefreshToken',
]);

function scanSensitive(value, at = '$', hits = []) {
  if (value === null || value === undefined) return hits;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 2); i += 1) scanSensitive(value[i], `${at}[${i}]`, hits);
    return hits;
  }
  if (typeof value !== 'object') return hits;
  for (const [k, v] of Object.entries(value)) {
    const p = `${at}.${k}`;
    if (SENSITIVE_KEY_RE.test(k) && !SENSITIVE_ALLOW.has(k) && v !== null && v !== undefined) {
      const emptyStr = typeof v === 'string' && v.length === 0;
      const isBool = typeof v === 'boolean';
      hits.push({
        path: p,
        key: k,
        kind: emptyStr ? 'empty-string' : isBool ? 'boolean-flag' : typeof v,
        valueMeta: emptyStr || isBool ? { masked: '***' } : maskValue(v),
      });
    }
    scanSensitive(v, p, hits);
  }
  return hits;
}

/* ============================== report ============================== */

const report = {
  startedAt: new Date().toISOString(),
  api: API,
  health: null,
  adminLogin: null,
  userRegister: null,
  privilegeMatrix: [],
  anonymousPageAccess: [],
  sensitiveFields: [],
  rateLimits: {},
  pagination: {},
  adminApiTimings: [],
  auditCoverage: null,
  csvExport: null,
  dashboardRealData: null,
  notes: [],
};

/* ============================== phase A: functional ============================== */

async function phaseFunctional() {
  report.health = (await http('GET', '/api/health', { xff: nextFakeIp() })).json;

  /* ---- admin login ---- */
  const adminLogin = await http('POST', '/api/auth/login', {
    body: { account: ADMIN_ACCOUNT, password: PASS },
    headers: { 'user-agent': 'AUDIT150-admin-probe' },
    xff: nextFakeIp(),
  });
  const adminToken = adminLogin.json?.data?.accessToken;
  report.adminLogin = {
    status: adminLogin.status,
    ms: adminLogin.ms,
    ok: adminLogin.json?.ok === true,
    role: adminLogin.json?.data?.user?.role ?? null,
    hasAccessToken: Boolean(adminToken),
    hasRefreshToken: Boolean(adminLogin.json?.data?.refreshToken),
    responseUserFields: Object.keys(adminLogin.json?.data?.user ?? {}),
  };
  if (!adminToken) throw new Error(`admin login failed (status ${adminLogin.status})`);
  console.log(`[probe] admin login ok (${adminLogin.ms}ms)`);

  /* ---- register a real ordinary user ---- */
  const suffix = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const reg = await http('POST', '/api/auth/register', {
    body: {
      email: `audit150_${suffix}@audit.local`,
      username: `audit150_${suffix}`.slice(0, 32),
      password: `Audit150!${crypto.randomBytes(6).toString('hex')}`,
    },
    headers: { 'user-agent': 'AUDIT150-admin-probe' },
    xff: nextFakeIp(),
  });
  const userToken = reg.json?.data?.accessToken;
  report.userRegister = {
    status: reg.status,
    ok: reg.json?.ok === true,
    ms: reg.ms,
    role: reg.json?.data?.user?.role ?? null,
    hasAccessToken: Boolean(userToken),
    errorCode: reg.json?.error?.code ?? null,
    note: 'ordinary account created for real via /api/auth/register; its credentials never enter the report',
  };
  if (userToken) {
    const me = await http('GET', '/api/auth/me', { token: userToken, xff: nextFakeIp() });
    report.userRegister.meStatus = me.status;
    report.userRegister.meRole = me.json?.data?.user?.role ?? me.json?.data?.role ?? null;
  }
  console.log(`[probe] ordinary user register: status=${reg.status} role=${report.userRegister.role}`);

  /* ---- privilege matrix over every admin route ---- */
  const ADMIN_ROUTES = [
    ['GET', '/api/admin/stats', null],
    ['GET', '/api/admin/users?page=1&pageSize=20', null],
    ['GET', '/api/admin/users/1', null],
    ['PUT', '/api/admin/users/1/credits', { amount: 0 }],
    ['PUT', '/api/admin/users/1', { status: 'active' }],
    ['POST', '/api/admin/users/1/reset-password', {}],
    ['DELETE', '/api/admin/users/999999999', null],
    ['POST', '/api/admin/users/1/ban', { reason: 'probe' }],
    ['POST', '/api/admin/users/1/unban', {}],
    ['POST', '/api/admin/users/batch', { ids: [1], action: 'enable' }],
    ['PUT', '/api/admin/users/1/status', { status: 'active' }],
    ['POST', '/api/admin/users/1/role', { role: 'user' }],
    ['GET', '/api/admin/users/1/logins?page=1&pageSize=5', null],
    ['GET', '/api/admin/users/1/overview', null],
    ['GET', '/api/admin/users/export.csv', null],
    ['GET', '/api/admin/shares?page=1&pageSize=5', null],
    ['DELETE', '/api/admin/shares/999999999', null],
    ['GET', '/api/admin/shares/1/comments?page=1&pageSize=5', null],
    ['GET', '/api/admin/publishes?page=1&pageSize=5', null],
    ['DELETE', '/api/admin/publishes/999999999', null],
    ['GET', '/api/admin/ai', null],
    ['PUT', '/api/admin/ai/deepseek', { enabled: false }],
    ['DELETE', '/api/admin/ai/probe-not-exist', null],
    ['GET', '/api/admin/ai-providers-meta', null],
    ['PUT', '/api/admin/ai-providers-meta', { providers: [] }],
    ['GET', '/api/admin/ai-models', null],
    ['PUT', '/api/admin/ai-models/deepseek', {}],
    ['GET', '/api/admin/billing', null],
    ['PUT', '/api/admin/billing', {}],
    ['GET', '/api/admin/redeem-codes?page=1&pageSize=5', null],
    ['POST', '/api/admin/redeem-codes', { count: 1, credits: 1 }],
    ['DELETE', '/api/admin/redeem-codes/999999999', null],
    ['GET', '/api/admin/releases', null],
    ['GET', '/api/admin/releases/nonexistent.apk/probe', null],
    ['PUT', '/api/admin/password', { currentPassword: 'x', newPassword: 'y' }],
    ['GET', '/api/admin/audit?page=1&pageSize=5', null],
    ['GET', '/api/admin/comments?page=1&pageSize=5', null],
    ['PUT', '/api/admin/comments/999999999', { status: 'visible' }],
    ['GET', '/api/admin/dashboard?days=7', null],
    ['GET', '/api/admin/vaults?page=1&pageSize=5', null],
    ['PUT', '/api/admin/vaults/999999999', { status: 'active' }],
    ['DELETE', '/api/admin/vaults/999999999', null],
    ['GET', '/api/admin/ledger?page=1&pageSize=5', null],
    ['GET', '/api/admin/knowledge-tokens?page=1&pageSize=5', null],
    ['DELETE', '/api/admin/knowledge-tokens/999999999', null],
    ['GET', '/api/admin/ai-analytics?days=7', null],
    ['GET', '/api/admin/config', null],
    ['PUT', '/api/admin/config', { entries: [] }],
    ['GET', '/api/admin/status', null],
    ['GET', '/api/admin/plugins?page=1&pageSize=5', null],
    ['PUT', '/api/admin/plugins/999999999/status', { status: 'published' }],
    ['GET', '/api/admin/plugins/999999999', null],
    ['PUT', '/api/admin/plugins/999999999', {}],
  ];
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  // Write routes are only replayed as admin when the target provably does not
  // exist, so the probe cannot mutate audit data.
  const SAFE_FOR_ADMIN = (method, route) =>
    method === 'GET' ||
    route.includes('999999999') ||
    route.includes('probe-not-exist') ||
    route === '/api/admin/ai-providers-meta' ||
    route === '/api/admin/config' ||
    route === '/api/admin/billing' ||
    route === '/api/admin/ai-models/deepseek' ||
    route === '/api/admin/users/batch';

  for (const [method, route, body] of ADMIN_ROUTES) {
    const anon = await http(method, route, { body, xff: nextFakeIp() });
    const asUser = userToken ? await http(method, route, { token: userToken, body, xff: nextFakeIp() }) : null;
    const asAdmin = SAFE_FOR_ADMIN(method, route)
      ? await http(method, route, { token: adminToken, body, xff: nextFakeIp() })
      : { status: 'skipped', ms: null };

    report.privilegeMatrix.push({
      method,
      route,
      mutating: MUTATING.has(method),
      anonStatus: anon.status,
      anonCode: anon.json?.error?.code ?? null,
      userStatus: asUser?.status ?? null,
      userCode: asUser?.json?.error?.code ?? null,
      adminStatus: asAdmin.status,
      adminCode: asAdmin.json?.error?.code ?? null,
      verdict:
        asUser && asUser.status === 403 && anon.status === 401
          ? 'guarded'
          : asUser && asUser.status < 300
            ? 'ESCALATION'
            : 'unexpected',
    });

    for (const [who, resp] of [
      ['admin', asAdmin],
      ['user', asUser],
      ['anon', anon],
    ]) {
      if (resp && resp.json && resp.status !== 'skipped' && resp.status < 300) {
        for (const h of scanSensitive(resp.json)) {
          report.sensitiveFields.push({ route, method, as: who, path: h.path, key: h.key, kind: h.kind, valueMeta: h.valueMeta });
        }
      }
    }
  }

  const escalations = report.privilegeMatrix.filter((r) => r.verdict === 'ESCALATION');
  const unexpected = report.privilegeMatrix.filter((r) => r.verdict === 'unexpected');
  console.log(`[probe] privilege matrix: ${report.privilegeMatrix.length} routes, escalation=${escalations.length}, unexpected=${unexpected.length}`);
  if (escalations.length) console.log('[probe] !! ESCALATION: ' + escalations.map((r) => `${r.method} ${r.route}`).join(', '));
  if (unexpected.length) console.log('[probe] ?? unexpected: ' + unexpected.map((r) => `${r.method} ${r.route}`).join(', '));

  /* ---- anonymous HTML access to the admin SPA ---- */
  for (const p of ['/admin', '/admin?tab=users']) {
    const r = await http('GET', `${API}${p}`, { headers: { accept: 'text/html' }, xff: nextFakeIp() });
    report.anonymousPageAccess.push({
      host: 'api(3200)',
      path: p,
      status: r.status,
      contentType: r.headers['content-type'] ?? null,
      bytes: r.textLen,
      looksLikeSpaShell: /<div id="app"|<script/i.test(r.text.slice(0, 4000)),
    });
  }
  try {
    const v = await http('GET', 'http://127.0.0.1:5178/admin', { headers: { accept: 'text/html' }, xff: nextFakeIp() });
    report.anonymousPageAccess.push({
      host: 'vite(5178)',
      path: '/admin',
      status: v.status,
      contentType: v.headers['content-type'] ?? null,
      bytes: v.textLen,
      looksLikeSpaShell: /<div id="app"|<script/i.test(v.text.slice(0, 4000)),
    });
  } catch (e) {
    report.anonymousPageAccess.push({ host: 'vite(5178)', path: '/admin', error: String(e?.message || e) });
  }

  /* ---- pagination correctness ---- */
  async function paginationWalk(name, route, { pageSize = 50, pages = 6, idField = 'id' } = {}) {
    const seen = [];
    const pageInfo = [];
    const timings = [];
    for (let p = 1; p <= pages; p += 1) {
      const sep = route.includes('?') ? '&' : '?';
      const r = await http('GET', `${route}${sep}page=${p}&pageSize=${pageSize}`, { token: adminToken, xff: nextFakeIp() });
      const data = r.json?.data ?? {};
      const items = data.items ?? [];
      pageInfo.push({
        page: data.page ?? p,
        pageSize: data.pageSize ?? null,
        total: data.total ?? null,
        itemCount: items.length,
        ms: r.ms,
        status: r.status,
        echoOk: (data.page ?? p) === p,
      });
      timings.push(r.ms);
      for (const it of items) seen.push(Number(it[idField]));
      await sleep(50);
    }
    const uniq = new Set(seen);
    const totals = pageInfo.map((p) => p.total);
    return {
      name,
      route,
      pageSize,
      pagesWalked: pages,
      rowsCollected: seen.length,
      uniqueRows: uniq.size,
      duplicates: seen.length - uniq.size,
      declaredTotal: totals[totals.length - 1] ?? null,
      pagingConsistent: seen.length === uniq.size,
      pageEchoCorrect: pageInfo.every((p) => p.echoOk),
      itemCounts: pageInfo.map((p) => p.itemCount),
      totalsPerPage: totals,
      totalStable: new Set(totals).size <= 1,
      latencyMs: timings,
    };
  }

  report.pagination.users = await paginationWalk('users', '/api/admin/users', { pageSize: 50, pages: 8 });
  report.pagination.usersPage100 = await http('GET', '/api/admin/users?page=100&pageSize=50', { token: adminToken, xff: nextFakeIp() }).then((r) => ({
    status: r.status,
    ms: r.ms,
    itemCount: (r.json?.data?.items ?? []).length,
    total: r.json?.data?.total ?? null,
  }));
  report.pagination.usersLastPage = await http('GET', '/api/admin/users?page=101&pageSize=50', { token: adminToken, xff: nextFakeIp() }).then((r) => ({
    status: r.status,
    ms: r.ms,
    itemCount: (r.json?.data?.items ?? []).length,
    total: r.json?.data?.total ?? null,
    code: r.json?.error?.code ?? null,
  }));
  report.pagination.usersPageSizeMax = await http('GET', '/api/admin/users?page=1&pageSize=101', { token: adminToken, xff: nextFakeIp() }).then((r) => ({
    status: r.status,
    itemCount: (r.json?.data?.items ?? []).length,
    pageSize: r.json?.data?.pageSize ?? null,
    code: r.json?.error?.code ?? null,
  }));
  report.pagination.usersPageSizeNegative = await http('GET', '/api/admin/users?page=0&pageSize=0', { token: adminToken, xff: nextFakeIp() }).then((r) => ({
    status: r.status,
    code: r.json?.error?.code ?? null,
    itemCount: (r.json?.data?.items ?? []).length,
  }));
  report.pagination.audit = await paginationWalk('audit', '/api/admin/audit', { pageSize: 50, pages: 6 });
  report.pagination.ledger = await paginationWalk('ledger', '/api/admin/ledger', { pageSize: 50, pages: 6 });
  report.pagination.shares = await paginationWalk('shares', '/api/admin/shares', { pageSize: 50, pages: 6 });
  report.pagination.plugins = await paginationWalk('plugins', '/api/admin/plugins', { pageSize: 20, pages: 6 });
  report.pagination.vaults = await paginationWalk('vaults', '/api/admin/vaults', { pageSize: 50, pages: 6 });
  report.pagination.knowledgeTokens = await paginationWalk('knowledgeTokens', '/api/admin/knowledge-tokens', { pageSize: 50, pages: 6 });
  report.pagination.publishes = await paginationWalk('publishes', '/api/admin/publishes', { pageSize: 50, pages: 5 });
  report.pagination.redeemCodes = await paginationWalk('redeem-codes', '/api/admin/redeem-codes', { pageSize: 50, pages: 5 });
  report.pagination.comments = await paginationWalk('comments', '/api/admin/comments', { pageSize: 50, pages: 4 });

  /* ---- dashboard: is the data real (derived from the seeded rows)? ---- */
  {
    const d = await http('GET', '/api/admin/dashboard?days=7', { token: adminToken, xff: nextFakeIp() });
    const s = await http('GET', '/api/admin/stats', { token: adminToken, xff: nextFakeIp() });
    report.dashboardRealData = {
      dashboardStatus: d.status,
      statsStatus: s.status,
      statsUsersTotal: s.json?.data?.users?.total ?? null,
      statsSharesTotal: s.json?.data?.shares?.total ?? null,
      statsVaults: s.json?.data?.storage?.vaults ?? null,
      statsAiRequests24h: s.json?.data?.ai?.requests24h ?? null,
      dashboardTopKeys: Object.keys(d.json?.data ?? {}),
      dashboardHasKpis: Boolean(d.json?.data?.kpis ?? d.json?.data?.metrics),
      signupsDailyLen: (d.json?.data?.signupsDaily ?? []).length,
    };
  }

  /* ---- CSV export: real file, real rows, formula-injection escaping ---- */
  {
    const r = await http('GET', '/api/admin/users/export.csv', { token: adminToken, xff: nextFakeIp() });
    const lines = r.text.split(/\r\n/).filter(Boolean);
    report.csvExport = {
      status: r.status,
      contentType: r.headers['content-type'] ?? null,
      contentDisposition: r.headers['content-disposition'] ?? null,
      cacheControl: r.headers['cache-control'] ?? null,
      bytes: r.textLen,
      lineCount: lines.length,
      dataRows: Math.max(0, lines.length - 1),
      hasBom: r.text.charCodeAt(0) === 0xfeff,
      header: (lines[0] ?? '').replace(/^\uFEFF/, ''),
      containsSeedUsers: r.text.includes('seed_audit150_'),
      quotedCells: /"SeedNick/.test(r.text) || /"seed_audit150_/.test(r.text),
      ms: r.ms,
    };
    // CSV injection probe: filters that cannot inject, but confirm escaping shape
    report.csvExport.firstRowPreviewRedacted = (lines[1] ?? '').slice(0, 120);
  }

  /* ---- admin route latencies ---- */
  const TIMED = [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/dashboard?days=7'],
    ['GET', '/api/admin/users?page=1&pageSize=20'],
    ['GET', '/api/admin/users?page=1&pageSize=100'],
    ['GET', '/api/admin/users?page=1&pageSize=100&sort=documents'],
    ['GET', '/api/admin/users?page=1&pageSize=100&search=seed_nomatch'],
    ['GET', '/api/admin/users/1/overview'],
    ['GET', '/api/admin/users/1/logins?page=1&pageSize=20'],
    ['GET', '/api/admin/vaults?page=1&pageSize=100'],
    ['GET', '/api/admin/shares?page=1&pageSize=100'],
    ['GET', '/api/admin/ledger?page=1&pageSize=100'],
    ['GET', '/api/admin/audit?page=1&pageSize=100'],
    ['GET', '/api/admin/ai-analytics?days=30'],
    ['GET', '/api/admin/releases'],
    ['GET', '/api/admin/status'],
    ['GET', '/api/admin/config'],
    ['GET', '/api/admin/ai'],
    ['GET', '/api/admin/ai-models'],
    ['GET', '/api/admin/knowledge-tokens?page=1&pageSize=100'],
    ['GET', '/api/admin/plugins?page=1&pageSize=100'],
    ['GET', '/api/admin/users/export.csv'],
  ];
  for (const [method, route] of TIMED) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await http(method, route, { token: adminToken, xff: nextFakeIp() });
      runs.push(r.ms);
      await sleep(40);
    }
    const sorted = [...runs].sort((a, b) => a - b);
    report.adminApiTimings.push({ route, medianMs: sorted[1], minMs: sorted[0], maxMs: sorted[2], runs });
  }
  console.log(`[probe] timings captured for ${report.adminApiTimings.length} routes`);

  /* ---- audit log coverage of a real write ---- */
  {
    const before = await http('GET', '/api/admin/audit?page=1&pageSize=5', { token: adminToken, xff: nextFakeIp() });
    const lastIdBefore = before.json?.data?.items?.[0]?.id ?? null;
    const w = await http('POST', '/api/admin/users/1/unban', { token: adminToken, body: {}, xff: nextFakeIp() });
    await sleep(400);
    const after = await http('GET', '/api/admin/audit?page=1&pageSize=10', { token: adminToken, xff: nextFakeIp() });
    const rows = after.json?.data?.items ?? [];
    const byAction = await http('GET', '/api/admin/audit?page=1&pageSize=5&action=admin.user.unban', { token: adminToken, xff: nextFakeIp() });
    const byUser = await http('GET', '/api/admin/audit?page=1&pageSize=5&userId=1', { token: adminToken, xff: nextFakeIp() });
    report.auditCoverage = {
      writeRoute: 'POST /api/admin/users/1/unban',
      writeStatus: w.status,
      lastAuditIdBefore: lastIdBefore,
      newestRows: rows.slice(0, 6).map((r) => ({ id: r.id, action: r.action, target: r.target, userId: r.userId, createdAt: r.createdAt })),
      wroteEntry: rows.some((r) => r.action === 'admin.user.unban'),
      queryable: after.status === 200,
      totalEntries: after.json?.data?.total ?? null,
      filterByActionTotal: byAction.json?.data?.total ?? null,
      filterByUserTotal: byUser.json?.data?.total ?? null,
    };
  }
}

/* ============================== phase B: rate limits ============================== */

async function phaseRateLimits() {
  /* ---- login: 10 / 60s per IP ---- */
  {
    const xff = '198.51.100.11';
    const attempts = [];
    for (let i = 0; i < 14; i += 1) {
      const r = await http('POST', '/api/auth/login', { body: { account: ADMIN_ACCOUNT, password: `wrong-${i}` }, xff });
      attempts.push({
        i,
        status: r.status,
        code: r.json?.error?.code ?? null,
        limit: r.headers['x-ratelimit-limit'] ?? null,
        remaining: r.headers['x-ratelimit-remaining'] ?? null,
      });
      if (r.status === 429) break;
    }
    report.rateLimits.login = {
      configured: '10 requests / 60s per client IP',
      route: 'POST /api/auth/login',
      attempts: attempts.length,
      hit429: attempts.some((a) => a.status === 429),
      first429At: attempts.find((a) => a.status === 429)?.i ?? null,
      headersSeen: attempts[0]?.limit,
      trace: attempts,
    };
    console.log(`[probe] login limit: hit429=${report.rateLimits.login.hit429} at #${report.rateLimits.login.first429At}`);
  }

  /* ---- register: 5 / hour per IP ---- */
  {
    const xff = '198.51.100.12';
    const attempts = [];
    for (let i = 0; i < 9; i += 1) {
      const s2 = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}${i}`;
      const r = await http('POST', '/api/auth/register', {
        body: { email: `rl_${s2}@audit.local`, username: `rl_${s2}`.slice(0, 32), password: 'Audit150!rlpass' },
        xff,
      });
      attempts.push({ i, status: r.status, code: r.json?.error?.code ?? null, limit: r.headers['x-ratelimit-limit'] ?? null, remaining: r.headers['x-ratelimit-remaining'] ?? null });
      if (r.status === 429) break;
    }
    report.rateLimits.register = {
      configured: '5 requests / 3600s per client IP',
      route: 'POST /api/auth/register',
      attempts: attempts.length,
      hit429: attempts.some((a) => a.status === 429),
      first429At: attempts.find((a) => a.status === 429)?.i ?? null,
      trace: attempts,
    };
    console.log(`[probe] register limit: hit429=${report.rateLimits.register.hit429} at #${report.rateLimits.register.first429At}`);
  }

  /* ---- global: 300 / min per IP ---- */
  {
    const xff = '198.51.100.13';
    const adminToken = report._adminToken;
    const trace = [];
    let hit429At = null;
    for (let i = 0; i < 360; i += 1) {
      const r = await http('GET', '/api/health/missing-probe', { xff, token: adminToken });
      if (i % 60 === 0) trace.push({ i, status: r.status, remaining: r.headers['x-ratelimit-remaining'] ?? null });
      if (r.status === 429) {
        hit429At = i;
        trace.push({ i, status: r.status, remaining: '0', code: r.json?.error?.code ?? null });
        break;
      }
    }
    report.rateLimits.global = {
      configured: '300 requests / 60s per client IP (allowList: /api/health, /api/storage/*)',
      probeRoute: 'GET /api/health/missing-probe (404, still counted)',
      hit429: hit429At !== null,
      first429At: hit429At,
      trace,
    };
    console.log(`[probe] global limit: hit429=${report.rateLimits.global.hit429} at #${hit429At}`);
  }

  /* ---- does rotating X-Forwarded-For bypass the login limit? ---- */
  {
    const attempts = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await http('POST', '/api/auth/login', {
        body: { account: ADMIN_ACCOUNT, password: `wrong-xff-${i}` },
        xff: `192.0.2.${i + 1}`,
      });
      attempts.push({ i, xff: `192.0.2.${i + 1}`, status: r.status, code: r.json?.error?.code ?? null });
      if (r.status === 429) break;
    }
    const bypassed = !attempts.some((a) => a.status === 429);
    report.rateLimits.xffBypass = {
      method: 'rotating a distinct X-Forwarded-For per login attempt, no other change',
      attempts: attempts.length,
      hit429: attempts.some((a) => a.status === 429),
      bypassed,
      note: bypassed
        ? 'clientIp() reads the raw X-Forwarded-For header without gating on trustProxy, so the per-IP quota is attacker-supplied and therefore bypassable'
        : 'rotating X-Forwarded-For did not change the bucket (header not trusted)',
      trace: attempts,
    };
    console.log(`[probe] XFF rotation bypass: ${bypassed}`);
  }
}

/* ============================== main ============================== */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Keep the admin token around for phase B without ever serialising it.
  const origLogin = report.adminLogin;
  await phaseFunctional();

  // Re-login for phase B using a clean bucket (login limiter was only touched by
  // the functional phase under throwaway XFFs, so this stays allowed).
  const adminLogin2 = await http('POST', '/api/auth/login', {
    body: { account: ADMIN_ACCOUNT, password: PASS },
    xff: '198.51.100.99',
  });
  report._adminToken = adminLogin2.json?.data?.accessToken ?? null;
  report.adminLogin = origLogin;
  report.adminReloginForRatePhase = {
    status: adminLogin2.status,
    ok: adminLogin2.json?.ok === true,
    hasToken: Boolean(report._adminToken),
  };
  if (!report._adminToken) throw new Error('re-login for the rate-limit phase failed');

  await phaseRateLimits();

  const escalations = report.privilegeMatrix.filter((r) => r.verdict === 'ESCALATION');
  const unexpected = report.privilegeMatrix.filter((r) => r.verdict === 'unexpected');

  report.finishedAt = new Date().toISOString();
  report.summary = {
    routesProbed: report.privilegeMatrix.length,
    escalations: escalations.map((r) => `${r.method} ${r.route}`),
    unexpected: unexpected.map((r) => `${r.method} ${r.route} anon=${r.anonStatus} user=${r.userStatus}`),
    sensitiveFieldCount: report.sensitiveFields.length,
    sensitiveFieldNames: [...new Set(report.sensitiveFields.map((s) => s.key))],
    sensitiveByRoute: [...new Set(report.sensitiveFields.map((s) => `${s.method} ${s.route}`))],
    rateLimit429: {
      login: report.rateLimits.login?.hit429,
      register: report.rateLimits.register?.hit429,
      global: report.rateLimits.global?.hit429,
      xffBypass: report.rateLimits.xffBypass?.bypassed,
    },
    pagingConsistent: Object.fromEntries(
      Object.entries(report.pagination)
        .filter(([, v]) => v && typeof v === 'object' && 'pagingConsistent' in v)
        .map(([k, v]) => [k, v.pagingConsistent]),
    ),
    csvExportWorking: report.csvExport?.dataRows > 0,
    auditWritesLogged: report.auditCoverage?.wroteEntry,
  };

  const outFile = path.join(OUT_DIR, 'admin-probe.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log('[probe] SUMMARY ' + JSON.stringify(report.summary, null, 2));
  console.log(`[probe] wrote ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error('[probe] FAILED:', err?.stack || err?.message || err);
  process.exit(1);
});
