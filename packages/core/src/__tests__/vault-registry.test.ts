/**
 * 仓库注册表单测（1.1.5）。
 *
 * 重点验证「同一账号多端看到同一套仓库」这件事的基础：
 * - 注册/去重/改名/停用/移除的语义正确；
 * - `pending:` 占位 id 能被真实 vaultId 替换（老用户升级路径）；
 * - 与云端列表合并时，`location` / `available` 保持本机事实不被污染；
 * - 当前仓库不允许移除。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { VaultRegistry, nameFromLocation, LAST_VAULT_KEY } from '../vault/registry';

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

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe('仓库注册表 · 名称推导', () => {
  it('从路径取末段目录名', () => {
    expect(nameFromLocation('C:\\Users\\z\\Documents\\Neo MD')).toBe('Neo MD');
    expect(nameFromLocation('/home/u/vaults/郑磊')).toBe('郑磊');
  });

  it('cloud: 前缀会被剥掉', () => {
    expect(nameFromLocation('cloud:admin')).toBe('admin');
  });

  it('末尾斜杠不影响取名', () => {
    expect(nameFromLocation('C:\\docs\\Neo MD-整理\\')).toBe('Neo MD-整理');
  });
});

describe('仓库注册表 · 注册与去重', () => {
  it('注册新仓库', () => {
    const r = new VaultRegistry(storage);
    const e = r.register({ vaultId: 'v1', location: 'C:\\docs\\Neo MD', name: 'Neo MD' });
    expect(e.vaultId).toBe('v1');
    expect(e.status).toBe('active');
    expect(e.available).toBe(true);
    expect(r.list()).toHaveLength(1);
  });

  it('同一 location 重复注册不产生重复记录', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    expect(r.list()).toHaveLength(1);
  });

  it('多仓库共存（对应用户 PC 端的三个仓库）', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\Neo MD', name: 'Neo MD' });
    r.register({ vaultId: 'v2', location: 'C:\\docs\\Neo MD-整理', name: 'Neo MD-整理' });
    r.register({ vaultId: 'v3', location: 'C:\\docs\\郑磊', name: '郑磊' });
    expect(r.list()).toHaveLength(3);
    expect(r.list().map((e) => e.name).sort()).toEqual(['Neo MD', 'Neo MD-整理', '郑磊'].sort());
  });

  it('持久化后可重新读取', () => {
    const r1 = new VaultRegistry(storage);
    r1.register({ vaultId: 'v1', location: 'C:\\docs\\A', name: 'A' });
    const r2 = new VaultRegistry(storage);
    expect(r2.list()).toHaveLength(1);
    expect(r2.list()[0]!.name).toBe('A');
  });
});

describe('仓库注册表 · 老用户升级路径', () => {
  it('读取 1.1.4 的旧格式（顶层纯数组，无 vaultId）', () => {
    // 1.1.4 及以前 app.ts 直接存的是数组：[{ name, location, lastOpenedAt }]
    storage.setItem(
      'neomd.vaultList.v1',
      JSON.stringify([
        { name: 'Neo MD', location: 'C:\\docs\\Neo MD', lastOpenedAt: 1000 },
        { name: '郑磊', location: 'C:\\docs\\郑磊', lastOpenedAt: 2000 },
      ]),
    );
    const r = new VaultRegistry(storage);
    expect(r.list()).toHaveLength(2);
    // 旧条目没有 vaultId → 补 pending 占位，等打开仓库后换成真实 id
    expect(r.list().every((e) => e.vaultId.startsWith('pending:'))).toBe(true);
    expect(r.list().every((e) => e.status === 'active')).toBe(true);
    expect(r.list().map((e) => e.name).sort()).toEqual(['Neo MD', '郑磊'].sort());
  });

  it('旧格式下用 lastVault 反推出当前仓库', () => {
    storage.setItem(
      'neomd.vaultList.v1',
      JSON.stringify([
        { name: 'A', location: 'C:\\docs\\A', lastOpenedAt: 1 },
        { name: 'B', location: 'C:\\docs\\B', lastOpenedAt: 2 },
      ]),
    );
    storage.setItem(LAST_VAULT_KEY, 'C:\\docs\\B');
    const r = new VaultRegistry(storage);
    expect(r.current()?.name).toBe('B');
  });

  it('新格式（{entries, currentVaultId}）能正确读回', () => {
    const r1 = new VaultRegistry(storage);
    r1.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r1.register({ vaultId: 'v2', location: 'C:\\docs\\B' });
    r1.setCurrent('v2');
    const r2 = new VaultRegistry(storage);
    expect(r2.list()).toHaveLength(2);
    expect(r2.currentId).toBe('v2');
  });

  it('无注册表但有 lastVault 时自动引导出一条记录', () => {
    storage.setItem(LAST_VAULT_KEY, 'C:\\docs\\Neo MD');
    const r = new VaultRegistry(storage);
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]!.location).toBe('C:\\docs\\Neo MD');
    expect(r.list()[0]!.vaultId.startsWith('pending:')).toBe(true);
  });

  it('打开仓库后 pending id 被真实 vaultId 替换', () => {
    storage.setItem(LAST_VAULT_KEY, 'C:\\docs\\Neo MD');
    const r = new VaultRegistry(storage);
    const pending = r.list()[0]!.vaultId;
    expect(pending.startsWith('pending:')).toBe(true);

    r.attachVaultId('C:\\docs\\Neo MD', 'vault-abc123', 'Neo MD');
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]!.vaultId).toBe('vault-abc123');
    expect(r.currentId).toBe('vault-abc123');
  });

  it('attachVaultId 遇到同 id 重复记录时合并去重', () => {
    const r = new VaultRegistry(storage);
    // 模拟：一条 pending 记录 + 一条已有真实 id 的记录指向同一仓库
    r.register({ vaultId: 'pending:C:\\docs\\A', location: 'C:\\docs\\A' });
    r.register({ vaultId: 'real-1', location: 'C:\\docs\\A-copy' });
    expect(r.list()).toHaveLength(2);
    r.attachVaultId('C:\\docs\\A-copy', 'real-1');
    // 已存在同 id → 不新增，数量不变
    expect(r.list()).toHaveLength(2);
  });
});

describe('仓库注册表 · 改名 / 停用 / 当前', () => {
  it('改名生效且持久化', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A', name: 'A' });
    expect(r.rename('v1', '新名字')).toBe(true);
    expect(r.get('v1')!.name).toBe('新名字');
    expect(new VaultRegistry(storage).get('v1')!.name).toBe('新名字');
  });

  it('空名或不存在时改名失败', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A', name: 'A' });
    expect(r.rename('v1', '   ')).toBe(false);
    expect(r.rename('nope', 'x')).toBe(false);
    expect(r.get('v1')!.name).toBe('A');
  });

  it('停用与重新启用', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    expect(r.setStatus('v1', 'disabled')).toBe(true);
    expect(r.get('v1')!.status).toBe('disabled');
    // 停用后不允许切换为当前
    expect(r.setCurrent('v1')).toBe(false);
    expect(r.setStatus('v1', 'active')).toBe(true);
    expect(r.setCurrent('v1')).toBe(true);
  });

  it('setCurrent 会写入 lastVault，兼容既有代码', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.setCurrent('v1');
    expect(storage.getItem(LAST_VAULT_KEY)).toBe('C:\\docs\\A');
    expect(r.current()!.vaultId).toBe('v1');
  });

  it('排序：当前优先，其次最近打开', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.register({ vaultId: 'v2', location: 'C:\\docs\\B' });
    r.register({ vaultId: 'v3', location: 'C:\\docs\\C' });
    r.setCurrent('v2');
    expect(r.listSorted()[0]!.vaultId).toBe('v2');
  });
});

describe('仓库注册表 · 移除', () => {
  it('可以移除非当前仓库', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.register({ vaultId: 'v2', location: 'C:\\docs\\B' });
    r.setCurrent('v1');
    expect(r.remove('v2')).toBe(true);
    expect(r.list()).toHaveLength(1);
  });

  it('当前仓库不允许移除', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A' });
    r.setCurrent('v1');
    expect(r.remove('v1')).toBe(false);
    expect(r.list()).toHaveLength(1);
  });

  it('移除不存在的仓库返回 false', () => {
    const r = new VaultRegistry(storage);
    expect(r.remove('nope')).toBe(false);
  });
});

describe('仓库注册表 · 与云端合并', () => {
  it('云端有本机也有 → 更新名称与状态，但保留本机 location', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'v1', location: 'C:\\docs\\A', name: '本地名' });
    r.mergeRemote([{ vaultId: 'v1', name: '云端名', status: 'disabled', docCount: 9 }]);
    const e = r.get('v1')!;
    expect(e.name).toBe('云端名');
    expect(e.status).toBe('disabled');
    expect(e.docCount).toBe(9);
    // 关键：云端不知道本机路径，不能把它覆盖掉
    expect(e.location).toBe('C:\\docs\\A');
    expect(e.available).toBe(true);
  });

  it('云端有本机没有 → 插入 available=false 的条目', () => {
    const r = new VaultRegistry(storage);
    r.mergeRemote([{ vaultId: 'remote-1', name: '别处的仓库' }]);
    const e = r.get('remote-1')!;
    expect(e).toBeTruthy();
    expect(e.available).toBe(false);
    expect(e.name).toBe('别处的仓库');
  });

  it('本机有云端没有 → 保留不删', () => {
    const r = new VaultRegistry(storage);
    r.register({ vaultId: 'local-1', location: 'C:\\docs\\A' });
    r.mergeRemote([{ vaultId: 'remote-1', name: 'R' }]);
    expect(r.get('local-1')).toBeTruthy();
    expect(r.get('remote-1')).toBeTruthy();
  });

  it('合并是幂等的（重复调用不产生重复条目）', () => {
    const r = new VaultRegistry(storage);
    r.mergeRemote([{ vaultId: 'remote-1', name: 'R' }]);
    r.mergeRemote([{ vaultId: 'remote-1', name: 'R' }]);
    r.mergeRemote([{ vaultId: 'remote-1', name: 'R' }]);
    expect(r.list()).toHaveLength(1);
  });

  it('脏数据不影响其它条目', () => {
    const r = new VaultRegistry(storage);
    r.mergeRemote([{ vaultId: '', name: 'bad' }, { vaultId: 'ok', name: '好' }]);
    expect(r.list()).toHaveLength(1);
    expect(r.get('ok')).toBeTruthy();
  });
});
