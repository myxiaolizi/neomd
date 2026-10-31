#!/usr/bin/env node
/**
 * 1.4 需求10 取证：admin 用户仓库泛滥 —— 根因调查脚本（**只读**）。
 *
 * 要回答：
 *   1. `user_vaults` 实际有哪些行？创建时间分布？
 *   2. 哪些是测试遗留（名称前缀 / 内容特征 / 零真实文档）？
 *   3. 云端对象前缀里有多少个仓库目录？与 DB 登记是否一致（分裂）？
 *   4. 本地注册表（浏览器 localStorage）里有几条？与云端差多少？
 *   5. `pullVaultList()` / `mergeRemote()` / `attachVaultId()` 的自动附着逻辑
 *      会不会让「云端有但本机没有」的条目无限堆积？
 *
 * 用法：node tools/re14-vault-audit.mjs [--json]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const OUT_DIR = join(REPO, 'docs/shots-140');
const JSON_ONLY = process.argv.includes('--json');

const log = (...a) => {
  if (!JSON_ONLY) console.log(...a);
};
const hr = (t) => log(`\n=== ${t} ===`);

let token = '';
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  token = body?.data?.accessToken ?? '';
  if (!token) throw new Error(`登录失败 ${JSON.stringify(body).slice(0, 200)}`);
  return body.data.user;
}

async function listVaults() {
  const res = await fetch(`${API}/api/vaults`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  return body?.data?.vaults ?? [];
}

/** 列某仓库的对象前缀（只用 docs/ 与 versions/ 两个关键前缀） */
async function listPrefix(vaultId, prefix) {
  try {
    const res = await fetch(
      `${API}/api/storage/list?prefix=${encodeURIComponent(prefix)}&maxKeys=1000`,
      { headers: { authorization: `Bearer ${token}`, 'x-vault-id': vaultId } },
    );
    if (!res.ok) return { error: res.status, objects: [] };
    const body = await res.json();
    return { error: null, objects: body?.data?.objects ?? [] };
  } catch (e) {
    return { error: e.message, objects: [] };
  }
}

/**
 * 测试遗留判定规则（保守：**任何一条命中即标记为 candidate，但最终是否清理要人判断**）。
 *
 * 每类都给「为什么」，因为 admin 是真实账号，误删不可逆。
 */
const RULES = [
  { id: 'name-selftest', test: (v) => /selftest|self-test|qa|test|tmp|temp|demo|probe|re1[0-9]|vaultre|vaultmv/i.test(v.vaultId + ' ' + (v.name ?? '')), why: '名称含测试/临时关键词' },
  { id: 'name-random-id', test: (v) => /^vaultm[a-z0-9]{10,}$/i.test(v.vaultId) && (v.name ?? '') === v.vaultId, why: 'vaultId 是随机串且显示名等于 id（自动注册产物特征）' },
  { id: 'zero-docs', test: (v) => Number(v.docCount ?? 0) === 0, why: 'docCount = 0（空仓库）' },
  { id: 'never-synced', test: (v) => !v.lastSyncedAt, why: '从未同步过（lastSyncedAt 为空）' },
];

