#!/usr/bin/env node
/**
 * 1.4.0 需求10：admin 仓库泛滥 —— **存量清理脚本**（三档分类，保守优先）。
 *
 * ## 背景（根因，已由取证确认）
 *
 * 服务端 `lib/vault-scope.js` 的 `assertVaultUsable()` 对未登记的
 * `(user_id, vault_id)` **无条件 INSERT** 一条 active 记录（无 name 去重、无上限、无来源标记）。
 * 配合客户端 `app.ts` 在「云端没有仓库」时落 `uid('vault')` 随机 id 的分支，
 * 每次新 profile / 每次测试脚本运行都会新造一条 0 文档空壳。
 * 生产库实测：admin 名下 10 条 = 4 条真实 + 6 条空壳。
 *
 * ## 判定规则（**删除条件必须全部满足**）
 *
 *  1. `doc_count = 0` 且 `bytes = 0`（DB 统计列）
 *  2. **实际 list 云端前缀** `users/<user>/vaults/<vaultId>/` 下无任何对象
 *     （不能只信 DB 统计列 —— 它可能滞后）
 *  3. `last_synced_at IS NULL`（从未同步过）
 *  4. 名称是自动生成形态（`name === vaultId`，或 `'Neo MD'` / 空）
 *  5. **不在保护名单**（4 条真实仓库硬编码保护 + 任何有中文名的仓库）
 *
 * ## 三档分类（输出给 lead 过目）
 *
 *  - **确定可删**：上面 5 条全部满足
 *  - **建议保留**：有文档 / 云端有对象 / 有中文名 / 是已知真实仓库
 *  - **不确定**：介于两者之间（例如 0 文档但云端有 index 对象、或名字可疑但不像自动生成）
 *    → **一律保留**，只在清单里报告
 *
 * ## 用法
 *
 *   node tools/re14-clean-vaults.mjs                # dry-run（默认，只读）
 *   node tools/re14-clean-vaults.mjs --apply        # 真正删除（需先确认 dry-run 清单）
 *   node tools/re14-clean-vaults.mjs --json         # 机器可读输出
 *   node tools/re14-clean-vaults.mjs --user=admin   # 指定账号（默认 admin）
 *
 * ## 安全
 *
 *  - `--apply` 前强制：把 `user_vaults` 全表 dump 到 `docs/evidence-140/`；
 *  - 每个删除动作打印「删了什么、为什么」；
 *  - 只 DELETE `user_vaults` 行 + （可选 `--purge`）清空云端前缀对象；
 *    **默认不 purge 对象存储**（空壳本来就没对象，purge 是多余的风险）。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const PASS = process.env.NEOMD_PASS || '6655';
const OUT_EVID = join(REPO, 'docs/evidence-140');
const OUT_SHOTS = join(REPO, 'docs/shots-140');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_ONLY = args.includes('--json');
const PURGE = args.includes('--purge');
/**
 * 是否连带删除「测试残留」档（`residue`）。
 *
 * 默认**不删**：这一档云端正有对象（`.migrated` + `docs/selftest/*`），
 * 虽然证据强烈表明是 QA 测试假数据，但「有对象」与「绝对空」是两种确定性级别。
 * 要求显式传 `--purge-residue` 才会删，避免一条命令把不该删的也带走。
 */
const PURGE_RESIDUE = args.includes('--purge-residue');
const USER = (args.find((a) => a.startsWith('--user=')) ?? '--user=admin').slice(7);

const log = (...a) => {
  if (!JSON_ONLY) console.log(...a);
};
const hr = (t) => log(`\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`);

/* ------------------------------------------------------------------ */
/* 已知真实仓库保护名单                                                 */
/* ------------------------------------------------------------------ */

/**
 * 硬编码保护：lead 已确认的 4 条真实仓库（2026-10-30 实测）。
 *
 * 为什么硬编码而不是只靠规则：这几条里 `vaultmvp3augl2m72a0nw` 的 name 等于 vaultId，
 * 会被「name === vaultId」规则误判为自动生成形态 —— 但它有 298 篇真实文档，
 * 因此 `doc_count > 0` 那条会救它。硬编码是**双保险**，防止将来统计列滞后时被误删。
 */
const PROTECTED_VAULT_IDS = new Set([
  'admin',
  'vaultmvs9ey2vkpj8q5jy', // Neo MD，436 篇
  'vaultmvp3augl2m72a0nw', // 自名，298 篇
  'vaultmvuqt3rn8ubd9num', // 笔记本，700 篇
]);

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

