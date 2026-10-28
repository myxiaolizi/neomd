import { describe, expect, it } from 'vitest';
import type { ObsidianImportOptions } from '@neomd/shared';
import type { VaultAdapter, VaultFileEntry } from '../vault/adapter';
import { Vault } from '../vault/vault';
import { importObsidianVault, type ObsidianSourceFile } from '../import/obsidian-importer';

/** 内存版仓库适配器，用于在单测里跑真实的 Vault.create 流程 */
class MemoryAdapter implements VaultAdapter {
  readonly kind = 'browser-idb' as const;
  location = 'memory://test';
  private files = new Map<string, string>();

  async open(): Promise<void> {
    /* 无需初始化 */
  }
  async readText(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`不存在: ${path}`);
    return v;
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async writeBinary(): Promise<void> {
    /* 忽略 */
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from) ?? '';
    this.files.delete(from);
    this.files.set(to, v);
  }
  async mkdirp(): Promise<void> {
    /* 内存无目录概念 */
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || [...this.files.keys()].some((k) => k.startsWith(`${path}/`));
  }
  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const v = this.files.get(path);
    return v === undefined ? null : { size: v.length, mtime: Date.now() };
  }
  async listAll(): Promise<VaultFileEntry[]> {
    return [...this.files.entries()]
      .filter(([p]) => !p.startsWith('.neomd'))
      .map(([path, v]) => ({ path, isDirectory: false, size: v.length, mtime: Date.now() }));
  }
  async listDir(): Promise<VaultFileEntry[]> {
    return this.listAll();
  }
  async usage(): Promise<{ bytes: number; files: number }> {
    return { bytes: 0, files: this.files.size };
  }
}

function opts(patch: Partial<ObsidianImportOptions> = {}): ObsidianImportOptions {
  return {
    targetFolder: '',
    keepTimestamps: true,
    convertSyntax: true,
    convertEmbeds: true,
    convertComments: true,
    convertCallouts: true,
    convertHighlights: true,
    normalizeTasks: true,
    normalizeHardBreaks: true,
    skipConfigDirs: true,
    onConflict: 'rename',
    ...patch,
  };
}

/** 造一个已打开的仓库 */
async function makeVault(): Promise<Vault> {
  const vault = new Vault(new MemoryAdapter());
  await vault.open('memory://test');
  return vault;
}

function src(relPath: string, content: string, mtime: number): ObsidianSourceFile {
  return { relPath, content, mtime, size: content.length };
}

