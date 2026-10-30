#!/usr/bin/env node
/**
 * 1.2.1 缺陷5「历史版本只能看到最近一版」诊断 / 端到端验证脚本。
 *
 * 两种模式：
 *   node tools/re121-history.mjs probe
 *     只读盘点：登录 → 列仓库 → 列每个仓库 `versions/` 云端对象，量化
 *     「修复前云端到底存了几版 / 面板最终会显示几条」。
 *
 *   node tools/re121-history.mjs e2e
 *     端到端：走**真实 core 代码**（Vault.save + SyncEngine.putRemoteVersion /
 *     listRemoteVersions + 合并逻辑），在临时目录里建临时仓库，保存 5 次不同内容，
 *     断言列出版本 ≥5 且内容各异，再回滚到第 2 版并断言正文一致。
 *     临时仓库与云端对象在 finally 里清理，绝不动 admin 已有笔记。
 *
 * 安全约束：
 *   - 只新建 `re121-*` 前缀的临时仓库/文档，清理时只删该前缀的对象；
 *   - 登录限流 10 次/分钟，本脚本全程只登录 1 次；
 *   - 不打印、不落盘任何凭据（token 只在内存里）。
 */

import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const log = (...args) => console.log(...args);
const hr = (title) => log(`\n=== ${title} ===`);

/* ------------------------------------------------------------------ */
/* HTTP 客户端（只做脚本需要的最小集合）                                 */
/* ------------------------------------------------------------------ */

let accessToken = '';

async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(init.json) };
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `${res.status}`;
    const err = new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function login() {
  const body = await api('/api/auth/login', { method: 'POST', json: { username: USER, password: PASS } });
  accessToken = body?.data?.accessToken ?? '';
  if (!accessToken) throw new Error('登录响应缺少 accessToken');
  return body.data.user;
}

async function listVaults() {
  const body = await api('/api/vaults');
  return body?.data?.vaults ?? [];
}

/** 存储列举（返回的是**相对** key，与服务端契约一致） */
async function listObjects(vaultId, prefix, maxKeys = 1000) {
  const body = await api(`/api/storage/list?prefix=${encodeURIComponent(prefix)}&maxKeys=${maxKeys}`, {
    headers: { 'x-vault-id': vaultId },
  });
  return body?.data?.objects ?? [];
}

async function putObject(vaultId, key, markdown) {
  await api(`/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'x-vault-id': vaultId,
      'content-type': 'application/octet-stream',
      'x-object-key': key,
      'x-object-content-type': 'text/markdown; charset=utf-8',
    },
    body: Buffer.from(markdown, 'utf8'),
  });
}

async function getObject(vaultId, key) {
  const res = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${accessToken}`, 'x-vault-id': vaultId },
  });
  if (!res.ok) throw new Error(`GET ${key} → ${res.status}`);
  return await res.text();
}