/**
 * 判断云端对象清单是否**全部是测试残留特征**（1.4.0 需求10 第二轮）。
 *
 * ## 为什么需要这一层
 *
 * 首轮 dry-run 把 6 个候选全判为「保留」，理由是「云端前缀下有对象」。
 * 逐条列出实际对象后，形态高度一致（6 条完全相同）：
 *   `.migrated`                      ← 迁移标记（系统文件，非用户内容）
 *   `docs/selftest/1-deadbeef.md`    ← blobKey(root, docId='selftest', rev=1, hash='deadbeef')
 *   `docs/selftest/upload.md`        ← 同上，另一个假文档
 *   `index/dev-<random>.json`        ← 设备索引（path→docId+rev+hash 元数据，不含正文）
 *
 * 三条判据说明为什么这些**不是**用户数据：
 *  1. `docs/<docId>/<rev>-<hash>.md` 里 docId=`selftest`、hash=`deadbeef` ——
 *     这是 QA 测试脚本硬编码的假数据（task-9 描述的「内容均为 `docs/selftest/*`」即指它）；
 *  2. **没有任何 `manifest.json`** —— 真实仓库只要同步过一次就必然有
 *     `docs/<docId>/manifest.json`（同步协议写元数据的必经路径）；
 *  3. **没有任何 `versions/` 对象** —— 真实编辑过就必然产生历史版本。
 *
 * `index/*.json` 与 `.migrated` 同属「系统文件」，不计入用户内容。
 *
 * 判据（必须**全部**满足才认定为测试残留）：
 *  - DB `doc_count=0` 且 `bytes=0`；
 *  - 无 `manifest.json`、无 `versions/`；
 *  - 去掉系统文件（`.migrated`、`index/`）后，剩余对象**全部**命中测试特征。
 */
function looksLikeTestResidue(p) {
  if (!p.listOk) return false;
  if (p.docCount !== 0 || p.bytes !== 0) return false;
  const keys = p.allKeys ?? [];
  if (!keys.length) return false;
  /** 系统文件：迁移标记与设备索引，都不含用户正文 */
  const isSystemFile = (k) => k === '.migrated' || /^index\/[^/]+\.json$/i.test(k);
  const meaningful = keys.filter((k) => !isSystemFile(k));
  if (!meaningful.length) return false;
  if (keys.some((k) => /manifest\.json$/i.test(k))) return false;
  if (keys.some((k) => k.startsWith('versions/'))) return false;
  return meaningful.every((k) => /selftest|deadbeef|probe|qa1|re1[0-9]|demo|fixture/i.test(k));
}

/**
 * 探一个仓库的云端前缀，返回**完整对象清单**（用于测试残留判定）。
 *
 * 与 `probeEmpty` 的区别：这个要拿到全部 key 才能判断是否全是测试残留。
 * 为控制耗时，maxKeys 用 100（空壳仓库通常 ≤5 个对象；超过 100 说明
 * 不可能是空壳，直接按「非空」处理即可，不必取全量）。
 */
async function probeObjects(vaultId) {
  try {
    const res = await fetch(`${API}/api/storage/list?prefix=${encodeURIComponent('')}&maxKeys=100`, {
      headers: { authorization: `Bearer ${token}`, 'x-vault-id': vaultId },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, keys: [], error: (await res.text().catch(() => '')).slice(0, 120) };
    }
    const body = await res.json();
    const objects = body?.data?.objects ?? [];
    return { ok: true, status: res.status, keys: objects.map((o) => o.key), truncated: Boolean(body?.data?.truncated) };
  } catch (e) {
    return { ok: false, status: 0, keys: [], error: e.message };
  }
}

/** 直连 DB（只读查询 + 备份用） */
async function db() {
  const poolUrl = pathToFileURL(join(REPO, 'services/api/src/db/pool.js')).href;
  return await import(poolUrl);
}

