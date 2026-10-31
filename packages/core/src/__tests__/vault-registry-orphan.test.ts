/**
 * 仓库注册表 orphan 对账单测（1.4.0 需求10「幽灵仓库反弹」根治）。
 *
 * ## 背景：这是一个**实测复现过的真实缺陷**
 *
 * 现象：`user_vaults` 清理后 10→4，约 25 分钟后**又弹回 10 条**，
 * 且新行带 `auto_registered=1`（说明是 1.4.0 新代码写的，不是旧残留）。
 *
 * 反弹链路（逐环可验证）：
 *   1. 某台设备的 localStorage 注册表里存着 6 个**云端已删除**的 vaultId；
 *   2. 周期同步 / 「全部同步」遍历注册表 → 对这 6 条也发起同步；
 *   3. 同步时访问 `PUT /api/storage/*`，带 `x-vault-id: <已删除的id>`；
 *   4. 服务端 `assertVaultUsable()` 发现该 `(user_id, vault_id)` 未登记
 *      → **自动 INSERT 回 `user_vaults`**（这是 1.1.9 为消除 403 死锁而加的设计）；
 *   5. 幽灵仓库重新出现在仓库列表里。
 *
 * ## 修复的两道闸门（本测试逐条守住）
 *
 *  - **闸门 A（数据层面）**：`mergeRemote()` 对「本机有、云端没有」的条目
 *    标记 `orphan:true`，连续 `ORPHAN_REMOVE_AFTER_MISSES` 轮后物理移除；
 *  - **闸门 B（行为层面）**：`isSyncable()` / `listSyncable()` 让 orphan 条目
 *    **不进入同步循环** —— 这才是真正打断链路的地方（没有第 3 步就没有第 4 步）。
 *
 * ## 同时守住的「不能过度清理」边界
 *
 * 用户要求「宁可少删，不要误删」。以下情况**绝对不能被判成 orphan**：
 *  - 纯本地目录仓库（桌面端真实文件夹，用户只是没登录云端）；
 *  - 云端有、本机没下载过的仓库（`available:false` 是正常的跨设备发现状态）；
 *  - 单次漏返回（网络抖动/分页）——必须连续多轮才判定。
 */
import { describe, expect, it } from 'vitest';
import { VaultRegistry, ORPHAN_REMOVE_AFTER_MISSES } from '../vault/registry';
import type { RemoteVaultDto } from '../vault/registry';

/** 内存版 Storage，避免依赖浏览器环境 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** 造一条云端仓库 DTO */
function remote(vaultId: string, name: string, extra: Partial<RemoteVaultDto> = {}): RemoteVaultDto {
  return { vaultId, name, docCount: 1, bytes: 10, status: 'active', ...extra };
}

/**
 * 造一个「本机注册表里已存在某云端仓库」的注册表。
 *
 * 用 `mergeRemote()` 建立初始状态（最贴近真实路径：用户打开过这个仓库）。
 */
function registryWith(localVaultIds: string[]): VaultRegistry {
  const reg = new VaultRegistry(new MemoryStorage());
  reg.mergeRemote(localVaultIds.map((id) => remote(id, `仓库-${id}`)));
  return reg;
}

/* ------------------------------------------------------------------ */

