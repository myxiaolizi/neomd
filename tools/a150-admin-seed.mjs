#!/usr/bin/env node
/**
 * AUDIT-150 - admin audit: seeds test data into the ISOLATED audit database.
 * =============================================================================
 * Purpose: give pagination / N+1 / large-table queries a realistic data volume.
 *
 * Hard constraints (enforced in code so a mistake cannot touch production):
 *  - ONLY `neomd_audit150b` is writable. The connection is asserted against
 *    `SELECT DATABASE()` and any mismatch aborts before a single write.
 *  - Only INSERT, plus deleting rows this script itself created (seed_ prefix).
 *  - Idempotent: re-running cleans its own previous rows first.
 *
 * Credentials come from services/api/.env.local (gitignored, points at the
 * isolated DB). This file never prints a password.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from '../services/api/node_modules/mysql2/promise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REQUIRED_DB = 'neomd_audit150b';

/** Minimal .env parser (same semantics as services/api/src/config.js) */
function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const body = text.startsWith('export ') ? text.slice(7).trim() : text;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const k = body.slice(0, eq).trim();
    let v = body.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function dbConfig() {
  const env = {
    ...parseEnvFile(path.join(ROOT, 'services/api/.env')),
    ...parseEnvFile(path.join(ROOT, 'services/api/.env.local')),
  };
  for (const k of Object.keys(process.env)) {
    if (process.env[k] && k.startsWith('DB_')) env[k] = process.env[k];
  }
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
    dateStrings: true,
    multipleStatements: false,
  };
}

/** Target volumes (task requires 5000 rows; other tables sized to trigger N+1 / aggregates) */
export const SEED_PLAN = {
  users: 5000,
  userVaults: 2000,
  shares: 2000,
  publishes: 600,
  shareComments: 1200,
  aiUsage: 20000,
  creditLedger: 5000,
  knowledgeTokens: 600,
  auditLogs: 6000,
  communityPlugins: 300,
  redeemCodes: 400,
};

const SEED_USER_TAG = 'seed_audit150_';
const SEED_SHARE_TITLE = 'Seed share ';
const SEED_COMMENT_BODY = 'seed: comment body ';
const SEED_PLUGIN_PID = 'seed-audit-plugin-';
const SEED_CODE = 'NEOMD-SEED-';

