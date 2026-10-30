/**
 * 历史版本（缺陷5）单测 —— 1.2.1。
 *
 * 覆盖三件事：
 *  1. `Vault.save()` 连续保存多次后，本地留痕的**数量正确、key 唯一、内容各异**；
 *  2. `SyncEngine.putRemoteVersion()` 的云端 key 含**唯一**时间戳，
 *     同一毫秒内连续归档也不会互相覆盖；
 *  3. `mergeVersionRecords()` 把本地 + 云端合并成一条时间线：
 *     按内容身份（rev+hash）去重、按时间倒序、不丢版本。
 *
 * 全部用**内存 adapter**，不碰真实磁盘、不碰网络、不碰生产库。
 */
import { describe, expect, it } from 'vitest';
import type { VaultAdapter, VaultFileEntry } from '../vault/adapter';
import { Vault, mergeVersionRecords, sortAndDedupeVersions } from '../vault/vault';
import { SyncEngine } from '../sync/sync-engine';
import type { StorageClient, S3ObjectMeta } from '../storage/types';
import { sha256Hex } from '../util/hash';
import type { VersionRecord } from '@neomd/shared';

/* ------------------------------------------------------------------ */
/* 内存适配器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 内存版仓库适配器。
 *
 * 关键点：`listAll()` **过滤掉 `.neomd/`**，与真实 `BrowserVaultAdapter` 一致 ——
 * 这正是「网页端永远列不出本地历史版本」的成因，单测必须复现这个约束，
 * 否则 `Vault.listVersions()` 的索引兜底逻辑就测不到。
 */
class MemoryAdapter implements VaultAdapter {
  readonly kind = 'browser-idb' as const;
  location = 'memory://test';
  private files = new Map<string, { data: string; mtime: number }>();
  /** 单调递增的 mtime，保证列表顺序确定 */
  private clock = 1_700_000_000_000;

  private touch(): number {
    this.clock += 1;
    return this.clock;
  }

  async open(location: string): Promise<void> {
    this.location = location;
  }

  async readText(path: string): Promise<string> {
    const rec = this.files.get(path);
    if (!rec) throw new Error(`文件不存在: ${path}`);
    return rec.data;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(path));
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, { data: content, mtime: this.touch() });
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.writeText(path, new TextDecoder().decode(data));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const rec = this.files.get(from);
    if (!rec) throw new Error(`文件不存在: ${from}`);
    this.files.set(to, rec);
    this.files.delete(from);
  }

  async mkdirp(): Promise<void> {
    /* 内存实现无目录概念 */
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const rec = this.files.get(path);
    return rec ? { size: rec.data.length, mtime: rec.mtime } : null;
  }

  /** 与 BrowserVaultAdapter 一致：元数据目录不进 listAll（对账/索引不能把它当正文） */
  async listAll(): Promise<VaultFileEntry[]> {
    return [...this.files.entries()]
      .filter(([path]) => !path.startsWith('.neomd'))
      .map(([path, rec]) => ({ path, isDirectory: false, size: rec.data.length, mtime: rec.mtime }));
  }

  async listDir(path: string): Promise<VaultFileEntry[]> {
    const prefix = `${path}/`;
    const out: VaultFileEntry[] = [];
    const seen = new Set<string>();
    for (const [p, rec] of this.files.entries()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split('/')[0]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        path: prefix + name,
        isDirectory: rest.includes('/'),
        size: rest.includes('/') ? 0 : rec.data.length,
        mtime: rec.mtime,
      });
    }
    return out;
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    const all = await this.listAll();
    return { bytes: all.reduce((s, f) => s + f.size, 0), files: all.length };
  }

  /** 测试辅助：直接看底层全部 key（含 .neomd） */
  allKeys(): string[] {
    return [...this.files.keys()];
  }
}

/* ------------------------------------------------------------------ */
/* 内存对象存储客户端                                                   */
/* ------------------------------------------------------------------ */

class MemoryStorageClient implements StorageClient {
  readonly objects = new Map<string, { body: string; size: number; lastModified: number }>();