/** 明确应保留的仓库（人工白名单，防止规则误杀） */
const PROTECT = [
  { test: (v) => v.vaultId === 'admin', why: '默认主仓库' },
  { test: (v) => /[^\x00-\x7F]/.test(v.name ?? ''), why: '显示名含中文（真实用户命名）' },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const user = await login();
  log(`登录：${user.username} (id=${user.id})`);

  hr('1. DB user_vaults 行数（经 API 口径）');
  const vaults = await listVaults();
  log(`  GET /api/vaults 返回 ${vaults.length} 个仓库`);

  // 直连 DB 拿权威行数（只读）
  let dbRows = null;
  try {
    const poolUrl = `file:///${join(REPO, 'services/api/src/db/pool.js').replace(/\\/g, '/')}`;
    const pool = await import(poolUrl);
    const rows = await pool.query(
      'SELECT vault_id, name, doc_count, bytes, status, last_synced_at, created_at, updated_at FROM user_vaults WHERE user_id = ? ORDER BY created_at ASC',
      [user.id],
    );
    dbRows = rows;
    log(`  DB user_vaults 实际 ${rows.length} 行`);
  } catch (e) {
    log(`  ! 直连 DB 失败（只用 API 口径）：${e.message}`);
  }

  hr('2. 逐个仓库的详细画像');
  const profiles = [];
  for (const v of vaults) {
    const docs = await listPrefix(v.vaultId, 'docs/');
    const versions = await listPrefix(v.vaultId, 'versions/');
    const docIds = new Set(
      docs.objects.map((o) => /^docs\/([^/]+)\//.exec(o.key)?.[1]).filter(Boolean),
    );
    // 抓 manifest 看真实文档路径（判断是否是 selftest 内容）
    const manifests = docs.objects.filter((o) => o.key.endsWith('/manifest.json')).slice(0, 5);
    const samplePaths = [];
    for (const m of manifests) {
      try {
        const r = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(m.key)}`, {
          headers: { authorization: `Bearer ${token}`, 'x-vault-id': v.vaultId },
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.path) samplePaths.push(j.path);
        }
      } catch {
        /* ignore */
      }
    }
    const dbRow = dbRows?.find((r) => r.vault_id === v.vaultId);
    const p = {
      vaultId: v.vaultId,
      name: v.name,
      docCount: Number(v.docCount ?? 0),
      bytes: Number(v.bytes ?? 0),
      status: v.status,
      lastSyncedAt: v.lastSyncedAt ?? null,
      createdAt: dbRow?.created_at ?? null,
      cloudDocCount: docIds.size,
      cloudVersionObjects: versions.objects.length,
      samplePaths,
      hasSelftestContent: samplePaths.some((x) => /selftest|test|probe|re1[0-9]/i.test(x)),
    };
    // 规则判定
    p.matchedRules = [];
    p.protected = null;
    for (const rule of RULES) {
      if (rule.test({ ...v, docCount: p.docCount })) p.matchedRules.push({ id: rule.id, why: rule.why });
    }
    for (const pr of PROTECT) {
      if (pr.test(v)) {
        p.protected = { why: pr.why };
        break;
      }
    }
    p.verdict = p.protected ? 'KEEP(protected)' : p.matchedRules.length ? 'candidate' : 'KEEP';
    profiles.push(p);

    log(`\n  ── ${p.vaultId}`);
    log(`     名称=${JSON.stringify(p.name)}  docs=${p.docCount} bytes=${p.bytes} status=${p.status}`);
    log(`     创建=${p.createdAt ?? '?'}  最后同步=${p.lastSyncedAt ?? '从未'}`);
    log(`     云端：${p.cloudDocCount} 篇文档（${p.cloudVersionObjects} 个版本对象）`);
    if (p.samplePaths.length) log(`     样例路径：${p.samplePaths.join(' | ')}`);
    if (p.hasSelftestContent) log(`     ⚠ 内容含 selftest/test/probe 特征`);
    if (p.matchedRules.length) log(`     命中规则：${p.matchedRules.map((r) => r.id).join(', ')}`);
    if (p.protected) log(`     🔒 受保护：${p.protected.why}`);
    log(`     判定：${p.verdict}`);
  }

  hr('3. 汇总');
  const candidates = profiles.filter((p) => p.verdict === 'candidate');
  const keeps = profiles.filter((p) => p.verdict !== 'candidate');
  log(`  总仓库 ${profiles.length}`);
  log(`  建议清理候选 ${candidates.length}：`);
  for (const c of candidates) {
    log(`     - ${c.vaultId}  (${c.name})  docs=${c.docCount}  规则=${c.matchedRules.map((r) => r.id).join('+')}`);
  }
  log(`  建议保留 ${keeps.length}：`);
  for (const k of keeps) log(`     - ${k.vaultId}  (${k.name})  ${k.protected ? '受保护:' + k.protected.why : '无规则命中'}`);

  hr('4. 云端 vs DB 分裂检查');
  const cloudOnly = [];
  for (const p of profiles) {
    if (p.cloudDocCount > 0 && p.docCount === 0) {
      cloudOnly.push(p.vaultId);
    }
  }
  if (cloudOnly.length) log(`  ⚠ 这些仓库 DB 说 0 篇文档但云端有内容：${cloudOnly.join(', ')}`);
  else log('  ✓ 无「DB 空但云端有内容」的分裂');

  const out = join(OUT_DIR, 're14-vault-audit.json');
  writeFileSync(
    out,
    JSON.stringify(
      { at: new Date().toISOString(), userId: user.id, dbRowCount: dbRows?.length ?? null, apiCount: vaults.length, profiles, candidates: candidates.map((c) => c.vaultId), keeps: keeps.map((k) => k.vaultId) },
      null,
      2,
    ),
    'utf8',
  );
  log(`\n  证据 JSON → ${out}`);
}

await main();