function rnd(n) {
  return crypto.randomInt(0, n);
}
function pick(arr) {
  return arr[rnd(arr.length)];
}
function pad(n, w = 5) {
  return String(n).padStart(w, '0');
}
/** 'YYYY-MM-DD HH:mm:ss' in UTC (matches the pool's timezone:'Z') */
function dt(offsetDays = 0, offsetMinutes = 0) {
  const t = Date.now() - offsetDays * 86400_000 - offsetMinutes * 60_000;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** Chunked multi-row INSERT */
async function batchInsert(conn, table, columns, rows, chunk = 400) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const placeholder = `(${columns.map(() => '?').join(',')})`;
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${slice.map(() => placeholder).join(',')}`;
    await conn.query(sql, slice.flat());
    inserted += slice.length;
  }
  return inserted;
}

async function main() {
  const cfg = dbConfig();
  if (cfg.database !== REQUIRED_DB) {
    throw new Error(`refusing to run: target DB is not ${REQUIRED_DB} (got ${cfg.database})`);
  }
  const conn = await mysql.createConnection(cfg);

  const [whoRows] = await conn.query('SELECT DATABASE() AS db');
  if (whoRows[0].db !== REQUIRED_DB) throw new Error(`refusing to run: connected to ${whoRows[0].db}`);
  console.log(`[seed] target DB confirmed: ${whoRows[0].db}`);

  const t0 = Date.now();
  const summary = {};

  /* ---------------- idempotent cleanup of our own rows ---------------- */
  const [seedUserRows] = await conn.query('SELECT id FROM users WHERE username LIKE ?', [`${SEED_USER_TAG}%`]);
  const seedIds = seedUserRows.map((r) => Number(r.id));
  if (seedIds.length) {
    const inList = seedIds.map(() => '?').join(',');
    for (const t of [
      'user_vaults',
      'shares',
      'publishes',
      'ai_usage',
      'credit_ledger',
      'knowledge_tokens',
      'knowledge_usage',
      'refresh_tokens',
      'user_settings',
      'share_comments',
      'share_annotations',
      'community_plugins',
    ]) {
      await conn.query(`DELETE FROM ${t} WHERE user_id IN (${inList})`, seedIds).catch(() => {});
    }
    await conn.query(`DELETE FROM users WHERE id IN (${inList})`, seedIds);
    console.log(`[seed] cleaned ${seedIds.length} previous test users (+ their child rows)`);
  }
  for (const [t, where] of [
    ['audit_logs', "target LIKE 'seed:%'"],
    ['redeem_codes', `code LIKE '${SEED_CODE}%'`],
    ['release_downloads', "file LIKE 'seed-%'"],
    ['share_comments', `share_id IN (SELECT id FROM shares WHERE title LIKE '${SEED_SHARE_TITLE.trim()}%')`],
    ['community_plugins', `plugin_id LIKE '${SEED_PLUGIN_PID}%'`],
  ]) {
    await conn.query(`DELETE FROM ${t} WHERE ${where}`).catch(() => {});
  }

  const [maxIdRows] = await conn.query('SELECT COALESCE(MAX(id),0) AS m FROM users');
  const baseId = Number(maxIdRows[0].m) + 1000;

  /* ---------------- users ---------------- */
  const userRows = [];
  const HASH_PLACEHOLDER = 'seed-not-a-real-hash'; // pagination/stats only; cannot log in
  for (let i = 0; i < SEED_PLAN.users; i += 1) {
    const n = pad(i);
    const status = i % 37 === 0 ? 'disabled' : 'active';
    const credits = (i * 7) % 5000;
    const days = i % 120; // spread signups across ~120 days
    userRows.push([
      `${SEED_USER_TAG}${n}@audit.local`,
      `${SEED_USER_TAG}${n}`,
      HASH_PLACEHOLDER,
      i % 211 === 0 ? 'admin' : 'user',
      status,
      1073741824 * (1 + (i % 4)),
      dt(days, i % 1440),
      i % 11 === 0 ? null : dt(i % 30, i % 600),
      i % 11 === 0 ? null : `10.${i % 250}.${(i * 3) % 250}.${i % 250}`,
      `SeedNick${n}`,
      null,
      credits,
      null,
      status === 'disabled' ? 'seed audit test ban' : null,
      status === 'disabled' ? dt(1) : null,
      status === 'disabled' ? (i % 2 === 0 ? null : dt(-7)) : null,
    ]);
  }
  summary.users = await batchInsert(
    conn,
    'users',
    [
      'email',
      'username',
      'pass_hash',
      'role',
      'status',
      'quota_bytes',
      'created_at',
      'last_login_at',
      'last_login_ip',
      'nickname',
      'avatar_url',
      'credits',
      'last_daily_grant_date',
      'ban_reason',
      'banned_at',
      'ban_until',
    ],
    userRows,
  );
  console.log(`[seed] users +${summary.users}`);

  const [idsRows] = await conn.query('SELECT id FROM users WHERE username LIKE ? ORDER BY id ASC', [`${SEED_USER_TAG}%`]);
  const ids = idsRows.map((r) => Number(r.id));

  /* ---------------- user_vaults ---------------- */
  const vaultRows = [];
  for (let i = 0; i < SEED_PLAN.userVaults; i += 1) {
    const uid = ids[i % ids.length];
    vaultRows.push([
      uid,
      `seed-vault-${pad(i)}`,
      `SeedVault ${pad(i)}`,
      i % 300,
      1024 * (i % 5000),
      i % 29 === 0 ? 'disabled' : 'active',
      dt(i % 60),
      dt(i % 180),
      dt(i % 60),
      0,
      null,
    ]);
  }
  summary.userVaults = await batchInsert(
    conn,
    'user_vaults',
    ['user_id', 'vault_id', 'name', 'doc_count', 'bytes', 'status', 'last_synced_at', 'created_at', 'updated_at', 'auto_registered', 'auto_registered_at'],
    vaultRows,
  );
  console.log(`[seed] user_vaults +${summary.userVaults}`);

  /* ---------------- shares ---------------- */
  const shareRows = [];
  for (let i = 0; i < SEED_PLAN.shares; i += 1) {
    shareRows.push([
      ids[i % ids.length],
      `seed-doc-${pad(i)}`,
      crypto.randomBytes(16).toString('hex').slice(0, 24),
      `${SEED_SHARE_TITLE}${pad(i)}`,
      i % 3 === 0 ? 'read' : 'comment',
      i % 4 === 0 ? 0 : 1,
      i % 50 === 0 ? dt(-3) : null,
      i % 97,
      dt(i % 200),
      i % 41 === 0 ? dt(i % 30) : null,
    ]);
  }
  summary.shares = await batchInsert(
    conn,
    'shares',
    ['user_id', 'doc_id', 'token', 'title', 'mode', 'allow_comment', 'expires_at', 'view_count', 'created_at', 'revoked_at'],
    shareRows,
  );
  console.log(`[seed] shares +${summary.shares}`);

  /* ---------------- share_comments ---------------- */
  const [shareIdsRows] = await conn.query('SELECT id FROM shares WHERE title LIKE ? ORDER BY id ASC LIMIT 500', [`${SEED_SHARE_TITLE}%`]);
  const shareIds = shareIdsRows.map((r) => Number(r.id));
  const commentRows = [];
  for (let i = 0; i < SEED_PLAN.shareComments && shareIds.length; i += 1) {
    commentRows.push([
      shareIds[i % shareIds.length],
      `Guest${pad(i % 400)}`,
      `${SEED_COMMENT_BODY}${pad(i)}`,
      crypto.createHash('sha256').update(`seed-ip-${i}`).digest('hex').slice(0, 32),
      i % 13 === 0 ? 'hidden' : 'visible',
      dt(i % 90),
    ]);
  }
  summary.shareComments = await batchInsert(
    conn,
    'share_comments',
    ['share_id', 'author_name', 'body', 'ip_hash', 'status', 'created_at'],
    commentRows,
  ).catch(() => 0);
  console.log(`[seed] share_comments +${summary.shareComments}`);

  /* ---------------- publishes ---------------- */
  const pubRows = [];
  for (let i = 0; i < SEED_PLAN.publishes; i += 1) {
    pubRows.push([
      ids[i % ids.length],
      `seed-doc-${pad(i)}`,
      `seed-slug-${pad(i)}`,
      `Seed publish ${pad(i)}`,
      1,
      `https://example.invalid/p/seed-slug-${pad(i)}`,
      `seed/publish-${pad(i)}.html`,
      dt(i % 120),
      i % 19 === 0 ? dt(i % 20) : null,
    ]);
  }
  summary.publishes = await batchInsert(
    conn,
    'publishes',
    ['user_id', 'doc_id', 'slug', 'title', 'rev', 'url', 'oss_key', 'created_at', 'revoked_at'],
    pubRows,
  );
  console.log(`[seed] publishes +${summary.publishes}`);

  /* ---------------- ai_usage ---------------- */
  const providers = ['deepseek', 'qwen', 'zhipu', 'volcengine-ark', 'tencent-hunyuan'];
  const models = ['deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'glm-4-plus', 'doubao-pro-32k'];
  const aiRows = [];
  for (let i = 0; i < SEED_PLAN.aiUsage; i += 1) {
    const ok = i % 9 !== 0;
    aiRows.push([
      ids[i % ids.length],
      pick(providers),
      pick(models),
      100 + (i % 3000),
      50 + (i % 1800),
      ok ? 10 + (i % 400) : 0,
      ok ? 'ok' : 'error',
      ok ? 300 + (i % 5000) : 0,
      ok ? null : pick(['PROVIDER_TIMEOUT', 'PROVIDER_HTTP_429', 'PROVIDER_HTTP_500']),
      dt(i % 45, i % 1440),
    ]);
  }
  summary.aiUsage = await batchInsert(
    conn,
    'ai_usage',
    ['user_id', 'provider', 'model', 'in_tokens', 'out_tokens', 'cost', 'status', 'latency_ms', 'error_code', 'created_at'],
    aiRows,
  );
  console.log(`[seed] ai_usage +${summary.aiUsage}`);

  /* ---------------- credit_ledger ---------------- */
  const kinds = ['recharge', 'consume', 'grant', 'refund'];
  const ledgerRows = [];
  for (let i = 0; i < SEED_PLAN.creditLedger; i += 1) {
    const delta = i % 3 === 0 ? -(1 + (i % 100)) : 10 + (i % 500);
    ledgerRows.push([
      ids[i % ids.length],
      delta,
      Math.max(0, 10000 - Math.abs(delta)),
      pick(kinds),
      `seed:ledger:${pad(i)}`,
      JSON.stringify({ seed: true, note: `seed ledger ${pad(i)}` }),
      dt(i % 60, i % 1440),
    ]);
  }
  summary.creditLedger = await batchInsert(
    conn,
    'credit_ledger',
    ['user_id', 'delta', 'balance_after', 'kind', 'ref', 'detail_json', 'created_at'],
    ledgerRows,
  );
  console.log(`[seed] credit_ledger +${summary.creditLedger}`);

  /* ---------------- knowledge_tokens ---------------- */
  const tokenRows = [];
  for (let i = 0; i < SEED_PLAN.knowledgeTokens; i += 1) {
    tokenRows.push([
      ids[i % ids.length],
      `seed-token-${pad(i)}`,
      crypto.randomBytes(32).toString('hex'),
      `nmd_kb_seed${pad(i)}`.slice(0, 12),
      i % 3 === 0 ? 'write' : 'read',
      i % 5 === 0 ? dt(-30) : i % 7 === 0 ? null : dt(-(i % 200)),
      i % 6 === 0 ? null : dt(i % 300),
      i % 23 === 0 ? dt(i % 40) : null,
      dt(i % 400),
    ]);
  }
  summary.knowledgeTokens = await batchInsert(
    conn,
    'knowledge_tokens',
    ['user_id', 'name', 'token_hash', 'token_prefix', 'scope', 'expires_at', 'last_used_at', 'revoked_at', 'created_at'],
    tokenRows,
  ).catch(() => 0);
  console.log(`[seed] knowledge_tokens +${summary.knowledgeTokens}`);

  /* ---------------- audit_logs ---------------- */
  const actions = [
    'admin.user.update',
    'admin.user.ban',
    'admin.user.unban',
    'admin.user.delete',
    'admin.user.reset_password',
    'admin.share.revoke',
    'admin.plugin.status',
    'admin.config.update',
    'admin.ai.update',
    'auth.login',
  ];
  const auditRows = [];
  for (let i = 0; i < SEED_PLAN.auditLogs; i += 1) {
    auditRows.push([
      ids[i % ids.length],
      pick(actions),
      `seed:${i}`,
      JSON.stringify({ seed: true, idx: i }),
      `10.${i % 250}.${i % 99}.2`,
      dt(i % 90, i % 1440),
    ]);
  }
  summary.auditLogs = await batchInsert(conn, 'audit_logs', ['user_id', 'action', 'target', 'detail_json', 'ip', 'created_at'], auditRows);
  console.log(`[seed] audit_logs +${summary.auditLogs}`);

  /* ---------------- community_plugins ---------------- */
  const cats = ['writing', 'productivity', 'ai', 'theme', 'integration'];
  const statuses = ['published', 'pending', 'rejected', 'disabled'];
  const pluginRows = [];
  for (let i = 0; i < SEED_PLAN.communityPlugins; i += 1) {
    pluginRows.push([
      `${SEED_PLUGIN_PID}${pad(i)}`,
      ids[i % ids.length],
      `Author${pad(i % 200)}`,
      `Seed plugin ${pad(i)}`,
      `1.${i % 10}.0`,
      pick(cats),
      'layers',
      `Seed sample plugin used for admin pagination and review load tests ${pad(i)}`,
      '## Notes\n\nseed data',
      JSON.stringify({ tags: ['seed', `t${i % 7}`] }),
      '// seed plugin\nreturn { mount() {} };',
      pick(statuses),
      i % 500,
      i % 200,
      dt(i % 200),
      dt(i % 200),
    ]);
  }
  summary.communityPlugins = await batchInsert(
    conn,
    'community_plugins',
    ['plugin_id', 'user_id', 'author_name', 'name', 'version', 'category', 'icon', 'description', 'readme_md', 'manifest_json', 'code_js', 'status', 'downloads', 'stars', 'created_at', 'updated_at'],
    pluginRows,
  ).catch(() => 0);
  console.log(`[seed] community_plugins +${summary.communityPlugins}`);

  /* ---------------- redeem_codes ---------------- */
  const codeRows = [];
  for (let i = 0; i < SEED_PLAN.redeemCodes; i += 1) {
    codeRows.push([
      `${SEED_CODE}${pad(i)}`.slice(0, 24),
      100 + (i % 900),
      i % 4 === 0 ? ids[i % ids.length] : null,
      i % 4 === 0 ? dt(i % 30) : null,
      1,
      dt(i % 90),
    ]);
  }
  summary.redeemCodes = await batchInsert(
    conn,
    'redeem_codes',
    ['code', 'credits', 'used_by', 'used_at', 'created_by', 'created_at'],
    codeRows,
  ).catch(() => 0);
  console.log(`[seed] redeem_codes +${summary.redeemCodes}`);

  /* ---------------- index inventory (large-table paging depends on these) ---------------- */
  const [idxRows] = await conn.query(
    `SELECT TABLE_NAME t, INDEX_NAME n, COLUMN_NAME c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('users','ai_usage','audit_logs','credit_ledger','shares','knowledge_tokens')
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [REQUIRED_DB],
  );
  summary.indexes = {};
  for (const r of idxRows) {
    (summary.indexes[r.t] ??= []).push(`${r.n}(${r.c})`);
  }

  const [finalRows] = await conn.query('SELECT COUNT(*) c FROM users');
  summary.finalUserCount = Number(finalRows[0].c);
  summary.baseUserId = baseId;
  summary.elapsedMs = Date.now() - t0;

  await conn.end();

  const outDir = path.join(ROOT, 'docs/AUDIT-150/raw');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'admin-seed.json');
  fs.writeFileSync(outFile, JSON.stringify({ seededAt: new Date().toISOString(), database: REQUIRED_DB, plan: SEED_PLAN, summary }, null, 2), 'utf8');
  console.log(`[seed] done in ${summary.elapsedMs}ms; users total now ${summary.finalUserCount}`);
  console.log(`[seed] result -> ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error('[seed] FAILED:', err?.message || err);
  process.exit(1);
});