  async putObject(key: string, body: Uint8Array | string): Promise<void> {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    this.objects.set(key, { body: text, size: text.length, lastModified: Date.now() });
  }

  async getObject(key: string): Promise<Uint8Array> {
    const rec = this.objects.get(key);
    if (!rec) throw new Error(`对象不存在: ${key}`);
    return new TextEncoder().encode(rec.body);
  }

  async getObjectText(key: string): Promise<string> {
    return new TextDecoder().decode(await this.getObject(key));
  }

  async headObject(key: string): Promise<S3ObjectMeta | null> {
    const rec = this.objects.get(key);
    return rec ? { key, size: rec.size, etag: '', lastModified: rec.lastModified } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listObjects(prefix: string, maxKeys = 1000): Promise<S3ObjectMeta[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, maxKeys)
      .map(([key, rec]) => ({ key, size: rec.size, etag: '', lastModified: rec.lastModified }));
  }

  async presignGet(key: string): Promise<string> {
    return key;
  }

  async presignPut(key: string): Promise<string> {
    return key;
  }

  publicUrl(key: string): string {
    return `memory://${key}`;
  }
}

/** 造一个 SyncEngine（回调全部空实现：这些用例只关心版本 key 与列表） */
function makeEngine(client: StorageClient, rootPrefix = 'mdadmin/neomd/users/u/vaults/v1/'): SyncEngine {
  return new SyncEngine(
    client,
    { rootPrefix, deviceId: 'test-device', uploadVersions: true } as never,
    {
      readLocal: async () => null,
      writeLocal: async () => undefined,
      deleteLocal: async () => undefined,
      listLocal: () => [],
      markSynced: () => undefined,
      readLocalVersion: async () => null,
      recordVersion: async () => undefined,
      onLog: () => undefined,
      onConflict: () => undefined,
      onProgress: () => undefined,
    },
  );
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('Vault 本地历史版本 · 连续保存', () => {
  it('保存 5 次不同内容 → 5 个版本，key 唯一，内容各异', async () => {
    const adapter = new MemoryAdapter();
    const vault = new Vault(adapter);
    vault.keepLocalVersions = true; // 开启本地留痕（对应设置项「本地留痕」）
    await vault.open('memory://test');

    const doc = await vault.create({ title: '版本探针', content: '# v0\n\n初始内容\n' });
    const bodies = ['# v0\n\n初始内容\n'];
    for (let i = 1; i <= 5; i += 1) {
      const body = `# v${i}\n\n第 ${i} 次保存 RE121-${i}\n`;
      bodies.push(body);
      await vault.save(doc.docId, body, 'save', true, 'test-device');
    }

    const versions = await vault.listVersions(doc.docId);

    // ① 数量：每次 save 归档「保存前的正文」，共 5 次 → 5 个版本
    expect(versions).toHaveLength(5);

    // ② key 唯一
    const keys = versions.map((v) => v.storageKey);
    expect(new Set(keys).size).toBe(keys.length);

    // ③ 内容各异（逐个读回来比对）
    const contents = await Promise.all(versions.map((v) => vault.readVersion(v.storageKey)));
    expect(new Set(contents).size).toBe(contents.length);

    // ④ 倒序：最新归档的版本排在最前
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i - 1]!.createdAt).toBeGreaterThanOrEqual(versions[i]!.createdAt);
    }

    // ⑤ 索引兜底：listAll() 过滤了 .neomd，列表仍能拿到（这正是网页端的真实约束）
    const visible = await adapter.listAll();
    expect(visible.some((f) => f.path.includes('versions'))).toBe(false);
    expect(versions.length).toBeGreaterThan(0);
  });

  it('同一毫秒内连续归档不会互相覆盖（key 里的 ts 严格递增）', async () => {
    const adapter = new MemoryAdapter();
    const vault = new Vault(adapter);
    vault.keepLocalVersions = true;
    await vault.open('memory://test');

    const doc = await vault.create({ title: '并发探针', content: 'A' });
    // 连续同步 save，全部落在同一毫秒内
    for (const body of ['B', 'C', 'D', 'E']) {
      await vault.save(doc.docId, body, 'save', true, 'dev');
    }
    const versions = await vault.listVersions(doc.docId);
    expect(versions).toHaveLength(4);
    const tsSet = new Set(versions.map((v) => v.storageKey));
    expect(tsSet.size).toBe(4);
  });

  it('回滚到第 2 版 → 正文与磁盘内容都变回该版本', async () => {
    const adapter = new MemoryAdapter();
    const vault = new Vault(adapter);
    vault.keepLocalVersions = true;
    await vault.open('memory://test');

    const doc = await vault.create({ title: '回滚探针', content: '# v0\n\n初始\n' });
    const written: string[] = ['# v0\n\n初始\n'];
    for (let i = 1; i <= 5; i += 1) {
      const body = `# v${i}\n\n第 ${i} 版 RE121-${i}\n`;
      written.push(body);
      await vault.save(doc.docId, body, 'save', true, 'dev');
    }

    const versions = await vault.listVersions(doc.docId);
    // 时间倒序：versions[0] 是最近归档（v4 的内容），versions[3] 是「第 2 版」
    const target = versions[3]!;
    const targetBody = await vault.readVersion(target.storageKey);
    expect(targetBody).toBe(written[1]); // 第 2 次保存前的正文 = written[1]

    await vault.restoreVersion(doc.docId, target.storageKey);

    // 正文变回该版本
    expect(await vault.read(doc.docId)).toBe(targetBody);
    // 磁盘（适配器里的文件）也变了
    expect(await adapter.readText(doc.path)).toBe(targetBody);
    // 恢复动作本身也归档了一版（误点还能再恢复回来）
    const after = await vault.listVersions(doc.docId);
    expect(after.length).toBe(versions.length + 1);
  });

  it('未开启本地留痕时不写 .neomd/versions（产品约定不变）', async () => {
    const adapter = new MemoryAdapter();
    const vault = new Vault(adapter);
    vault.keepLocalVersions = false;
    await vault.open('memory://test');

    const doc = await vault.create({ title: '无留痕', content: 'A' });
    await vault.save(doc.docId, 'B', 'save', true, 'dev');
    expect(await vault.listVersions(doc.docId)).toHaveLength(0);
    expect(adapter.allKeys().some((k) => k.startsWith('.neomd/versions/') && k.endsWith('.md'))).toBe(false);
  });
});