describe('orphan 判定 · 基本链路', () => {
  it('云端有 → 不标 orphan', () => {
    const reg = registryWith(['v1', 'v2']);
    reg.mergeRemote([remote('v1', '仓库-v1'), remote('v2', '仓库-v2')]);
    expect(reg.listOrphans()).toHaveLength(0);
    expect(reg.list().every((e) => !e.orphan)).toBe(true);
  });

  it('云端不再返回 → 标记 orphan + available=false + 记录时间', () => {
    const reg = registryWith(['v1', 'v2']);
    // 云端只剩 v1 → v2 应被判 orphan
    reg.mergeRemote([remote('v1', '仓库-v1')]);
    const orphans = reg.listOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.vaultId).toBe('v2');
    expect(orphans[0]!.available).toBe(false);
    expect(typeof orphans[0]!.orphanSince).toBe('number');
    expect(orphans[0]!.orphanMissCount).toBe(1);
  });

  it('连续 miss 达到阈值 → 从注册表物理移除', () => {
    const reg = registryWith(['v1', 'v2']);
    // 第 1 轮：标记
    reg.mergeRemote([remote('v1', '仓库-v1')]);
    expect(reg.get('v2')?.orphan).toBe(true);
    // 第 2 轮：仍保留（miss=2 < 3）
    reg.mergeRemote([remote('v1', '仓库-v1')]);
    expect(reg.get('v2')).toBeDefined();
    expect(reg.get('v2')?.orphanMissCount).toBe(2);
    // 第 3 轮：达到阈值 → 移除
    reg.mergeRemote([remote('v1', '仓库-v1')]);
    // 注意 `get()` 的返回类型是 `VaultEntry | null`（不是 undefined）
    expect(reg.get('v2')).toBeNull();
    expect(reg.list().map((e) => e.vaultId)).toEqual(['v1']);
  });

  it('orphan 后又出现在云端 → 状态完全恢复', () => {
    const reg = registryWith(['v1', 'v2']);
    reg.mergeRemote([remote('v1', '仓库-v1')]); // v2 → orphan
    expect(reg.get('v2')?.orphan).toBe(true);

    reg.mergeRemote([remote('v1', '仓库-v1'), remote('v2', '仓库-v2')]); // v2 回来了
    const v2 = reg.get('v2');
    expect(v2?.orphan).toBe(false);
    expect(v2?.available).toBe(true);
    expect(v2?.orphanMissCount).toBe(0);
    expect(v2?.orphanSince).toBeUndefined();
  });

  it('单次漏返回不立即删除（防网络抖动误杀）', () => {
    const reg = registryWith(['v1']);
    reg.mergeRemote([]); // 空清单：mergeRemote 直接 return，不计数
    expect(reg.get('v1')).toBeDefined();
    expect(reg.get('v1')?.orphan).toBeFalsy();

    reg.mergeRemote([remote('other', '别的仓库')]); // v1 没返回 → 第 1 次 miss
    expect(reg.get('v1')).toBeDefined();
    expect(reg.get('v1')?.orphanMissCount).toBe(1);
  });
});

describe('orphan 判定 · 不能误杀的边界', () => {
  it('【关键】纯本地仓库永不判 orphan（用户只是没登录云端）', () => {
    const reg = new VaultRegistry(new MemoryStorage());
    // 用 register 建立一条纯本地目录仓库（location 是真实路径，不是 cloud:）
    reg.register({ vaultId: 'local1', name: '我的本地笔记', location: 'C:\\docs\\我的本地笔记' });
    const entry = reg.get('local1')!;
    expect(entry.location.startsWith('cloud:')).toBe(false);
    expect(entry.lastSyncedAt).toBeUndefined();

    // 云端返回了完全不相关的仓库（说明本地这条「云端没有」）
    reg.mergeRemote([remote('cloud1', '云端仓库')]);

    expect(reg.get('local1')).toBeDefined();
    expect(reg.get('local1')?.orphan).toBeFalsy();
    expect(reg.listOrphans().map((e) => e.vaultId)).not.toContain('local1');
  });

  it('连续多轮云端都不返回本地仓库，本地仓库依然保留', () => {
    const reg = new VaultRegistry(new MemoryStorage());
    reg.register({ vaultId: 'local1', name: '本地', location: '/home/u/local' });
    for (let i = 0; i < ORPHAN_REMOVE_AFTER_MISSES + 2; i += 1) {
      reg.mergeRemote([remote('cloud1', '云端仓库')]);
    }
    expect(reg.get('local1')).toBeDefined();
    expect(reg.get('local1')?.orphan).toBeFalsy();
  });

  it('【关键】云端有、本机没下载过 → available:false 但**不是** orphan', () => {
    const reg = new VaultRegistry(new MemoryStorage());
    reg.register({ vaultId: 'local1', name: '本地', location: '/home/u/local' });
    // 云端发现一个新仓库 → 插入到本机，available 按现有逻辑
    reg.mergeRemote([remote('cloudNew', '跨设备仓库')]);
    const e = reg.get('cloudNew')!;
    expect(e.orphan).toBeFalsy();
    // 它是可同步的（下一步打开就能拉内容）
    expect(reg.isSyncable(e)).toBe(true);
  });

  it('停用的仓库不是 orphan（是用户主动停用，语义不同）', () => {
    const reg = registryWith(['v1']);
    reg.mergeRemote([remote('v1', '仓库-v1', { status: 'disabled' })]);
    const e = reg.get('v1')!;
    expect(e.orphan).toBeFalsy();
    expect(e.status).toBe('disabled');
  });
});