describe('importObsidianVault 导入执行器', () => {
  it('把源文件真实 mtime 写入仓库元数据（updatedAt/createdAt）', async () => {
    const vault = await makeVault();
    const mtime = Date.UTC(2021, 2, 15, 8, 0, 0); // 2021-03-15
    const ctime = Date.UTC(2020, 0, 2, 3, 0, 0); // 2020-01-02

    const report = await importObsidianVault(vault, [src('a.md', '# A\n\n内容', mtime)], {
      ...opts(),
      keepTimestamps: true,
    });

    expect(report.total).toBe(1);
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(0);

    const meta = vault.byPath('a.md');
    expect(meta).toBeTruthy();
    // 核心：不是"刚刚"，而是源文件的真实时间
    expect(meta!.updatedAt).toBe(mtime);
    expect(meta!.createdAt).toBe(mtime);
    expect(report.files[0]!.modifiedAt).toBe(mtime);
    expect(ctime).toBeLessThan(mtime);
  });

  it('keepTimestamps 关闭时使用导入时刻', async () => {
    const vault = await makeVault();
    const before = Date.now();
    const oldMtime = Date.UTC(2015, 0, 1);

    await importObsidianVault(vault, [src('b.md', '# B', oldMtime)], {
      ...opts(),
      keepTimestamps: false,
    });

    const meta = vault.byPath('b.md');
    expect(meta!.updatedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(meta!.updatedAt).toBeGreaterThan(oldMtime);
  });

  it('非 Markdown 文件进 ignoredPaths 且不创建文档', async () => {
    const vault = await makeVault();
    const report = await importObsidianVault(
      vault,
      [src('img/cover.png', '', 1000), src('notes/x.md', '# X', 2000), src('.obsidian/app.json', '{}', 3000)],
      opts(),
    );

    expect(report.total).toBe(1); // 只有 x.md 进入候选
    expect(report.imported).toBe(1);
    expect(report.ignoredPaths.some((p) => p.includes('cover.png'))).toBe(true);
    expect(report.ignoredPaths.some((p) => p.includes('.obsidian'))).toBe(true);
    expect(vault.byPath('img/cover.png')).toBeUndefined();
    expect(vault.byPath('notes/x.md')).toBeTruthy();
  });

  it('targetFolder 会作为前缀，且保留源目录结构', async () => {
    const vault = await makeVault();
    const report = await importObsidianVault(vault, [src('sub/deep/n.md', '# N', 5000)], {
      ...opts(),
      targetFolder: '导入结果',
    });

    expect(report.files[0]!.targetPath).toBe('导入结果/sub/deep/n.md');
    expect(vault.byPath('导入结果/sub/deep/n.md')).toBeTruthy();
  });

  it('冲突策略 rename 追加 (2) 后缀', async () => {
    const vault = await makeVault();
    await vault.create({ path: 'same.md', title: 'same', content: '# 原有' });

    const report = await importObsidianVault(vault, [src('same.md', '# 导入的', 6000)], {
      ...opts(),
      onConflict: 'rename',
    });

    expect(report.files[0]!.targetPath).toBe('same (2).md');
    expect(vault.byPath('same.md')).toBeTruthy();
    expect(vault.byPath('same (2).md')).toBeTruthy();
  });

  it('冲突策略 skip 记为 skipped 且不覆盖原文件', async () => {
    const vault = await makeVault();
    await vault.create({ path: 'keep.md', title: 'keep', content: '# 原内容' });

    const report = await importObsidianVault(vault, [src('keep.md', '# 新内容', 7000)], {
      ...opts(),
      onConflict: 'skip',
    });

    expect(report.skipped).toBe(1);
    expect(report.files[0]!.status).toBe('skipped');
    const meta = vault.byPath('keep.md');
    const content = await vault.read(meta!.docId);
    expect(content).toContain('原内容');
  });

  it('冲突策略 overwrite 覆盖内容', async () => {
    const vault = await makeVault();
    const created = await vault.create({ path: 'ow.md', title: 'ow', content: '# 旧' });

    const report = await importObsidianVault(vault, [src('ow.md', '# 新标题\n\n新内容', 8000)], {
      ...opts(),
      onConflict: 'overwrite',
    });

    expect(report.failed).toBe(0);
    const content = await vault.read(created.docId);
    expect(content).toContain('新内容');
  });

  it('overwrite + keepTimestamps 时保留源文件 mtime（不被保存动作刷成当下）', async () => {
    const vault = await makeVault();
    const created = await vault.create({ path: 'ow2.md', title: 'ow2', content: '# 旧内容' });
    // 源文件真实修改时间：2021-03-15
    const sourceMtime = new Date(2021, 2, 15, 10, 30).getTime();

    const report = await importObsidianVault(vault, [src('ow2.md', '# 新内容\n\n正文', sourceMtime)], {
      ...opts(),
      onConflict: 'overwrite',
      keepTimestamps: true,
    });

    expect(report.failed).toBe(0);
    const meta = vault.get(created.docId);
    // 覆盖写入不能把用户 Obsidian 里的历史时间刷成「导入时刻」
    expect(meta?.updatedAt).toBe(sourceMtime);
    // 报告里回报的也必须是实际生效的源时间
    expect(report.files[0]?.modifiedAt).toBe(sourceMtime);
  });

  it('overwrite 但 keepTimestamps=false 时刷新为导入时刻', async () => {
    const vault = await makeVault();
    const created = await vault.create({ path: 'ow3.md', title: 'ow3', content: '# 旧' });
    const sourceMtime = new Date(2019, 0, 1).getTime();
    const before = Date.now();

    await importObsidianVault(vault, [src('ow3.md', '# 新\n\n内容', sourceMtime)], {
      ...opts(),
      onConflict: 'overwrite',
      keepTimestamps: false,
    });

    const meta = vault.get(created.docId);
    expect(meta?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(meta?.updatedAt).not.toBe(sourceMtime);
  });

  it('语法转换会写入报告 conversions 且内容被改写', async () => {
    const vault = await makeVault();
    const content = '> [!note] 标题\n\n有 ==高亮== 与 %%注释%%';

    const report = await importObsidianVault(vault, [src('conv.md', content, 9000)], opts());

    const result = report.files[0]!;
    expect(result.status).toBe('converted');
    expect(result.conversions).toContain('callout');
    expect(result.conversions).toContain('highlight');
    expect(result.conversions).toContain('comment');
    expect(report.converted).toBe(1);

    const meta = vault.byPath('conv.md');
    const stored = await vault.read(meta!.docId);
    expect(stored).toContain('<mark>高亮</mark>');
    expect(stored).toContain('<!-- 注释 -->');
  });

  it('单文件失败不中断整体', async () => {
    // 让适配器在写入指定路径时抛错，模拟磁盘满/权限不足
    class FlakyAdapter extends MemoryAdapter {
      async writeText(path: string, content: string): Promise<void> {
        if (path.includes('boom')) throw new Error('模拟写入失败：磁盘空间不足');
        return super.writeText(path, content);
      }
    }
    const vault = new Vault(new FlakyAdapter());
    await vault.open('memory://test');

    const files = [src('ok1.md', '# 正常一', 100), src('boom.md', '# 会失败', 200), src('ok2.md', '# 正常二', 300)];

    const report = await importObsidianVault(vault, files, opts());

    expect(report.files.length).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.imported).toBe(2);
    const failedFile = report.files.find((f) => f.status === 'failed');
    expect(failedFile?.error).toContain('模拟写入失败');
    // 后续文件仍被导入
    expect(vault.byPath('ok1.md')).toBeTruthy();
    expect(vault.byPath('ok2.md')).toBeTruthy();
  });

  it('路径穿越文件被兜底拦截，不写入仓库', async () => {
    const vault = await makeVault();
    const report = await importObsidianVault(vault, [src('../evil.md', '# 恶意', 100), src('safe.md', '# 安全', 200)], opts());

    expect(report.ignoredPaths.some((p) => p.includes('evil.md'))).toBe(true);
    expect(report.total).toBe(1);
    expect(vault.byPath('evil.md')).toBeUndefined();
    expect(vault.byPath('safe.md')).toBeTruthy();
  });

  it('逐个文件回报进度', async () => {
    const vault = await makeVault();
    const seen: number[] = [];
    await importObsidianVault(
      vault,
      [src('p1.md', '# 1', 1), src('p2.md', '# 2', 2), src('p3.md', '# 3', 3)],
      opts(),
      (p) => seen.push(p.done),
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('报告汇总字段齐全', async () => {
    const vault = await makeVault();
    const report = await importObsidianVault(vault, [src('r.md', '# R', 1234)], opts());

    expect(report.vaultName).toBeTruthy();
    expect(report.startedAt).toBeGreaterThan(0);
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.files)).toBe(true);
    expect(Array.isArray(report.ignoredPaths)).toBe(true);
  });
});