describe('SyncEngine 云端历史版本', () => {
  it('连续 putRemoteVersion 5 次 → 5 个不同 key，内容各异', async () => {
    const client = new MemoryStorageClient();
    const engine = makeEngine(client);
    const keys: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const body = `# 云端 v${i}\n\nRE121-CLOUD-${i}\n`;
      const hash = await sha256Hex(body, 16);
      keys.push(await engine.putRemoteVersion('doc1', i, hash, body));
    }

    expect(new Set(keys).size).toBe(5);
    for (const key of keys) {
      expect(key).toMatch(/^mdadmin\/neomd\/users\/u\/vaults\/v1\/versions\/doc1\/\d{10,}-\d+-[0-9a-f]+\.md$/);
    }

    const listed = await engine.listRemoteVersions('doc1');
    expect(listed).toHaveLength(5);
    // 倒序
    for (let i = 1; i < listed.length; i += 1) {
      expect(listed[i - 1]!.createdAt).toBeGreaterThanOrEqual(listed[i]!.createdAt);
    }
    const bodies = await Promise.all(listed.map((v) => engine.readRemoteVersion(v.storageKey)));
    expect(new Set(bodies).size).toBe(5);
  });

  it('同一 rev+hash 被归档两次 → 列表按内容身份去重成 1 条（但两个对象都在）', async () => {
    const client = new MemoryStorageClient();
    const engine = makeEngine(client);
    const body = '# 同内容\n';
    const hash = await sha256Hex(body, 16);
    const k1 = await engine.putRemoteVersion('doc2', 3, hash, body);
    const k2 = await engine.putRemoteVersion('doc2', 3, hash, body);

    // key 不同（ts 唯一）→ 不会互相覆盖
    expect(k1).not.toBe(k2);
    expect(client.objects.size).toBe(2);

    // 列表去重后只剩 1 条（否则面板会出现两个一模一样的版本）
    const listed = await engine.listRemoteVersions('doc2');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.rev).toBe(3);
  });

  it('listRemoteVersions 不因 rev 相同而丢版本（不同 hash 都要在）', async () => {
    const client = new MemoryStorageClient();
    const engine = makeEngine(client);
    // 模拟「rev 相同但内容不同」的历史数据（老版本 key 冲突留下的形态）
    for (const [rev, body] of [
      [2, '# A\n'],
      [2, '# B\n'],
      [2, '# C\n'],
    ] as const) {
      const hash = await sha256Hex(body, 16);
      await engine.putRemoteVersion('doc3', rev, hash, body);
    }
    const listed = await engine.listRemoteVersions('doc3');
    expect(listed).toHaveLength(3);
    expect(new Set(listed.map((v) => v.hash)).size).toBe(3);
  });
});