describe('同步闸门 · isSyncable / listSyncable（反弹链路的真正阻断点）', () => {
  it('orphan 条目不可同步', () => {
    const reg = registryWith(['v1', 'v2']);
    reg.mergeRemote([remote('v1', '仓库-v1')]); // v2 → orphan
    const v2 = reg.get('v2')!;
    expect(v2.orphan).toBe(true);
    expect(reg.isSyncable(v2)).toBe(false);
  });

  it('listSyncable 排除 orphan（这就是 syncAllVaults 应该用的列表）', () => {
    const reg = registryWith(['v1', 'v2', 'v3']);
    reg.mergeRemote([remote('v1', '仓库-v1'), remote('v3', '仓库-v3')]); // v2 → orphan
    const syncable = reg.listSyncable().map((e) => e.vaultId);
    expect(syncable).toContain('v1');
    expect(syncable).toContain('v3');
    expect(syncable).not.toContain('v2');
    // 对照：list() 仍然包含它（UI 需要展示「云端已删除」）
    expect(reg.list().map((e) => e.vaultId)).toContain('v2');
  });

  it('disabled / 无 location 的条目也不可同步', () => {
    const reg = new VaultRegistry(new MemoryStorage());
    reg.register({ vaultId: 'd1', name: '停用', location: '/x/d1' });
    reg.setStatus('d1', 'disabled');
    expect(reg.isSyncable(reg.get('d1'))).toBe(false);

    // 无 location
    const bare = { vaultId: 'b1', name: 'b', location: '', adapter: 'browser-idb' as const, status: 'active' as const, lastOpenedAt: 0, createdAt: 0, available: false };
    expect(reg.isSyncable(bare)).toBe(false);
    // null / undefined 安全
    expect(reg.isSyncable(null)).toBe(false);
    expect(reg.isSyncable(undefined)).toBe(false);
  });

  it('正常运行仓库可同步', () => {
    const reg = registryWith(['v1']);
    expect(reg.isSyncable(reg.get('v1'))).toBe(true);
  });
});

describe('持久化往返 · orphan 字段不能丢（实测踩过的坑）', () => {
  /**
   * `normalizeEntry()` 是**白名单式**构造新对象（只挑已知字段）。
   *
   * 实测踩到：加了 `orphan` 字段并写进 localStorage，但读盘时没透传，
   * 于是「标了 orphan → 刷新后变回普通条目 → 继续参与同步 → 反弹」。
   * 这条用例专门守住它。
   */
  it('orphan 状态经 localStorage 往返后仍然存在', () => {
    const storage = new MemoryStorage();
    const reg1 = new VaultRegistry(storage);
    reg1.mergeRemote([remote('v1', '仓库-v1'), remote('v2', '仓库-v2')]);
    reg1.mergeRemote([remote('v1', '仓库-v1')]); // v2 → orphan
    expect(reg1.get('v2')?.orphan).toBe(true);

    // 用同一份 storage 重新构造 → 模拟「刷新页面/重启应用」
    const reg2 = new VaultRegistry(storage);
    const v2 = reg2.get('v2');
    expect(v2).toBeDefined();
    expect(v2?.orphan).toBe(true);
    expect(v2?.available).toBe(false);
    expect(v2?.orphanMissCount).toBe(1);
    expect(typeof v2?.orphanSince).toBe('number');
    // 关键：刷新之后它**仍然不可同步**
    expect(reg2.isSyncable(v2)).toBe(false);
  });

  it('miss 计数经往返后仍能继续累加并达到移除阈值', () => {
    const storage = new MemoryStorage();
    const reg1 = new VaultRegistry(storage);
    reg1.mergeRemote([remote('v1', '仓库-v1'), remote('v2', '仓库-v2')]);
    reg1.mergeRemote([remote('v1', '仓库-v1')]); // miss=1

    // 模拟刷新后继续两轮
    const reg2 = new VaultRegistry(storage);
    expect(reg2.get('v2')?.orphanMissCount).toBe(1);
    reg2.mergeRemote([remote('v1', '仓库-v1')]); // miss=2
    expect(reg2.get('v2')?.orphanMissCount).toBe(2);

    const reg3 = new VaultRegistry(storage);
    reg3.mergeRemote([remote('v1', '仓库-v1')]); // miss=3 → 移除
    expect(reg3.get('v2')).toBeNull();
  });

  it('非 orphan 条目往返后不会莫名带上 orphan 字段', () => {
    const storage = new MemoryStorage();
    const reg1 = new VaultRegistry(storage);
    reg1.mergeRemote([remote('v1', '仓库-v1')]);
    const reg2 = new VaultRegistry(storage);
    expect(reg2.get('v1')?.orphan).toBeUndefined();
    expect(reg2.isSyncable(reg2.get('v1'))).toBe(true);
  });
});

