/**
 * 图文档扩展名回归测试（1.1.0）。
 *
 * 背景：`Vault.create()` 在**没有显式 path** 时会无条件补 `.md`，
 * 因此「新建流程图」若只传 title='x.flow' 会落成 `x.flow.md`，
 * 导致 EditorPage 按扩展名分流的判定失效（编辑器打不开）。
 *
 * 这里固化正确行为：传 path 得到纯 `.flow` / `.mind`；
 * 并且这些文件的扩展名必须在 reconcile 白名单里（否则不进索引、不出现在文件树）。
 */
import { describe, expect, it } from 'vitest';
import type { VaultAdapter, VaultFileEntry } from '../vault/adapter';
import { Vault } from '../vault/vault';

/** 内存适配器：足够覆盖 create / reconcile / list 的行为 */
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
    return this.files.has(path);
  }
  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const v = this.files.get(path);
    return v === undefined ? null : { size: v.length, mtime: Date.now() };
  }
  async listAll(): Promise<VaultFileEntry[]> {
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      isDirectory: false,
      size: content.length,
      mtime: Date.now(),
    }));
  }
  async listDir(path: string): Promise<VaultFileEntry[]> {
    const prefix = path ? `${path}/` : '';
    return (await this.listAll()).filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'));
  }
  async usage(): Promise<{ bytes: number; files: number }> {
    const all = await this.listAll();
    return { bytes: all.reduce((s, f) => s + f.size, 0), files: all.length };
  }
}

async function makeVault(): Promise<Vault> {
  const v = new Vault(new MemoryAdapter());
  await v.open('memory://test');
  return v;
}

describe('图文档扩展名', () => {
  it('传 path 的 .flow 落成纯 .flow（不被补 .md）', async () => {
    const vault = await makeVault();
    const meta = await vault.create({ path: '流程图-01.flow', content: '{}' });
    expect(meta.path).toBe('流程图-01.flow');
  });

  it('传 path 的 .mind 落成纯 .mind', async () => {
    const vault = await makeVault();
    const meta = await vault.create({ path: '导图-01.mind', content: '{}' });
    expect(meta.path).toBe('导图-01.mind');
  });

  it('只传 title 的 .flow 会被补成 .md（这正是必须传 path 的原因）', async () => {
    const vault = await makeVault();
    const meta = await vault.create({ title: '流程图-02.flow', content: '{}' });
    // 固化这条「坑」的存在：调用方必须传 path 才能得到纯扩展名
    expect(meta.path).toBe('流程图-02.flow.md');
  });

  it('.flow / .mind 会进入仓库索引（reconcile 白名单）', async () => {
    const adapter = new MemoryAdapter();
    const vault = new Vault(adapter);
    await vault.open('memory://test');
    await vault.create({ path: 'a.flow', content: '{}' });
    await vault.create({ path: 'b.mind', content: '{}' });
    await vault.create({ path: 'c.md', content: '# c' });
    // 模拟磁盘上有这三个文件后对账
    const result = await vault.reconcile();
    const paths = vault.list().map((d) => d.path).sort();
    expect(paths).toContain('a.flow');
    expect(paths).toContain('b.mind');
    expect(paths).toContain('c.md');
    expect(result).toBeTruthy();
  });

  it('重命名时 .mind / .flow 也不会被补 .md', async () => {
    const vault = await makeVault();
    const meta = await vault.create({ path: 'old.flow', content: '{}' });
    await vault.rename(meta.docId, 'new-name.flow');
    expect(vault.get(meta.docId)?.path).toBe('new-name.flow');
  });

  it('.flow / .mind 不参与 Markdown 无损往返（扩展名不同即不同处理）', async () => {
    const vault = await makeVault();
    const flow = await vault.create({ path: 'f.flow', content: '{"schema":1}' });
    const md = await vault.create({ path: 'm.md', content: '# 标题' });
    expect(flow.path.endsWith('.flow')).toBe(true);
    expect(md.path.endsWith('.md')).toBe(true);
  });
});