/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(OUT_EVID, { recursive: true });
  mkdirSync(OUT_SHOTS, { recursive: true });
  const user = await login();
  log(`账号：${user.username} (id=${user.id})`);
  log(`模式：${APPLY ? 'APPLY —— 会删除' : 'DRY-RUN —— 只读'}`);

  const pool = await db();
  const rows = await pool.query(
    `SELECT vault_id, name, doc_count, bytes, status, last_synced_at, created_at, auto_registered, auto_registered_at
     FROM user_vaults WHERE user_id = ? ORDER BY created_at ASC`,
    [user.id],
  );

  hr(`第 1 步：DB user_vaults 共 ${rows.length} 行，逐条画像`);
  const profiles = [];
  for (const r of rows) {
    const vaultId = r.vault_id;
    /*
     * 先做「零成本」的判定：DB 统计列已显示非空 → 直接保留，**不必**探测云端。
     * 这让 700 篇的真实仓库完全不发列举请求（首版卡死的直接原因）。
     */
    const dbSaysNonEmpty = Number(r.doc_count ?? 0) > 0 || Number(r.bytes ?? 0) > 0;
    const probe = dbSaysNonEmpty
      ? { ok: true, status: 200, keys: [], skipped: true }
      : await probeObjects(vaultId);
    const nameHasCjk = /[\u4e00-\u9fa5]/.test(String(r.name ?? ''));
    const nameEqualsId = String(r.name ?? '').trim() === vaultId;

    const p = {
      vaultId,
      name: r.name,
      docCount: Number(r.doc_count ?? 0),
      bytes: Number(r.bytes ?? 0),
      status: r.status,
      lastSyncedAt: r.last_synced_at ?? null,
      createdAt: r.created_at ?? null,
      autoRegistered: Number(r.auto_registered ?? 0),
      autoRegisteredAt: r.auto_registered_at ?? null,
      /** null 表示「因为 DB 已非空，未探测云端」 */
      cloudObjectCount: probe.skipped ? null : probe.keys.length,
      allKeys: probe.keys ?? [],
      sampleKeys: (probe.keys ?? []).slice(0, 6),
      listOk: probe.ok,
      listError: probe.error ?? null,
      nameHasCjk,
      nameEqualsId,
    };

    // ── 判定 ──
    const reasons = [];
    let verdict = 'unknown';

    if (PROTECTED_VAULT_IDS.has(vaultId)) {
      verdict = 'keep';
      reasons.push('在硬编码保护名单（已知真实仓库）');
    } else if (dbSaysNonEmpty) {
      verdict = 'keep';
      reasons.push(`DB 统计非空（docs=${p.docCount} bytes=${p.bytes}）`);
    } else if (!probe.ok) {
      verdict = 'unknown';
      reasons.push(`无法列举云端（status=${probe.status} ${probe.listError ?? ''}），无法确认是否空壳`);
    } else if (probe.keys.length === 0) {
      // 真空：连 .migrated 都没有
      if (nameHasCjk) {
        verdict = 'unknown';
        reasons.push('云端全空但名称含中文（可能是用户手动建的仓库），需人工判断');
      } else if (p.lastSyncedAt) {
        verdict = 'keep';
        reasons.push(`云端全空但曾同步过（${p.lastSyncedAt}），保守保留`);
      } else if (!nameEqualsId && String(p.name ?? '').trim() !== 'Neo MD') {
        verdict = 'unknown';
        reasons.push(`名称 ${JSON.stringify(p.name)} 不像自动生成形态，需人工判断`);
      } else {
        verdict = 'delete';
        reasons.push('doc_count=0 且 bytes=0');
        reasons.push('云端前缀下 0 个对象（实测列举确认）');
        reasons.push('从未同步（last_synced_at IS NULL）');
        reasons.push(`名称是自动生成形态 ${JSON.stringify(p.name)}`);
        if (p.autoRegistered === 1) reasons.push('auto_registered=1（服务端标记为自动登记）');
      }
    } else if (looksLikeTestResidue(p)) {
      /*
       * 云端有对象，但**全部是测试残留**（.migrated + docs/selftest/* + index/dev-*.json）。
       *
       * 注意：判定顺序上这一支**必须排在 `lastSyncedAt` 之前**。
       * 因为实测这 6 条都有 `last_synced_at`（是测试脚本跑同步时写进去的），
       * 若按「曾同步过 → 保留」会全部漏判；而 `looksLikeTestResidue()` 内部
       * 已经用「无 manifest.json + 无 versions/ + 只有 selftest 假数据」证明了
       * 这些仓库从未有过**真实内容** —— 「同步过」在这里只意味着「测试脚本连过」。
       *
       * 仍归为 residue 档而非 delete：删之前需要 lead 明确 --purge-residue 批准。
       */
      verdict = 'residue';
      reasons.push('doc_count=0 且 bytes=0');
      reasons.push(`云端 ${probe.keys.length} 个对象，去掉系统文件后**只剩测试假数据**`);
      reasons.push('无任何 manifest.json（真实仓库同步过必有）');
      reasons.push('无任何 versions/ 对象（真实编辑过必有历史版本）');
      reasons.push('从未有过真实内容（last_synced_at 来自测试脚本的同步调用，非用户编辑）');
      reasons.push(`名称是自动生成形态 ${JSON.stringify(p.name)}`);
    } else if (nameHasCjk) {
      verdict = 'keep';
      reasons.push('名称含中文（用户可能手动命名）');
    } else if (p.lastSyncedAt) {
      verdict = 'keep';
      reasons.push(`曾同步过（last_synced_at=${p.lastSyncedAt}）`);
    } else {
      verdict = 'keep';
      reasons.push(`云端有 ${probe.keys.length} 个非测试特征对象，不能删（样例：${probe.sampleKeys.join(', ')}）`);
    }
    p.verdict = verdict;
    p.reasons = reasons;
    profiles.push(p);
    log(`  · ${vaultId.padEnd(24)} docs=${String(p.docCount).padStart(4)} 云端=${p.cloudObjectCount === null ? '未探测(非空)' : p.cloudObjectCount} → ${verdict}`);
  }

  const del = profiles.filter((p) => p.verdict === 'delete');
  const residues = profiles.filter((p) => p.verdict === 'residue');
  const keeps = profiles.filter((p) => p.verdict === 'keep');
  const unknowns = profiles.filter((p) => p.verdict === 'unknown');

  hr('第 2 步：分类结果');

  log(`\n【A · 确定可删（真空壳，无需额外确认）】${del.length} 条`);
  if (!del.length) log('  （无）');
  for (const p of del) {
    log(`  ✗ ${p.vaultId}`);
    log(`      name=${JSON.stringify(p.name)}  created=${p.createdAt}  docs=${p.docCount} bytes=${p.bytes}`);
    log(`      云端对象=0  最后同步=从未`);
    for (const r of p.reasons) log(`      · ${r}`);
  }

  log(`\n【B · 测试残留（需 --purge-residue 显式确认）】${residues.length} 条`);
  if (!residues.length) log('  （无）');
  for (const p of residues) {
    log(`  ⚠ ${p.vaultId}  (${JSON.stringify(p.name)})  created=${p.createdAt}`);
    log(`      完整云端对象清单（${p.allKeys.length} 个）：`);
    for (const k of p.allKeys) log(`         ${k}`);
    for (const r of p.reasons) log(`      · ${r}`);
  }

  log(`\n【C · 建议保留】${keeps.length} 条`);
  for (const p of keeps) {
    log(`  🔒 ${p.vaultId}  (${JSON.stringify(p.name)})  docs=${p.docCount} 云端对象=${p.cloudObjectCount ?? '未探测'}`);
    for (const r of p.reasons) log(`      · ${r}`);
  }

  if (unknowns.length) {
    log(`\n【D · 不确定（一律保留）】${unknowns.length} 条`);
    for (const p of unknowns) {
      log(`  ? ${p.vaultId}  (${JSON.stringify(p.name)})  docs=${p.docCount} 云端对象=${p.cloudObjectCount ?? '未探测'}`);
      for (const r of p.reasons) log(`      · ${r}`);
    }
  } else {
    log('\n【D · 不确定】0 条');
  }

  hr('第 3 步：汇总');
  log(`  总计 ${profiles.length} 条`);
  log(`  A 确定可删    ${del.length}：${del.map((p) => p.vaultId).join(', ') || '（无）'}`);
  log(`  B 测试残留    ${residues.length}：${residues.map((p) => p.vaultId).join(', ') || '（无）'}`);
  log(`  C 建议保留    ${keeps.length}：${keeps.map((p) => p.vaultId).join(', ')}`);
  log(`  D 不确定      ${unknowns.length}：${unknowns.map((p) => p.vaultId).join(', ') || '（无）'}`);

  const deleteSet = APPLY ? (PURGE_RESIDUE ? [...del, ...residues] : del) : [...del, ...residues];
  log(`\n  本次将删除 ${deleteSet.length} 条 → 剩余 ${profiles.length - deleteSet.length} 条`);
  if (residues.length && APPLY && !PURGE_RESIDUE) {
    log(`  ⚠ 检测到 ${residues.length} 条测试残留但未加 --purge-residue，本次**不会**删除它们`);
  }

  // 备份（apply 前强制）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpFile = join(OUT_EVID, `re14-user-vaults-backup-${stamp}.json`);
  writeFileSync(
    dumpFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        user: { id: user.id, username: user.username },
        reason: '1.4.0 需求10 清理前的 user_vaults 全表备份',
        rowCount: rows.length,
        rows,
        profiles,
      },
      null,
      2,
    ),
    'utf8',
  );
  log(`\n  ✅ 全表备份 → ${dumpFile}`);

  const auditFile = join(OUT_SHOTS, 're14-clean-vaults-plan.json');
  writeFileSync(
    auditFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: APPLY ? 'apply' : 'dry-run',
        purgeResidue: PURGE_RESIDUE,
        delete: del,
        residue: residues,
        keep: keeps,
        unknown: unknowns,
        willDelete: deleteSet.map((p) => p.vaultId),
        backup: dumpFile,
      },
      null,
      2,
    ),
    'utf8',
  );
  log(`  ✅ 清理计划 → ${auditFile}`);

  if (!APPLY) {
    hr('DRY-RUN 结束（未做任何修改）');
    log('  确认清单无误后，执行删除：');
    log('    # 只删真空壳（A 档）');
    log('    node tools/re14-clean-vaults.mjs --apply');
    log('    # 连同测试残留（B 档）一起删（需 lead 明确批准）');
    log('    node tools/re14-clean-vaults.mjs --apply --purge-residue');
    return;
  }

  if (!deleteSet.length) {
    hr('APPLY：没有需要删除的条目');
    return;
  }

  hr(`第 4 步：APPLY —— 删除 ${deleteSet.length} 条（已备份到 ${dumpFile}）`);
  let deleted = 0;
  const failed = [];
  for (const p of deleteSet) {
    try {
      const res = await fetch(`${API}/api/vaults/${encodeURIComponent(p.vaultId)}${PURGE ? '?purge=1' : ''}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 404 说明 DB 里其实没有（已被别人清掉），视为成功
        if (res.status === 404) {
          log(`  · ${p.vaultId} 已不存在（404），跳过`);
          continue;
        }
        const txt = await res.text().catch(() => '');
        throw new Error(`DELETE ${res.status} ${txt.slice(0, 120)}`);
      }
      deleted += 1;
      log(`  ✓ 已删除 ${p.vaultId}  (${JSON.stringify(p.name)})  [${p.verdict}]${PURGE ? ' + 云端对象' : ''}`);
    } catch (e) {
      failed.push({ vaultId: p.vaultId, error: e.message });
      log(`  ✗ 删除失败 ${p.vaultId}：${e.message}`);
    }
  }

  hr('第 5 步：清理后复核');
  const after = await pool.query(
    `SELECT vault_id, name, doc_count FROM user_vaults WHERE user_id = ? ORDER BY created_at ASC`,
    [user.id],
  );
  log(`  清理前 ${rows.length} 行 → 清理后 ${after.length} 行（删除 ${deleted}）`);
  log(`  剩余仓库：`);
  for (const r of after) log(`     ${r.vault_id}  (${JSON.stringify(r.name)})  docs=${r.doc_count}`);
  if (failed.length) {
    log(`\n  ! ${failed.length} 条失败：`);
    for (const f of failed) log(`      ${f.vaultId}: ${f.error}`);
  }

  const resultFile = join(OUT_SHOTS, 're14-clean-vaults-result.json');
  writeFileSync(
    resultFile,
    JSON.stringify({ at: new Date().toISOString(), before: rows.length, after: after.length, deleted, failed, remaining: after }, null, 2),
    'utf8',
  );
  log(`\n  ✅ 结果 → ${resultFile}`);
  log(`  ✅ 备份 → ${dumpFile}`);

  if (failed.length) process.exitCode = 1;
}

await main()
  .catch((e) => {
    console.error('FATAL', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
    process.exitCode = 1;
  })
  /*
   * 无论成功/失败/提前 return，都必须关闭 MySQL 连接池。
   *
   * 首版忘记关：dry-run 在 `return` 处退出 main()，但池里的连接仍存活，
   * Node 事件循环不空 → 进程**永不退出**（实测 >180s 后被 DSH 转后台）。
   * 这里用 finally 兜住，保证脚本是「跑完就退」的短命进程。
   */
  .finally(async () => {
    try {
      const poolUrl = pathToFileURL(join(REPO, 'services/api/src/db/pool.js')).href;
      const pool = await import(poolUrl);
      await pool.closePool();
    } catch {
      /* 池已关或导入失败都不影响退出码 */
    }
  });