describe('反弹复现 · 模拟实测到的完整场景', () => {
  /**
   * 复现生产环境：注册表里有 6 个「云端已删除」的幽灵条目。
   *
   * 断言两件事：
   *  1. 它们会被逐步标记为 orphan 并最终移除；
   *  2. **在任何阶段都不在 listSyncable() 里** —— 这保证不会再去访问
   *     `/api/storage/*`，也就不会触发服务端重新登记。
   */
  it('6 个幽灵条目：不进入同步列表，并在 3 轮后被清除', () => {
    const ghosts = [
      'vaultmvuu8x1gibxqzo06',
      'vaultmvuu69foaszoa8u9',
      'vaultmvuvit17zdnnk53h',
      'vaultmvuvie3ow1lmima1',
      'vaultmvuwmdvqjn2nx9ua',
      'vaultmvuwofkdujt0qkd1',
    ];
    const reals = ['admin', 'vaultmvuqt3rn8ubd9num', 'vaultmvs9ey2vkpj8q5jy', 'vaultmvp3augl2m72a0nw'];

    // 初始：本机注册表里有 10 条（4 真实 + 6 幽灵）
    const reg = registryWith([...reals, ...ghosts]);
    expect(reg.list()).toHaveLength(10);

    // 云端此时只有 4 条真实仓库
    const cloud = reals.map((id) => remote(id, `真实-${id}`));

    // ── 第 1 轮拉取 ──
    reg.mergeRemote(cloud);
    // 6 个幽灵立即被标记
    expect(reg.listOrphans()).toHaveLength(6);
    // **关键断言**：它们一个都不在可同步列表里
    const syncable1 = reg.listSyncable().map((e) => e.vaultId);
    for (const g of ghosts) expect(syncable1).not.toContain(g);
    // 4 个真实仓库仍可同步
    for (const r of reals) expect(syncable1).toContain(r);
    // 尚未物理删除
    expect(reg.list()).toHaveLength(10);

    // ── 第 2 轮 ──
    reg.mergeRemote(cloud);
    expect(reg.list()).toHaveLength(10);
    expect(reg.listSyncable().map((e) => e.vaultId)).not.toContain(ghosts[0]);

    // ── 第 3 轮：达到阈值，幽灵被物理移除 ──
    reg.mergeRemote(cloud);
    expect(reg.list().map((e) => e.vaultId).sort()).toEqual([...reals].sort());
    expect(reg.listOrphans()).toHaveLength(0);
    expect(reg.listSyncable()).toHaveLength(4);
  });

  it('「先删后回」：幽灵被清掉后，云端若真的恢复了它仍能被重新发现', () => {
    const reg = registryWith(['v1', 'ghost']);
    for (let i = 0; i < ORPHAN_REMOVE_AFTER_MISSES; i += 1) {
      reg.mergeRemote([remote('v1', '仓库-v1')]);
    }
    expect(reg.get('ghost')).toBeNull(); // 已被移除

    // 云端真的又有它了（例如另一个设备重新创建了同 id 仓库）
    reg.mergeRemote([remote('v1', '仓库-v1'), remote('ghost', '恢复的仓库')]);
    const back = reg.get('ghost');
    expect(back).toBeDefined();
    expect(back?.orphan).toBeFalsy();
    expect(reg.isSyncable(back)).toBe(true);
  });
});
