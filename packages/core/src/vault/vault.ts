import type { DocMeta, VersionRecord, VaultRef } from '@neomd/shared';
import { normalizePath, titleFromPath, uid, uniquePath, sanitizeTitle, dirname, basename } from '@neomd/shared';
import type { VaultAdapter, VaultFileEntry } from './adapter';
import { META_DIR } from './adapter';
import { sha256Hex, nowMs, Mutex } from '../util/hash';
import { resolveTitle, parseDoc } from './markdown-parse';

export interface VaultIndexFile {
  version: number;
  vaultId: string;
  files: Record<string, DocMeta>;
  /** 路径 -> docId 反查 */
  paths: Record<string, string>;
  updatedAt: number;
}

export interface CreateDocOptions {
  /** 指定路径（含 .md） */
  path?: string;
  /** 指定标题 */
  title?: string;
  /** 初始内容 */
  content?: string;
  /** 目标目录 */
  folder?: string;
  /**
   * 保留原始文件的修改时间（1.1.0，Obsidian 导入用）。
   *
   * 导入外部仓库时必须保留源文件的 mtime，否则所有笔记在 Neo MD 里
   * 都会显示为「刚刚创建」，历史顺序与新近度排序全部失真。
   */
  mtime?: number;
  /** 保留原始文件的创建时间；未提供时回落到 mtime */
  ctime?: number;
}

const INDEX_FILE = `${META_DIR}/index.json`;
const VERSIONS_DIR = `${META_DIR}/versions`;
const SNAPSHOT_DIR = `${META_DIR}/snapshots`;

export class Vault {
  readonly adapter: VaultAdapter;
  private files = new Map<string, DocMeta>();
  private pathIndex = new Map<string, string>();
  private mutex = new Mutex();
  private loaded = false;
  vaultId = '';
  name = '';
  /**
   * 后台对账句柄（1.1.8 启动极速化）。
   *
   * `open()` 传 `{ deferReconcile: true }` 时，磁盘对账不在打开路径上等待，
   * 而是挂到这个 Promise 上后台执行；调用方可以在它落地后再刷新文件列表。
   * 未启用延迟对账时该值为 `null`。
   */
  reconcileDeferred: Promise<{ added: number; removed: number; updated: number }> | null = null;
  /**
   * 是否在本地仓库保留历史版本。
   *
   * 产品约定：PC 端所有仓库都有真实本地路径，本地只存「最新版本」的明文 `.md`；
   * 历史版本默认交给云端对象存储（`versions/<docId>/...`），避免本地 `.neomd/versions/`
   * 随编辑次数无限膨胀、拖垮磁盘与索引速度。需要本地留痕时由设置项显式开启。
   */
  keepLocalVersions = false;

  constructor(adapter: VaultAdapter) {
    this.adapter = adapter;
  }

  get location(): string {
    return this.adapter.location;
  }

  /* ---------------- 打开与索引 ---------------- */