async function deleteObject(vaultId, key) {
  await api(`/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'x-vault-id': vaultId },
  });
}

/* ------------------------------------------------------------------ */
/* 模式 1：只读盘点（修复前取证）                                       */
/* ------------------------------------------------------------------ */

async function probe() {
  const user = await login();
  log(`登录成功：${user.username}（角色 ${user.role}）`);
  const vaults = await listVaults();
  hr(`仓库清单（${vaults.length} 个）`);
  for (const v of vaults) log(`  - vaultId=${v.vaultId}  name=${v.name}  docs=${v.docCount ?? '?'}`);

  const summary = [];
  for (const v of vaults) {
    let versionObjs = [];
    try {
      versionObjs = await listObjects(v.vaultId, 'versions/', 1000);
    } catch (e) {
      log(`  ! 列举 ${v.vaultId} 的 versions/ 失败：${e.message}`);
      continue;
    }
    const byDoc = new Map();
    for (const o of versionObjs) {
      const m = /^versions\/([^/]+)\//.exec(o.key);
      if (!m) continue;
      const list = byDoc.get(m[1]) ?? [];
      list.push(o);
      byDoc.set(m[1], list);
    }
    let docCount = 0;
    try {
      const docs = await listObjects(v.vaultId, 'docs/', 1000);
      docCount = new Set(docs.map((o) => /^docs\/([^/]+)\//.exec(o.key)?.[1]).filter(Boolean)).size;
    } catch {
      /* ignore */
    }
    summary.push({ vaultId: v.vaultId, docs: docCount, versionObjects: versionObjs.length, docsWithVersions: byDoc.size });
    hr(`仓库 ${v.vaultId}：${docCount} 篇文档，云端 versions/ 共 ${versionObjs.length} 个对象`);
    // 只展示版本数最多的前 5 篇，避免刷屏
    const rows = [...byDoc.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
    for (const [docId, objs] of rows) {
      log(`  doc ${docId}: ${objs.length} 版`);
      for (const o of objs.slice(0, 6)) log(`      ${o.key}  ${o.size}B`);
      if (objs.length > 6) log(`      … 其余 ${objs.length - 6} 版省略`);
    }
    if (!byDoc.size) log('  （该仓库云端没有任何历史版本对象）');
  }
  hr('汇总');
  for (const s of summary) {
    log(`  ${s.vaultId}: docs=${s.docs} versionObjects=${s.versionObjects} docsWithVersions=${s.docsWithVersions}`);
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* 模式 2：端到端（真实 core 代码）                                     */
/* ------------------------------------------------------------------ */

/**
 * 加载 @neomd/core 的真实实现。
 *
 * 为什么不直接 `import('../../packages/core/src/index.ts')`：
 *  - Node 24 的 TS 类型剥离只支持「显式扩展名的相对导入」，
 *    而 core 源码里全是 `from '@neomd/shared'` / `from './vault/adapter'` 这种
 *    省略扩展名 + 工作区别名的写法，原生 import 会直接失败；
 *  - `tsc` 产物（dist/）也是省略扩展名的 ESM，Node 同样解析不了。
 *
 * 因此用仓库里已经装好的 esbuild 现场 bundle 一份到临时文件再 import。
 * 这样脚本跑的是**和 Web 端完全同一份 core 源码**，不是另写一份模拟实现。
 */
async function loadCore() {
  const esbuildPath = join(REPO, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js');
  let esbuild;
  try {
    esbuild = (await import(pathToFileURL(esbuildPath).href)).default ?? (await import(pathToFileURL(esbuildPath).href));
  } catch (e) {
    throw new Error(`未找到 esbuild（${esbuildPath}）：${e.message}`);
  }
  /*
   * 产物必须落在 packages/core/ 下，而不是系统临时目录：
   * bundle 里保留了 markdown-it / minisearch / sql.js 等 external 依赖，
   * 它们只在 packages/core/node_modules 里（pnpm 的 per-package 链接），
   * 放到系统 temp 目录会 ERR_MODULE_NOT_FOUND。
   */
  const outfile = join(REPO, 'packages/core/.re121-core-bundle.mjs');
  await esbuild.build({
    entryPoints: [join(REPO, 'packages/core/src/index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    alias: {
      '@neomd/shared': join(REPO, 'packages/shared/src/index.ts'),
    },
    // 这些是可选的运行时依赖，脚本用不到；标为 external 避免拖入浏览器专用代码
    external: ['markdown-it', 'minisearch', 'sql.js'],
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, outfile };
}

/** 最简 Node 文件适配器：满足 VaultAdapter 接口，用于临时目录 */
function makeNodeAdapter(root) {
  const abs = (rel) => join(root, rel.split('/').join('\\'));
  const st = async (p) => {
    try {
      const { stat } = await import('node:fs/promises');
      return await stat(p);
    } catch {
      return null;
    }
  };
  const walk = async (dir, prefix, out) => {
    const { readdir } = await import('node:fs/promises');
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (rel.startsWith('.neomd') && prefix === '') continue;
      if (e.isDirectory()) await walk(join(dir, e.name), rel, out);
      else {
        const s = await st(join(dir, e.name));
        out.push({ path: rel, isDirectory: false, size: s?.size ?? 0, mtime: s?.mtimeMs ?? Date.now() });
      }
    }
  };
  return {
    kind: 'desktop-fs',
    location: root,
    async open(loc) {
      this.location = loc;
      await mkdir(loc, { recursive: true });
    },
    async readText(p) {
      return await readFile(abs(p), 'utf8');
    },
    async readBinary(p) {
      return new Uint8Array(await readFile(abs(p)));
    },
    async writeText(p, content) {
      await mkdir(dirname(abs(p)), { recursive: true });
      await writeFile(abs(p), content, 'utf8');
    },
    async writeBinary(p, data) {
      await mkdir(dirname(abs(p)), { recursive: true });
      await writeFile(abs(p), Buffer.from(data));
    },
    async remove(p) {
      await rm(abs(p), { force: true, recursive: true });
    },
    async rename(from, to) {
      const { rename } = await import('node:fs/promises');
      await mkdir(dirname(abs(to)), { recursive: true });
      await rename(abs(from), abs(to));
    },
    async mkdirp(p) {
      await mkdir(abs(p), { recursive: true });
    },
    async exists(p) {
      return (await st(abs(p))) !== null;
    },
    async stat(p) {
      const s = await st(abs(p));
      return s ? { size: s.size, mtime: s.mtimeMs } : null;
    },
    async listAll() {
      const out = [];
      await walk(root, '', out);
      return out;
    },
    async listDir(p) {
      const { readdir } = await import('node:fs/promises');
      const dir = abs(p);
      const out = [];
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        const rel = p ? `${p}/${e.name}` : e.name;
        const s = e.isDirectory() ? null : await st(join(dir, e.name));
        out.push({ path: rel, isDirectory: e.isDirectory(), size: s?.size ?? 0, mtime: s?.mtimeMs ?? Date.now() });
      }
      return out;
    },
    async usage() {
      const all = await this.listAll();
      return { bytes: all.reduce((s, f) => s + f.size, 0), files: all.length };
    },
  };
}

/** 把平台的 /api/storage/* 包成 core 的 StorageClient，让 SyncEngine 跑真链路 */
function makeHttpStorageClient(vaultId, rootPrefix) {
  const toRel = (key) => (rootPrefix && key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : key);
  const toAbs = (key) => (rootPrefix && !key.startsWith(rootPrefix) ? `${rootPrefix}${key}` : key);
  return {
    async putObject(key, body, contentType = 'application/octet-stream') {
      const rel = toRel(key);
      await api(`/api/storage/object?key=${encodeURIComponent(rel)}`, {
        method: 'PUT',
        headers: {
          'x-vault-id': vaultId,
          'content-type': 'application/octet-stream',
          'x-object-key': rel,
          'x-object-content-type': contentType,
        },
        body: typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body),
      });
    },
    async getObject(key) {
      const rel = toRel(key);
      const res = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(rel)}`, {
        headers: { authorization: `Bearer ${accessToken}`, 'x-vault-id': vaultId },
      });
      if (!res.ok) throw new Error(`下载失败 ${rel} → ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getObjectText(key) {
      return new TextDecoder('utf-8').decode(await this.getObject(key));
    },
    async headObject(key) {
      const rel = toRel(key);
      const res = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(rel)}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${accessToken}`, 'x-vault-id': vaultId },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HEAD ${rel} → ${res.status}`);
      return { key, size: Number(res.headers.get('content-length') ?? 0), etag: '', lastModified: 0 };
    },
    async deleteObject(key) {
      const rel = toRel(key);
      await api(`/api/storage/object?key=${encodeURIComponent(rel)}`, {
        method: 'DELETE',
        headers: { 'x-vault-id': vaultId },
      });
    },
    async listObjects(prefix, maxKeys = 1000) {
      const relPrefix = toRel(prefix);
      const objs = await listObjects(vaultId, relPrefix, maxKeys);
      return objs.map((o) => ({ key: toAbs(o.key), size: o.size, etag: o.etag ?? '', lastModified: o.lastModified ?? 0 }));
    },
    async presignGet(key) {
      return key;
    },
    async presignPut(key) {
      return key;
    },
    publicUrl(key) {
      return `${API}/api/storage/object?key=${encodeURIComponent(toRel(key))}`;
    },
  };
}

async function e2e() {
  const { mod: core, outfile: coreBundle } = await loadCore();
  const { Vault, SyncEngine, mergeVersionRecords } = core;
  if (!Vault || !SyncEngine) throw new Error('core 缺少 Vault/SyncEngine 导出');
  if (typeof mergeVersionRecords !== 'function') {
    throw new Error('core 缺少 mergeVersionRecords（本次修复新增的「本地+云端合并」纯函数）');
  }

  await login();
  const root = await mkdtemp(join(tmpdir(), 'neomd-re121-'));
  const vaultId = `re121-e2e-${Date.now().toString(36)}`;
  const rootPrefix = `mdadmin/neomd/users/${USER}/vaults/${vaultId}/`;
  const adapter = makeNodeAdapter(join(root, 'vault'));
  const vault = new Vault(adapter);
  const createdKeys = [];
  const createdDocIds = [];
  let exitCode = 0;

  try {
    vault.vaultId = vaultId;
    vault.name = 're121-e2e';
    await vault.open(join(root, 'vault'), { expectedVaultId: vaultId, expectedName: 're121-e2e', forceVaultId: true });

    const client = makeHttpStorageClient(vaultId, rootPrefix);
    const engine = new SyncEngine(
      client,
      { rootPrefix, deviceId: 're121-e2e-device', uploadVersions: true },
      {
        listLocal: () => vault.localStates(),
        readLocal: async (docId) => vault.read(docId),
        writeLocal: async () => undefined,
        deleteLocal: async () => undefined,
        markSynced: () => undefined,
        readLocalVersion: async () => null,
        recordVersion: async () => undefined,
        onLog: () => undefined,
        onConflict: () => undefined,
        onProgress: () => undefined,
      },
    );

    const doc = await vault.create({ title: 're121-history-e2e', content: '# 版本 0\n\n初始内容\n' });
    createdDocIds.push(doc.docId);
    log(`临时文档：docId=${doc.docId}  path=${doc.path}`);

    // 模拟真实保存链路：saveActiveTab 的完整语义（读旧内容 → save → 归档旧内容到云端）
    const contents = [];
    for (let i = 1; i <= 5; i += 1) {
      const next = `# 版本 ${i}\n\n这是第 ${i} 次保存的正文，唯一标记 RE121-${i}。\n${'行 '.repeat(i)}`;
      contents.push(next);
      const prev = await vault.read(doc.docId);
      const saved = await vault.save(doc.docId, next, 'save', true, 're121-device');
      const hash = await core.sha256Hex(prev, 16);
      const key = await engine.putRemoteVersion(doc.docId, Math.max(1, saved.rev - 1), hash, prev);
      createdKeys.push(key);
      await new Promise((r) => setTimeout(r, 5)); // 保证 ts 不同（真实用户保存间隔远大于此）
    }

    const remote = await engine.listRemoteVersions(doc.docId);
    const merged = mergeVersionRecords([], remote, { limit: 200 });
    log(`\n云端 listRemoteVersions：${remote.length} 版`);
    for (const r of remote) log(`  rev=${r.rev} hash=${r.hash} createdAt=${r.createdAt} key=${r.storageKey}`);
    log(`合并后（本地空 + 云端 ${remote.length}）：${merged.length} 版`);

    // 断言 1：版本数 ≥5
    if (merged.length < 5) {
      console.error(`✗ 版本数量不足：期望 ≥5，实际 ${merged.length}`);
      exitCode = 1;
    } else {
      log(`✓ 版本数量 ${merged.length} ≥ 5`);
    }

    // 断言 2：版本 key 唯一、内容各异
    const keys = new Set(merged.map((v) => v.storageKey));
    if (keys.size !== merged.length) {
      console.error(`✗ 版本 key 有重复：${merged.length} 条 / ${keys.size} 个唯一 key`);
      exitCode = 1;
    } else {
      log(`✓ 版本 key 全部唯一（${keys.size} 个）`);
    }
    const bodies = [];
    for (const v of merged) bodies.push(await engine.readRemoteVersion(v.storageKey));
    if (new Set(bodies).size !== bodies.length) {
      console.error(`✗ 版本内容有重复：${bodies.length} 条 / ${new Set(bodies).size} 种内容`);
      exitCode = 1;
    } else {
      log(`✓ 版本内容全部不同（${new Set(bodies).size} 种）`);
    }

    // 断言 3：回滚到第 2 版（按时间倒序，索引 1 = 倒数第 2 新 = 第 4 次保存前的内容）
    const target = merged[1];
    const targetBody = await engine.readRemoteVersion(target.storageKey);
    await vault.save(doc.docId, targetBody, 'restore', true, 're121-device');
    const after = await vault.read(doc.docId);
    if (after === targetBody) {
      log(`✓ 回滚到 rev=${target.rev} 成功，正文与该版本完全一致（${after.length} 字符）`);
    } else {
      console.error('✗ 回滚后正文与目标版本不一致');
      exitCode = 1;
    }
    const disk = await readFile(join(root, 'vault', doc.path.split('/').join('\\')), 'utf8');
    if (disk === targetBody) {
      log('✓ 磁盘文件内容也同步为回滚后的正文');
    } else {
      console.error('✗ 磁盘文件未更新');
      exitCode = 1;
    }

    /*
     * 断言 4：右侧栏「历史版本」区块（1.2.1 同源修复）。
     *
     * 复刻 `EditorPage.loadRightHistoryVersions()` 的**修复后**数据路径：
     *   `cloudVersions.value = await app.listDocVersions(docId)`
     *     ≡ mergeVersionRecords(local, cloud)     ← 本地 ∪ 云端、去重、倒序
     * 再复刻 `RightSection.vue:156` 的渲染上限 `(versions ?? []).slice(0, 8)`。
     *
     * 这里刻意先开启本地留痕再保存几次，构造出「本地有、云端也有」的真实混合态，
     * 才能同时验证右侧栏的**合并**与**去重**（旧代码正是被本地这 1 条截断了云端）。
     */
    vault.keepLocalVersions = true;
    for (let i = 6; i <= 7; i += 1) {
      const next = `# 版本 ${i}\n\n第 ${i} 次保存（本地留痕开启），标记 RE121-${i}。\n`;
      const prev = await vault.read(doc.docId);
      const saved = await vault.save(doc.docId, next, 'save', true, 're121-device');
      createdKeys.push(await engine.putRemoteVersion(doc.docId, Math.max(1, saved.rev - 1), await core.sha256Hex(prev, 16), prev));
    }

    const localVersions = await vault.listVersions(doc.docId);
    const remoteAll = await engine.listRemoteVersions(doc.docId);
    const rightPanelSource = mergeVersionRecords(localVersions, remoteAll, { limit: 200, docId: doc.docId });
    /** RightSection.vue:156 —— 右侧栏最多渲染 8 条 */
    const RIGHT_SECTION_CAP = 8;
    const rightPanelRows = rightPanelSource.slice(0, RIGHT_SECTION_CAP);

    // 旧 loadRightHistoryVersions()：`if (local.length) 用 local；否则用 cloud`
    const legacyRightPanel = (localVersions.length ? localVersions : remoteAll).slice(0, RIGHT_SECTION_CAP);

    log(`\n[右侧栏] 本地留痕 ${localVersions.length} 条 · 云端 ${remoteAll.length} 条`);
    log(`[右侧栏] 修复前 loadRightHistoryVersions → ${legacyRightPanel.length} 条（本地非空即截断云端）`);
    log(`[右侧栏] 修复后 listDocVersions    → ${rightPanelSource.length} 条，渲染 ${rightPanelRows.length} 条（cap ${RIGHT_SECTION_CAP}）`);
    for (const v of rightPanelRows) log(`    v${v.rev}  ${v.label || '本地'}  ${v.storageKey.split('/').pop()}`);
    if (rightPanelRows.length >= 5) {
      log(`✓ 右侧栏区块渲染 ${rightPanelRows.length} 条 ≥ 5`);
    } else {
      console.error(`✗ 右侧栏区块渲染条数不足：期望 ≥5，实际 ${rightPanelRows.length}`);
      exitCode = 1;
    }
    // 合并后不能有内容重复（去重是否生效）
    const rpBodies = [];
    for (const v of rightPanelSource) {
      rpBodies.push(
        v.storageKey.startsWith('.neomd/') ? await vault.readVersion(v.storageKey) : await engine.readRemoteVersion(v.storageKey),
      );
    }
    const identityKeys = new Set(rightPanelSource.map((v) => `${v.rev}|${v.hash}`));
    if (identityKeys.size !== rightPanelSource.length) {
      console.error(`✗ 合并后仍有重复版本：${rightPanelSource.length} 条 / ${identityKeys.size} 个内容身份`);
      exitCode = 1;
    } else {
      log(`✓ 合并去重生效（${rightPanelSource.length} 条 / ${identityKeys.size} 个唯一内容身份）`);
    }

    // 断言 5：面板「修复前」的算法只能看到 1 条 —— 用旧逻辑复算，供汇报量化
    const legacyLocal = localVersions;
    const legacyShown = legacyLocal.length ? legacyLocal.length : 1;
    log(`\n[对照] 旧 HistoryModal 逻辑：local=${legacyLocal.length} → ${legacyLocal.length ? '只用本地，云端被忽略' : '走云端分支'}`);
    log(`[对照] 旧逻辑只按 rev 去重时可见条数 = ${new Set(remoteAll.map((r) => r.rev)).size}（rev 相同即视为同一版）`);
    return {
      merged: merged.length,
      remote: remoteAll.length,
      legacyShown,
      rightPanelRows: rightPanelRows.length,
      rightPanelLegacy: legacyRightPanel.length,
      rightPanelMerged: rightPanelSource.length,
    };
  } finally {
    /*
     * 清理（finally 保证必执行）：
     *  1. 删除本次新建的云端版本对象；
     *  2. 删除临时仓库目录；
     *  3. 删除 esbuild 产出的临时 bundle；
     *  4. **注销临时仓库在服务端 user_vaults 的登记并清空其前缀对象**
     *     （否则测试会在用户的仓库列表里留下垃圾条目）。
     * 只操作 `re121-e2e-*` 前缀，绝不影响 admin 既有仓库。
     */
    for (const key of createdKeys) {
      try {
        await deleteObject(vaultId, key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : key);
      } catch {
        /* ignore */
      }
    }
    try {
      await api(`/api/vaults/${encodeURIComponent(vaultId)}?purge=1`, { method: 'DELETE' });
    } catch {
      /* 仓库可能尚未登记（首同步前）→ 无需清理 */
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      await rm(coreBundle, { force: true });
    } catch {
      /* ignore */
    }
    log(`\n已清理临时仓库 ${vaultId}（${createdKeys.length} 个云端版本对象、服务端登记）与临时目录`);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

/* ------------------------------------------------------------------ */
/* 模式 3：清理（删除测试期间新建的临时仓库及其云端对象）               */
/* ------------------------------------------------------------------ */

/**
 * 只删名字匹配给定前缀的仓库，且必须显式传入前缀。
 *
 * 安全约束：默认前缀是 `re121` / `vaultre121`，绝不允许删除 `admin` 或
 * 用户既有仓库 —— 这是「不要动 admin 已有笔记」的硬约束。
 */
async function cleanup() {
  const prefixes = process.argv.slice(3);
  const allow = prefixes.length ? prefixes : ['re121', 'vaultre121'];
  if (allow.some((p) => !/^[a-z0-9]{3,32}$/i.test(p))) {
    throw new Error('清理前缀必须是 3-32 位字母数字，拒绝执行');
  }
  await login();
  const vaults = await listVaults();
  const targets = vaults.filter((v) => allow.some((p) => String(v.vaultId).toLowerCase().startsWith(p.toLowerCase())));
  hr(`待清理仓库（${targets.length} 个，前缀 ${allow.join(' / ')}）`);
  for (const v of targets) log(`  - ${v.vaultId}（${v.name}）`);
  if (!targets.length) {
    log('没有匹配的临时仓库，无需清理。');
    return [];
  }
  const done = [];
  for (const v of targets) {
    try {
      const body = await api(`/api/vaults/${encodeURIComponent(v.vaultId)}?purge=1`, { method: 'DELETE' });
      const purged = body?.data?.purgedObjects ?? 0;
      done.push({ vaultId: v.vaultId, purgedObjects: purged });
      log(`  ✓ 已删除 ${v.vaultId}，清理云端对象 ${purged} 个`);
    } catch (e) {
      log(`  ! 删除 ${v.vaultId} 失败：${e.message}`);
    }
  }
  return done;
}

const mode = process.argv[2] || 'probe';
if (mode === 'probe') {
  await probe();
} else if (mode === 'e2e') {
  await e2e();
} else if (mode === 'cleanup') {
  await cleanup();
} else {
  console.error(`未知模式：${mode}（可选 probe / e2e / cleanup）`);
  process.exitCode = 2;
}