describe('版本合并 · 本地 ∪ 云端', () => {
  function rec(partial: Partial<VersionRecord> & { rev: number; hash: string; createdAt: number }): VersionRecord {
    return {
      id: `${partial.rev}-${partial.hash}-${partial.createdAt}`,
      docId: 'docX',
      rev: partial.rev,
      hash: partial.hash,
      size: partial.size ?? 10,
      createdAt: partial.createdAt,
      origin: partial.origin ?? 'save',
      storageKey: partial.storageKey ?? `versions/docX/${partial.createdAt}-${partial.rev}-${partial.hash}.md`,
      synced: partial.synced ?? true,
      label: partial.label ?? '云端',
    };
  }

  it('本地 1 条 + 云端 4 条 → 合并出 5 条（不再二选一）', () => {
    const local = [rec({ rev: 1, hash: 'aaaa', createdAt: 100, storageKey: '.neomd/versions/docX/100-1-aaaa.md', label: '' })];
    const cloud = [
      rec({ rev: 5, hash: 'ee', createdAt: 500 }),
      rec({ rev: 4, hash: 'dd', createdAt: 400 }),
      rec({ rev: 3, hash: 'cc', createdAt: 300 }),
      rec({ rev: 2, hash: 'bb', createdAt: 200 }),
    ];
    const merged = mergeVersionRecords(local, cloud);
    expect(merged).toHaveLength(5);
    // 时间倒序
    expect(merged.map((v) => v.rev)).toEqual([5, 4, 3, 2, 1]);
  });

  it('同一内容在本地与云端各一份 → 去重成 1 条，且优先用本地 key', () => {
    const local = [rec({ rev: 3, hash: 'cc', createdAt: 300, storageKey: '.neomd/versions/docX/300-3-cc.md', label: '' })];
    const cloud = [rec({ rev: 3, hash: 'cc', createdAt: 300 })];
    const merged = mergeVersionRecords(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.storageKey.startsWith('.neomd/')).toBe(true);
    // 但标记「云端也有」，UI 可以据此提示
    expect(merged[0]!.synced).toBe(true);
  });

  it('回滚场景 A→B→A：rev 不同则两条 A 都保留', () => {
    const merged = sortAndDedupeVersions([
      rec({ rev: 1, hash: 'aa', createdAt: 100 }),
      rec({ rev: 2, hash: 'bb', createdAt: 200 }),
      rec({ rev: 3, hash: 'aa', createdAt: 300 }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.map((v) => v.rev)).toEqual([3, 2, 1]);
  });

  it('limit 生效且按时间取最新 N 条', () => {
    const cloud = Array.from({ length: 10 }, (_, i) =>
      rec({ rev: i + 1, hash: `h${i}`, createdAt: 1000 + i }),
    );
    const merged = mergeVersionRecords([], cloud, { limit: 3 });
    expect(merged).toHaveLength(3);
    expect(merged.map((v) => v.rev)).toEqual([10, 9, 8]);
  });
});