  /**
   * 打开仓库。
   *
   * 1.1.8 启动极速化：把「打开」拆成**两段**。
   *
   * - 关键路径（必须 await）：`adapter.open` → 读 `vault.json` → `loadIndex()`。
   *   这一步只读两份小文件，索引里的文件列表立刻可用，UI 可以马上渲染。
   * - 后台路径（可延迟）：`reconcile()` 要遍历磁盘上**每个文件**读内容算 sha256，
   *   2000 篇文档时约 800ms，是首屏最大的单一瓶颈；它只影响「磁盘新增/删除/改动」
   *   这类边角情况，不该挡住用户看文件列表。
   *
   * 1.1.9 跨端仓库 ID 对齐：
   * - 支持传入 `expectedVaultId` 与 `expectedName`。当打开从云端发现的仓库
   *   （如 `cloud:<vaultId>` 或 PC 端新映射的云端仓库目录）且本地尚无 `.neomd/vault.json` 时，
   *   直接使用 `expectedVaultId` 落盘，保证跨端 `vaultId` 100% 一致。
   *
   * @param location 仓库位置
   * @param options.deferReconcile 为 true 时对账不阻塞打开，结果挂到 {@link reconcileDeferred}
   * @param options.expectedVaultId 云端已知的仓库 id（本地未初始化时优先采用）
   * @param options.expectedName 云端或调用方指定的仓库显示名
   * @param options.forceVaultId 强制采用 `expectedVaultId`，即使本地磁盘/索引里已有另一个 id
   */
  async open(
    location: string,
    options: {
      deferReconcile?: boolean;
      expectedVaultId?: string;
      expectedName?: string;
      forceVaultId?: boolean;
    } = {},
  ): Promise<void> {
    await this.adapter.open(location);
    const inferredFromCloud =
      location.startsWith('cloud:') && /^[A-Za-z0-9_-]{4,64}$/.test(location.slice(6).trim())
        ? location.slice(6).trim()
        : '';
    const candidateId = (options.expectedVaultId?.trim() || inferredFromCloud).replace(/^pending:/, '');
    const validExpectedId = /^[A-Za-z0-9_-]{4,64}$/.test(candidateId) ? candidateId : '';

    this.name = options.expectedName?.trim() || basename(location) || 'Neo MD';
    const diskVaultId = await this.readVaultId();
    // 读缓存索引：文件列表立即就绪（用户所见的那一屏数据全部来自这里）
    await this.loadIndex();
    /*
     * 1.1.9 修复「网页端随机 vaultId」：
     *
     * `forceVaultId` 为 true 表示调用方已经从服务端 `/api/vaults` 拿到了该仓库的
     * **权威 id**，此时必须覆盖本地磁盘上的旧 id —— 否则会出现
     * 「服务端登记的是 admin，本机却是 vaultmvs96oocjltn7zwu」这种两端前缀不一致，
     * 表现为同一账号 PC 端与 Web 端永远看不到彼此的文档。
     *
     * 覆盖只改 `vaultId`（决定云端前缀），**不动任何 docId 与文件内容**，
     * 因此不会造成本地文档丢失；旧前缀下的云端对象仍留在对象存储里，
     * 但不再被新前缀引用（属于历史遗留，需要单独迁移）。
     */
    this.vaultId = options.forceVaultId && validExpectedId
      ? validExpectedId
      : diskVaultId || validExpectedId || this.vaultId || uid('vault');
    const overwrite = Boolean(
      validExpectedId && diskVaultId !== validExpectedId && (options.forceVaultId || this.files.size === 0),
    );
    await this.writeVaultId(this.vaultId, overwrite);
    if (overwrite) {
      // vault.json 换了 id，索引里也要同步，否则下次启动 loadIndex() 会把旧 id 读回来
      await this.saveIndex();
    }
    this.loaded = true;

    if (options.deferReconcile) {
      // 后台对账：失败也不能影响已打开的仓库，因此吞掉异常并回落到「无变化」
      this.reconcileDeferred = this.reconcile().catch(() => ({ added: 0, removed: 0, updated: 0 }));
    } else {
      await this.reconcile();
    }
  }

  private async readVaultId(): Promise<string | null> {
    try {
      const meta = await this.adapter.readText(`${META_DIR}/vault.json`);
      return (JSON.parse(meta) as { id?: string }).id ?? null;
    } catch {
      return null;
    }
  }

  private async writeVaultId(id: string, forceOverwrite = false): Promise<void> {
    if (!forceOverwrite && (await this.adapter.exists(`${META_DIR}/vault.json`))) return;
    await this.adapter.mkdirp(META_DIR);
    await this.adapter.writeText(
      `${META_DIR}/vault.json`,
      JSON.stringify({ id, name: this.name, createdAt: nowMs() }, null, 2),
    );
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await this.adapter.readText(INDEX_FILE);
      const idx = JSON.parse(raw) as VaultIndexFile;
      this.files = new Map(Object.entries(idx.files ?? {}));
      this.pathIndex = new Map(Object.entries(idx.paths ?? {}));
      this.vaultId = idx.vaultId || this.vaultId;
    } catch {
      this.files.clear();
      this.pathIndex.clear();
    }
  }

  async saveIndex(): Promise<void> {
    const idx: VaultIndexFile = {
      version: 1,
      vaultId: this.vaultId,
      files: Object.fromEntries(this.files),
      paths: Object.fromEntries(this.pathIndex),
      updatedAt: nowMs(),
    };
    await this.adapter.mkdirp(META_DIR);
    await this.adapter.writeText(INDEX_FILE, JSON.stringify(idx));
  }

  /** 与磁盘对账：磁盘新增的文件纳入索引，索引中消失的文件标记删除 */
  async reconcile(): Promise<{ added: number; removed: number; updated: number }> {
    return this.mutex.run(async () => {
      const diskFiles = (await this.adapter.listAll()).filter((f) =>
        // 1.1.0 起把 `.mind`（思维导图）与 `.flow`（流程图）也纳入仓库文档类型，
        // 与既有的 `.board` / `.base` 同构：都走同一套索引、同步与历史版本链路。
        /\.(md|markdown|board|base|mind|flow)$/i.test(f.path),
      );
      const diskPaths = new Set(diskFiles.map((f) => f.path));
      let added = 0;
      let removed = 0;
      let updated = 0;

      for (const f of diskFiles) {
        const existingId = this.pathIndex.get(f.path);
        const meta = existingId ? this.files.get(existingId) : undefined;
        if (!meta) {
          const docId = uid('doc');
          const md = await this.safeRead(f.path);
          const newMeta: DocMeta = {
            docId,
            path: f.path,
            title: resolveTitle(md, titleFromPath(f.path)),
            rev: 1,
            hash: await sha256Hex(md),
            size: f.size,
            createdAt: f.mtime || nowMs(),
            updatedAt: f.mtime || nowMs(),
            syncedRev: null,
            deletedAt: null,
          };
          this.files.set(docId, newMeta);
          this.pathIndex.set(f.path, docId);
          added += 1;
        } else if (meta.syncedRev === null) {
          // 未同步的文件以磁盘为准
          const md = await this.safeRead(f.path);
          const hash = await sha256Hex(md);
          if (hash !== meta.hash) {
            meta.hash = hash;
            meta.size = f.size;
            meta.title = resolveTitle(md, titleFromPath(f.path));
            meta.updatedAt = f.mtime || nowMs();
            updated += 1;
          }
        }
      }

      for (const [path, docId] of [...this.pathIndex]) {
        if (!diskPaths.has(path)) {
          const meta = this.files.get(docId);
          if (meta && !meta.deletedAt && meta.syncedRev === null) {
            this.files.delete(docId);
            this.pathIndex.delete(path);
            removed += 1;
          } else if (meta) {
            meta.deletedAt = meta.deletedAt ?? nowMs();
          }
        }
      }

      await this.saveIndex();
      return { added, removed, updated };
    });
  }

  private async safeRead(path: string): Promise<string> {
    try {
      return await this.adapter.readText(path);
    } catch {
      return '';
    }
  }

  /* ---------------- 查询 ---------------- */

  get isLoaded(): boolean {
    return this.loaded;
  }

  list(): DocMeta[] {
    return [...this.files.values()].filter((f) => !f.deletedAt).sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  }

  listAll(): DocMeta[] {
    return [...this.files.values()];
  }

  recent(limit = 20): DocMeta[] {
    return this.list()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  get(docId: string): DocMeta | undefined {
    return this.files.get(docId);
  }

  byPath(path: string): DocMeta | undefined {
    const id = this.pathIndex.get(normalizePath(path));
    return id ? this.files.get(id) : undefined;
  }

  /** 按标题模糊查找（用于 wikilink 解析） */
  findByName(name: string): DocMeta | undefined {
    const target = name.trim().toLowerCase();
    const byTitle = this.list().find((f) => f.title.toLowerCase() === target);
    if (byTitle) return byTitle;
    const withExt = `${target}.md`;
    const byPath = this.list().find((f) => f.path.toLowerCase() === withExt || f.path.toLowerCase().endsWith(`/${withExt}`));
    if (byPath) return byPath;
    return this.list().find((f) => f.title.toLowerCase().includes(target));
  }

  folders(): string[] {
    const set = new Set<string>();
    for (const f of this.list()) {
      const d = dirname(f.path);
      if (d) {
        const parts = d.split('/');
        for (let i = 1; i <= parts.length; i += 1) set.add(parts.slice(0, i).join('/'));
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  /* ---------------- 读写 ---------------- */

  async read(docId: string): Promise<string> {
    const meta = this.files.get(docId);
    if (!meta) throw new Error(`文档不存在: ${docId}`);
    return this.adapter.readText(meta.path);
  }

  async readByPath(path: string): Promise<string> {
    return this.adapter.readText(normalizePath(path));
  }

  /**
   * 保存内容。返回更新后的元数据；内容未变化时不产生新版本。
   * recordVersion=false 时仅落盘更新文件与索引，不生成历史版本快照（供高频自动保存使用）。
   *
   * @param preserveMtime 可选：把 `updatedAt` 固定为给定时间。
   *   用于「导入时覆盖同名文件」——否则源文件的真实修改时间会被保存动作刷成当下，
   *   用户的 Obsidian 时间线就丢了。普通保存不要传这个参数。
   */
  async save(
    docId: string,
    content: string,
    origin = 'save',
    recordVersion = true,
    deviceName = '',
    preserveMtime?: number,
  ): Promise<DocMeta> {
    return this.mutex.run(async () => {
      const meta = this.files.get(docId);
      if (!meta) throw new Error(`文档不存在: ${docId}`);
      const hash = await sha256Hex(content);
      if (hash === meta.hash) return meta;

      // 保存前快照上一版（用于历史与恢复）
      if (recordVersion && meta.hash) {
        await this.writeVersion(meta, origin === 'restore' ? 'restore' : 'save', deviceName);
      }

      await this.adapter.writeText(meta.path, content);
      const next: DocMeta = {
        ...meta,
        // rev 必须随内容变化递增：它是内容寻址的版本号，云端 blob/版本键都依赖它。
        // 是否在本地落盘历史版本由 keepLocalVersions 决定，与 rev 自增无关。
        rev: meta.rev + 1,
        hash,
        size: content.length,
        updatedAt: preserveMtime && preserveMtime > 0 ? preserveMtime : nowMs(),
        title: resolveTitle(content, meta.title),
        deletedAt: null,
      };
      this.files.set(docId, next);
      await this.saveIndex();
      return next;
    });
  }

  async create(options: CreateDocOptions = {}): Promise<DocMeta> {
    return this.mutex.run(async () => {
      const taken = new Set(this.pathIndex.keys());
      const title = sanitizeTitle(options.title ?? '无标题') || '无标题';
      let path = options.path ? normalizePath(options.path) : '';
      if (!path) {
        const folder = options.folder ? `${normalizePath(options.folder)}/` : '';
        path = uniquePath(`${folder}${title}.md`, taken);
      }
      // 1.1.0：`.mind` / `.flow` 是合法文档扩展名，不能被补成 `.md`
      if (!/\.(md|markdown|mind|flow|board|base)$/i.test(path)) path += '.md';
      const content = options.content ?? `# ${title}\n\n`;
      await this.adapter.writeText(path, content);
      const docId = uid('doc');
      // 导入场景（mtime 存在）要保留源文件的真实时间，否则历史新近度全部失真
      const createdAt = options.ctime ?? options.mtime ?? nowMs();
      const updatedAt = options.mtime ?? nowMs();
      const meta: DocMeta = {
        docId,
        path,
        title,
        rev: 1,
        hash: await sha256Hex(content),
        size: content.length,
        createdAt,
        updatedAt,
        syncedRev: null,
        deletedAt: null,
      };
      this.files.set(docId, meta);
      this.pathIndex.set(path, docId);
      await this.saveIndex();
      return meta;
    });
  }

  /** 重命名/移动并重写全库 wikilink */
  async rename(docId: string, nextPath: string): Promise<{ meta: DocMeta; rewritten: number }> {
    return this.mutex.run(async () => {
      const meta = this.files.get(docId);
      if (!meta) throw new Error(`文档不存在: ${docId}`);
      let target = normalizePath(nextPath);
      // 重命名同样要保留图文档扩展名（.mind/.flow），否则会被补成 .md
      if (!/\.(md|markdown|mind|flow|board|base)$/i.test(target)) target += '.md';
      if (target === meta.path) return { meta, rewritten: 0 };
      if (this.pathIndex.has(target)) throw new Error(`目标路径已存在: ${target}`);

      const oldTitle = meta.title;
      const newTitle = titleFromPath(target);
      await this.adapter.rename(meta.path, target);
      this.pathIndex.delete(meta.path);
      this.pathIndex.set(target, docId);
      const updated: DocMeta = { ...meta, path: target, title: newTitle, updatedAt: nowMs() };
      this.files.set(docId, updated);
      await this.saveIndex();

      const rewritten = await this.rewriteLinks(oldTitle, newTitle, meta.path, target);
      return { meta: updated, rewritten };
    });
  }

  /** 把所有 [[oldTitle]] 改为 [[newTitle]]，并更新 markdown 相对链接 */
  private async rewriteLinks(oldTitle: string, newTitle: string, oldPath: string, newPath: string): Promise<number> {
    let count = 0;
    for (const doc of this.list()) {
      if (doc.docId === this.pathIndex.get(newPath)) continue;
      let content = await this.safeRead(doc.path);
      const original = content;
      const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp(`\\[\\[${escaped}((?:#[^\\]|]*)?(?:\\|[^\\]]*)?)\\]\\]`, 'g'), `[[${newTitle}$1]]`);
      const relOld = oldPath.replace(/\.md$/i, '');
      const relNew = newPath.replace(/\.md$/i, '');
      if (content.includes(`(${relOld})`)) content = content.split(`(${relOld})`).join(`(${relNew})`);
      if (content !== original) {
        await this.adapter.writeText(doc.path, content);
        const meta = this.files.get(doc.docId);
        if (meta) {
          this.files.set(doc.docId, {
            ...meta,
            rev: meta.rev + 1,
            hash: await sha256Hex(content),
            size: content.length,
            updatedAt: nowMs(),
          });
        }
        count += 1;
      }
    }
    if (count) await this.saveIndex();
    return count;
  }

  async remove(docId: string, opts: { deleteFile?: boolean } = {}): Promise<void> {
    await this.mutex.run(async () => {
      const meta = this.files.get(docId);
      if (!meta) return;
      if (meta.hash) await this.writeVersion(meta, 'delete');
      if (opts.deleteFile) {
        await this.adapter.remove(meta.path);
        this.pathIndex.delete(meta.path);
        this.files.delete(docId);
      } else {
        this.files.set(docId, { ...meta, deletedAt: nowMs() });
      }
      await this.saveIndex();
    });
  }

  /** 导入外部 md 文件到仓库 */
  async importFile(name: string, content: string, folder = '导入'): Promise<DocMeta> {
    const title = sanitizeTitle(titleFromPath(name)) || '导入文件';
    return this.create({ title, content, folder });
  }

  /* ---------------- 版本历史 ---------------- */

  private versionPath(docId: string, rev: number, hash: string, deviceName = ''): string {
    const cleanDev = deviceName.replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]/g, '').slice(0, 24);
    return cleanDev ? `${VERSIONS_DIR}/${docId}/${rev}-${hash}-${cleanDev}.md` : `${VERSIONS_DIR}/${docId}/${rev}-${hash}.md`;
  }

  private async writeVersion(meta: DocMeta, _origin: string, deviceName = ''): Promise<void> {
    // 本地只存最新版本（产品约定）：默认不写 `.neomd/versions/`，历史版本由云端对象存储承载。
    if (!this.keepLocalVersions) return;
    try {
      const content = await this.adapter.readText(meta.path);
      const key = this.versionPath(meta.docId, meta.rev, meta.hash, deviceName);
      if (!(await this.adapter.exists(key))) {
        await this.adapter.writeText(key, content);
      }
    } catch {
      /* 文件可能已被外部删除，忽略 */
    }
  }

  async listVersions(docId: string): Promise<VersionRecord[]> {
    try {
      const entries = await this.adapter.listDir(`${VERSIONS_DIR}/${docId}`);
      const out: VersionRecord[] = [];
      for (const e of entries) {
        if (e.isDirectory) continue;
        const m = /^(\d+)-([0-9a-f]+)(?:-([^.]+))?\.md$/.exec(e.path.split('/').pop() ?? '');
        if (!m) continue;
        out.push({
          id: `${docId}-${m[1]}-${m[2]}`,
          docId,
          rev: Number(m[1]),
          hash: m[2]!,
          size: e.size,
          createdAt: e.mtime,
          origin: 'save',
          storageKey: e.path,
          synced: false,
          label: m[3] || '',
        });
      }
      return out.sort((a, b) => b.rev - a.rev);
    } catch {
      return [];
    }
  }

  async readVersion(storageKey: string): Promise<string> {
    return this.adapter.readText(storageKey);
  }

  async restoreVersion(docId: string, storageKey: string): Promise<DocMeta> {
    const content = await this.adapter.readText(storageKey);
    return this.save(docId, content, 'restore');
  }

  /**
   * 清理本地超期或超出数量上限的历史版本（1.1.9）。
   *
   * @param maxDays 保留天数（<=0 表示不按天数限制）
   * @param maxCount 每篇最多保留版本数（<=0 表示不按数量限制）
   * @returns 实际删除的版本文件数
   */
  async pruneVersions(maxDays = 30, maxCount = 50): Promise<number> {
    let removed = 0;
    const cutoff = maxDays > 0 ? nowMs() - maxDays * 86_400_000 : 0;
    for (const doc of this.listAll()) {
      const versions = await this.listVersions(doc.docId);
      if (!versions.length) continue;
      for (let i = 0; i < versions.length; i += 1) {
        const v = versions[i]!;
        const overCount = maxCount > 0 && i >= maxCount;
        const overAge = cutoff > 0 && v.createdAt > 0 && v.createdAt < cutoff;
        if ((overCount || overAge) && v.storageKey) {
          try {
            await this.adapter.remove(v.storageKey);
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return removed;
  }

  /* ---------------- 用量 ---------------- */

  async usage(): Promise<{ bytes: number; files: number; metaBytes: number }> {
    const all = await this.adapter.listAll();
    const content = all.filter((f) => !f.path.startsWith(META_DIR));
    const meta = all.filter((f) => f.path.startsWith(META_DIR));
    return {
      bytes: content.reduce((s, f) => s + f.size, 0),
      files: content.length,
      metaBytes: meta.reduce((s, f) => s + f.size, 0),
    };
  }

  async snapshot(label = 'auto'): Promise<string> {
    const files = this.list();
    const payload = {
      label,
      at: nowMs(),
      vaultId: this.vaultId,
      docs: await Promise.all(
        files.map(async (f) => ({ path: f.path, content: await this.safeRead(f.path) })),
      ),
    };
    const path = `${SNAPSHOT_DIR}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await this.adapter.mkdirp(SNAPSHOT_DIR);
    await this.adapter.writeText(path, JSON.stringify(payload));
    return path;
  }

  async listSnapshots(): Promise<Array<{ path: string; size: number; mtime: number }>> {
    try {
      const entries = await this.adapter.listDir(SNAPSHOT_DIR);
      return entries.filter((e) => !e.isDirectory).map((e) => ({ path: e.path, size: e.size, mtime: e.mtime }));
    } catch {
      return [];
    }
  }

  async restoreSnapshot(path: string): Promise<number> {
    const raw = await this.adapter.readText(path);
    const payload = JSON.parse(raw) as { docs: Array<{ path: string; content: string }> };
    let count = 0;
    for (const doc of payload.docs) {
      await this.adapter.writeText(doc.path, doc.content);
      count += 1;
    }
    await this.reconcile();
    return count;
  }

  /* ---------------- 统计 ---------------- */

  stats(): { files: number; folders: number; chars: number; words: number; tags: number } {
    const list = this.list();
    return {
      files: list.length,
      folders: this.folders().length,
      chars: 0,
      words: 0,
      tags: 0,
    };
  }

  /** 生成用于同步的本地状态 */
  localStates(): Array<{
    docId: string;
    rev: number;
    hash: string;
    path: string;
    title: string;
    size: number;
    updatedAt: number;
    createdAt: number;
    syncedRev: number | null;
    deletedAt: number | null;
  }> {
    return this.listAll().map((f) => ({
      docId: f.docId,
      rev: f.rev,
      hash: f.hash,
      path: f.path,
      title: f.title,
      size: f.size,
      updatedAt: f.updatedAt,
      createdAt: f.createdAt,
      syncedRev: f.syncedRev,
      deletedAt: f.deletedAt,
    }));
  }

  markSynced(docId: string, rev: number): void {
    const meta = this.files.get(docId);
    if (!meta) return;
    this.files.set(docId, { ...meta, syncedRev: rev });
  }

  /** 由同步引擎写入远端内容 */
  async applyRemote(
    entry: { docId: string; path: string; title: string; rev: number; hash: string; size: number; createdAt: number; updatedAt: number; deletedAt: number | null },
    content: string,
  ): Promise<void> {
    const existing = this.files.get(entry.docId);
    const path = existing?.path ?? entry.path;
    const taken = this.pathIndex.get(path);
    const finalPath = taken && taken !== entry.docId ? uniquePath(path, new Set(this.pathIndex.keys())) : path;
    await this.adapter.writeText(finalPath, content);
    const meta: DocMeta = {
      docId: entry.docId,
      path: finalPath,
      title: resolveTitle(content, entry.title || titleFromPath(finalPath)),
      rev: entry.rev,
      hash: entry.hash,
      size: entry.size || content.length,
      createdAt: existing?.createdAt ?? entry.createdAt,
      updatedAt: entry.updatedAt,
      syncedRev: entry.rev,
      deletedAt: null,
    };
    this.files.set(entry.docId, meta);
    this.pathIndex.set(finalPath, entry.docId);
    await this.saveIndex();
  }

  /** 解析文档的 wikilink 目标 */
  linkedDocs(docId: string): DocMeta[] {
    const meta = this.files.get(docId);
    if (!meta) return [];
    const out: DocMeta[] = [];
    const seen = new Set<string>();
    // 依赖 db 索引由外部提供，这里仅做名称解析兜底
    return out.filter((d) => !seen.has(d.docId));
  }

  /** 内容中出现的 [[名称]] 列表 */
  async outgoingNames(docId: string): Promise<string[]> {
    const meta = this.files.get(docId);
    if (!meta) return [];
    const content = await this.safeRead(meta.path);
    const parsed = parseDoc(content);
    return parsed.links.filter((l) => l.kind !== 'markdown').map((l) => l.target);
  }

  filesUnder(folder: string): DocMeta[] {
    const prefix = `${normalizePath(folder)}/`;
    return this.list().filter((f) => f.path.startsWith(prefix));
  }

  entries(): VaultFileEntry[] {
    return this.list().map((f) => ({ path: f.path, isDirectory: false, size: f.size, mtime: f.updatedAt }));
  }

  ref(): VaultRef {
    return {
      id: this.vaultId,
      name: this.name,
      location: this.location,
      adapter: this.adapter.kind,
      createdAt: nowMs(),
      lastOpenedAt: nowMs(),
    };
  }
}
