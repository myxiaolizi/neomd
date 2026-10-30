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

/**
 * 本地历史版本索引（1.2.1 缺陷5 修复引入）。
 *
 * ## 为什么必须有一份自己的索引
 *
 * 原先 `listVersions()` 完全依赖 `adapter.listDir('.neomd/versions/<docId>')`。
 * 但两端适配器的目录能力并不一致：
 *  - 桌面端 `NativeVaultAdapter.listDir()` 直接读真实目录，能看到 `.neomd/**`；
 *  - 网页端 `BrowserVaultAdapter.listDir()` 是**从 `listAll()` 派生**的，
 *    而 `listAll()` 明确 `continue` 掉了所有 `.neomd` 开头的路径（索引/对账不能把元数据
 *    当成正文文档）。
 *
 * 于是网页端（以及任何基于 IndexedDB 的仓库）**永远列不出本地历史版本**：
 * `writeVersion()` 明明把快照写进了 `.neomd/versions/<docId>/`，
 * 面板却读到空数组，只能退化去查云端 —— 这是「历史版本只剩一版」的成因之一。
 *
 * 修复方式不是改适配器（那是所有对账逻辑的公共依赖，风险高），而是在写入侧
 * 同步维护一份 `index.json`：列出时「索引 ∪ 目录」取并集，
 * 目录不可见的端也能靠索引拿到完整列表；目录可见的端则用 mtime 校正索引。
 */
const VERSION_INDEX_FILE = `${VERSIONS_DIR}/index.json`;

/** 本地版本索引中的一条记录（文件真身仍在 `.neomd/versions/<docId>/` 下） */
interface LocalVersionIndexEntry {
  docId: string;
  rev: number;
  hash: string;
  /** 归档时刻（毫秒），也是 key 里保证唯一的那一段 */
  ts: number;
  device: string;
  size: number;
  createdAt: number;
  storageKey: string;
  origin: string;
}

interface LocalVersionIndexFile {
  version: 1;
  entries: LocalVersionIndexEntry[];
}

/** 单篇文档在本地索引里最多保留的条目数（防止 index.json 无限膨胀） */
const VERSION_INDEX_MAX_PER_DOC = 300;

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
  /**
   * 本地版本归档时刻的单调递增游标（1.2.1）。
   *
   * 版本 key 里要靠 `ts` 保证唯一：同一毫秒内连续两次保存（自动保存 1.5s 防抖 +
   * 立即手动保存、或批量恢复时）`Date.now()` 会给出**相同**的毫秒数，
   * 于是两个不同内容落进同一个 key，后写的把先写的覆盖掉 ——
   * 这正是「改了很多次只有一版」在毫秒级并发下的表现。
   * 用 `max(now, last+1)` 保证严格递增，既不重复也不倒退。
   */
  private lastVersionTs = 0;
  /**
   * 本地版本索引的进程内缓存（1.2.1）。
   *
   * 见 {@link readVersionIndex} 的说明：`pruneVersions()` 会对全库每篇文档调用
   * `listVersions()`，若每次都重新 read + parse `index.json` 就是 O(N²) 次 IO。
   * 缓存由 `writeVersionIndex()` 统一失效，`adapter.remove()` 路径（清理版本）
   * 也会重建缓存，因此不会读到已删除的条目。
   */
  private versionIndexCache: LocalVersionIndexEntry[] | null = null;

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
    // 换了仓库/位置 → 上一份仓库的版本索引缓存必须失效，否则会串到新仓库
    this.versionIndexCache = null;
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

  /**
   * 本地历史版本的存储 key。
   *
   * ## 1.2.1 修复：key 必须唯一，否则同一 rev+hash 会互相覆盖
   *
   * 旧格式是 `<rev>-<hash>-<dev>.md`，两个字段都是**内容派生**的：
   *  - `rev` 只随内容变化递增，`hash` 是内容的 sha256 前 16 位；
   *  - 于是「保存 A → 保存 B → 回滚到 A」时，第三次的 rev 虽然变大，
   *    但若走的是同一 rev 的重复归档（`writeVersion` 的 `exists()` 短路、
   *    或恢复时 `save()` 内部沿用旧 rev），key 完全一致 → 旧快照被静默覆盖。
   * 更致命的是：`rev` 相同、`hash` 相同**必然**意味着 key 相同，
   * 而 `exists()` 判断让第二次写入直接跳过，历史里就只剩下第一次那条。
   *
   * 新格式 `<ts>-<rev>-<hash>[-<dev>].md`：
   *  - `ts` 是**归档时刻**（毫秒，且经 {@link nextVersionTs} 保证严格递增），
   *    与云端 `versions/<docId>/<ts>-<rev>-<hash>.md` 语义完全对齐；
   *  - 同一个 rev 被多次归档（例如从多个设备分别保存同一内容）会得到不同的 ts，
   *    因此**不会互相覆盖**，面板里能如实看到「这一版被归档过几次」；
   *  - 老格式的文件仍然可被 {@link parseVersionKey} 解析，历史数据不丢。
   */
  private versionPath(docId: string, ts: number, rev: number, hash: string, deviceName = ''): string {
    const cleanDev = deviceName.replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]/g, '').slice(0, 24);
    const base = `${VERSIONS_DIR}/${docId}/${ts}-${rev}-${hash}`;
    return cleanDev ? `${base}-${cleanDev}.md` : `${base}.md`;
  }

  /** 取一个严格递增的归档时间戳（同毫秒内连续保存也不会撞 key） */
  private nextVersionTs(): number {
    const ts = Math.max(nowMs(), this.lastVersionTs + 1);
    this.lastVersionTs = ts;
    return ts;
  }

  /**
   * 解析版本文件名（同时兼容新老两种格式）。
   *
   * - 新格式：`<ts>-<rev>-<hash>[-<dev>].md`
   * - 老格式：`<rev>-<hash>[-<dev>].md`（ts 视为 0，由调用方回落到文件 mtime）
   */
  private parseVersionKey(name: string): { ts: number; rev: number; hash: string; label: string } | null {
    const file = name.split('/').pop() ?? '';
    // 新格式：13 位以上时间戳 + rev + hash
    const modern = /^(\d{10,})-(\d+)-([0-9a-f]{4,64})(?:-([^.]+))?\.md$/i.exec(file);
    if (modern) {
      return { ts: Number(modern[1]), rev: Number(modern[2]), hash: modern[3]!.toLowerCase(), label: modern[4] ?? '' };
    }
    // 老格式：rev + hash（ts=0，稍后用 mtime / 索引里的 createdAt 补齐）
    const legacy = /^(\d+)-([0-9a-f]{4,64})(?:-([^.]+))?\.md$/i.exec(file);
    if (legacy) {
      return { ts: 0, rev: Number(legacy[1]), hash: legacy[2]!.toLowerCase(), label: legacy[3] ?? '' };
    }
    return null;
  }

  private async readVersionIndex(): Promise<LocalVersionIndexEntry[]> {
    /*
     * 进程内缓存：`pruneVersions()` 会遍历全库每篇文档调用一次 `listVersions()`，
     * 每篇都重新 read + JSON.parse 同一份 `index.json` 会退化成 O(N²) 次 IO
     * （700 篇的仓库实测会卡住好几秒）。缓存只在 `writeVersionIndex()` 时失效，
     * 而所有写入都经过它，因此不会读到脏数据。
     */
    if (this.versionIndexCache) return this.versionIndexCache;
    try {
      const raw = await this.adapter.readText(VERSION_INDEX_FILE);
      const idx = JSON.parse(raw) as LocalVersionIndexFile;
      this.versionIndexCache = Array.isArray(idx?.entries) ? idx.entries : [];
    } catch {
      this.versionIndexCache = [];
    }
    return this.versionIndexCache;
  }

  private async writeVersionIndex(entries: LocalVersionIndexEntry[]): Promise<void> {
    // 单篇文档超量时只保留最新的 N 条，避免 index.json 随编辑次数无限膨胀
    const byDoc = new Map<string, LocalVersionIndexEntry[]>();
    for (const e of entries) {
      const list = byDoc.get(e.docId) ?? [];
      list.push(e);
      byDoc.set(e.docId, list);
    }
    const trimmed: LocalVersionIndexEntry[] = [];
    for (const list of byDoc.values()) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      trimmed.push(...list.slice(0, VERSION_INDEX_MAX_PER_DOC));
    }
    const payload: LocalVersionIndexFile = { version: 1, entries: trimmed };
    try {
      await this.adapter.mkdirp(VERSIONS_DIR);
      await this.adapter.writeText(VERSION_INDEX_FILE, JSON.stringify(payload));
      // 写成功后同步刷新缓存（外部队列里其它调用点拿到的一定是最新快照）
      this.versionIndexCache = trimmed;
    } catch {
      /* 索引写失败不影响版本文件本身，listVersions 仍会尝试目录列举 */
      this.versionIndexCache = null;
    }
  }

  /**
   * 把当前内容归档为本地历史版本。
   *
   * ## 1.2.1 修复要点
   *
   * 1. **key 带唯一时间戳**（见 {@link versionPath}），同一 rev 反复归档不再覆盖；
   * 2. **写索引**（{@link writeVersionIndex}），让网页端 IndexedDB 这类
   *    `listAll()` 过滤 `.neomd` 的适配器也能列出历史；
   * 3. 保留 `keepLocalVersions` 开关语义：关闭时不落盘（产品约定：PC 端历史交给云端）。
   */
  private async writeVersion(meta: DocMeta, origin: string, deviceName = ''): Promise<void> {
    // 本地只存最新版本（产品约定）：默认不写 `.neomd/versions/`，历史版本由云端对象存储承载。
    if (!this.keepLocalVersions) return;
    try {
      const content = await this.adapter.readText(meta.path);
      const ts = this.nextVersionTs();
      const key = this.versionPath(meta.docId, ts, meta.rev, meta.hash, deviceName);
      await this.adapter.writeText(key, content);
      const entries = await this.readVersionIndex();
      entries.push({
        docId: meta.docId,
        rev: meta.rev,
        hash: meta.hash,
        ts,
        device: deviceName,
        size: content.length,
        createdAt: ts,
        storageKey: key,
        origin,
      });
      await this.writeVersionIndex(entries);
    } catch {
      /* 文件可能已被外部删除，忽略 */
    }
  }

  /**
   * 列出某篇文档的本地历史版本。
   *
   * ## 1.2.1 修复：目录 ∪ 索引，并按 createdAt 倒序 + 去重
   *
   * 旧实现有两个缺陷：
   *  1. 只读目录 → 网页端 `BrowserVaultAdapter.listDir()` 从 `listAll()` 派生，
   *     而 `listAll()` 过滤掉 `.neomd/**`，于是**永远返回空**（历史版本丢失的成因之一）；
   *  2. 排序只按 `rev` 倒序 → 同一 rev 的多次归档顺序不确定，
   *     且与云端按时间排序的结果无法合并成一条时间线。
   *
   * 现在：索引里有的按索引（含精确 createdAt），目录里多出来的（老格式文件、
   * 索引尚未写入的）按文件名/mtime 兜底；两者按 storageKey 去重后统一倒序。
   */
  async listVersions(docId: string): Promise<VersionRecord[]> {
    const byKey = new Map<string, VersionRecord>();

    // ① 索引：唯一可靠的来源（尤其对 IndexedDB 适配器）
    const indexed = (await this.readVersionIndex()).filter((e) => e.docId === docId);
    for (const e of indexed) {
      byKey.set(e.storageKey, {
        id: `${docId}-${e.ts}-${e.rev}-${e.hash}`,
        docId,
        rev: e.rev,
        hash: e.hash,
        size: e.size,
        createdAt: e.createdAt || e.ts,
        origin: e.origin || 'save',
        storageKey: e.storageKey,
        synced: false,
        label: e.device || '',
      });
    }

    // ② 目录：桌面端能直接读到真实文件；索引丢失（旧版本升级）时也能自愈
    try {
      const entries = await this.adapter.listDir(`${VERSIONS_DIR}/${docId}`);
      for (const e of entries) {
        if (e.isDirectory) continue;
        const parsed = this.parseVersionKey(e.path);
        if (!parsed) continue;
        if (byKey.has(e.path)) {
          // 索引里已有：用文件 mtime 校正 size（索引可能滞后），不覆盖 createdAt
          const cur = byKey.get(e.path)!;
          byKey.set(e.path, { ...cur, size: e.size || cur.size });
          continue;
        }
        byKey.set(e.path, {
          id: `${docId}-${parsed.ts}-${parsed.rev}-${parsed.hash}`,
          docId,
          rev: parsed.rev,
          hash: parsed.hash,
          size: e.size,
          createdAt: parsed.ts || e.mtime || nowMs(),
          origin: 'save',
          storageKey: e.path,
          synced: false,
          label: parsed.label,
        });
      }
    } catch {
      /* 目录不可用（适配器不支持）时只靠索引 */
    }

    return sortAndDedupeVersions([...byKey.values()]);
  }

  async readVersion(storageKey: string): Promise<string> {
    return this.adapter.readText(storageKey);
  }

  /**
   * 从本地历史版本恢复。
   *
   * `save(..., 'restore')` 内部会先归档**当前内容**（recordVersion 默认 true），
   * 因此「恢复」本身也是一次可回溯的版本 —— 用户误点恢复后还能再恢复回来。
   */
  async restoreVersion(docId: string, storageKey: string): Promise<DocMeta> {
    const content = await this.adapter.readText(storageKey);
    return this.save(docId, content, 'restore');
  }

  /**
   * 清理本地超期或超出数量上限的历史版本（1.1.9，1.2.1 语义修正）。
   *
   * ## 1.2.1 关键修正：清理必须同时删索引条目
   *
   * 旧实现只 `adapter.remove(storageKey)`，但 1.2.1 起列表来自「索引 ∪ 目录」，
   * 若不同步删索引，被清理的版本会**永远**留在面板里（点开报「文件不存在」）。
   *
   * 另外把默认值从 `maxDays=30 / maxCount=50` 调整为
   * `maxDays=180 / maxCount=200`：30 天 / 50 版对「历史版本」这个功能太激进，
   * 用户抱怨「改了很多次只剩一版」时，一部分旧版本其实是被这里删掉的。
   *
   * @param maxDays 保留天数（<=0 表示不按天数限制）
   * @param maxCount 每篇最多保留版本数（<=0 表示不按数量限制）
   * @returns 实际删除的版本文件数
   */
  async pruneVersions(maxDays = 180, maxCount = 200): Promise<number> {
    let removed = 0;
    const cutoff = maxDays > 0 ? nowMs() - maxDays * 86_400_000 : 0;
    const indexEntries = await this.readVersionIndex();
    const removedKeys = new Set<string>();
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
            removedKeys.add(v.storageKey);
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (removedKeys.size) {
      await this.writeVersionIndex(indexEntries.filter((e) => !removedKeys.has(e.storageKey)));
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

/* ------------------------------------------------------------------ */
/* 历史版本合并（1.2.1 缺陷5 修复）                                     */
/* ------------------------------------------------------------------ */

/**
 * 云端历史版本的最小形态（`SyncEngine.listRemoteVersions()` 的返回项）。
 *
 * 单独定义而不是直接复用 `VersionRecord`：`@neomd/core` 不依赖 App 层，
 * 云端列举结果天然缺少 `docId`/`label`/`synced`，让调用方补齐更清晰。
 */
export interface RemoteVersionLike {
  storageKey: string;
  rev: number;
  hash: string;
  size: number;
  createdAt: number;
}

/** 从 `versions/<docId>/<file>` 形式的对象键里取出 docId */
function docIdFromVersionKey(storageKey: string): string {
  const m = /(?:^|\/)versions\/([^/]+)\//.exec(storageKey);
  return m ? m[1]! : '';
}

/** 把云端列举结果补成 `VersionRecord`（面板与合并逻辑都用这一种形态） */
export function remoteVersionsToRecords(docId: string, remote: RemoteVersionLike[]): VersionRecord[] {
  return remote.map((r) => ({
    id: `${docId}-${r.rev}-${r.hash}-${r.createdAt}`,
    docId: docId || docIdFromVersionKey(r.storageKey),
    rev: r.rev,
    hash: r.hash,
    size: r.size,
    createdAt: r.createdAt,
    origin: 'save',
    storageKey: r.storageKey,
    synced: true,
    label: '云端',
  }));
}

/** 判断一条版本记录是否来自本地留痕（`Vault.listVersions()` 的 key 一律在 `.neomd/` 下） */
function isLocalVersionRecord(v: VersionRecord): boolean {
  return v.storageKey.startsWith(`${META_DIR}/`);
}

/**
 * 版本列表去重 + 按时间倒序。
 *
 * 去重键是 **`rev` + `hash`**（内容身份），而不是 storageKey：
 *  - 同一份内容可能在本地留痕与云端各存一份（同一 rev+hash，两个 key）→ 合并成一条；
 *  - 云端还可能因为「同一版被多次归档」产生多个 ts 不同的对象（实测见 1.2.1 取证：
 *    `1793351126125-2-99a85...` 与 `1793351129242-2-99a85...` 内容完全相同）→ 也只留一条；
 *  - 但「A → B → A」这种**回滚**场景里两次 A 的 rev 不同，rev+hash 不同 → 两条都保留，
 *    这才是用户想看的时间线。
 *
 * 合并时优先保留**本地**那份（离线也能读），时间取两者中较早的一个
 * （内容首次出现的时刻更符合「这一版是什么时候产生的」）。
 */
export function sortAndDedupeVersions(list: VersionRecord[]): VersionRecord[] {
  const byIdentity = new Map<string, VersionRecord>();
  for (const v of list) {
    const identity = `${v.rev}|${v.hash}`;
    const prev = byIdentity.get(identity);
    if (!prev) {
      byIdentity.set(identity, v);
      continue;
    }
    const vIsLocal = isLocalVersionRecord(v);
    const prevIsLocal = isLocalVersionRecord(prev);
    const earliest = Math.min(prev.createdAt || 0, v.createdAt || 0) || prev.createdAt || v.createdAt;
    if (vIsLocal && !prevIsLocal) {
      // 本地优先：换成 v 的 key（离线可读），但保留较早时间与「云端也有」的事实
      byIdentity.set(identity, { ...v, createdAt: earliest, synced: true });
    } else {
      byIdentity.set(identity, { ...prev, createdAt: earliest, synced: prev.synced || v.synced });
    }
  }
  return [...byIdentity.values()].sort((a, b) => b.createdAt - a.createdAt || b.rev - a.rev);
}

/**
 * 合并「本地历史」与「云端历史」，返回统一的时间线。
 *
 * ## 为什么需要这个纯函数
 *
 * 1.2.1 之前 `HistoryModal.load()` 是**二选一**：
 * ```ts
 * const local = await app.vault.listVersions(docId);
 * if (local.length) { versions.value = local }      // 本地有 1 条就完全不查云端
 * else { versions.value = await app.listCloudVersions(docId) }
 * ```
 * 只要本地残留任意一条旧快照（例如用户曾开启过「本地留痕」、或桌面端老版本留下的
 * `.neomd/versions/`），云端真实存在的 N 条历史就会被**整体忽略**，
 * 面板里只剩那 1 条 —— 这是「只能看到最近一版」最直接的一处成因。
 *
 * 现在改为取并集：本地 ∪ 云端 → 按内容身份去重 → 按时间倒序。
 *
 * @param local 本地留痕（`Vault.listVersions()`）
 * @param remote 云端版本（`SyncEngine.listRemoteVersions()` 或已转好的 `VersionRecord[]`）
 * @param options.limit 最多返回条数（面板展示上限，默认 200）
 * @param options.docId 云端项缺少 docId 时用它补齐
 */
export function mergeVersionRecords(
  local: VersionRecord[],
  remote: Array<VersionRecord | RemoteVersionLike>,
  options: { limit?: number; docId?: string } = {},
): VersionRecord[] {
  const limit = options.limit && options.limit > 0 ? options.limit : 200;
  const remoteRecords: VersionRecord[] = remote.map((r) => {
    if ('docId' in r && 'id' in r) return r as VersionRecord;
    const like = r as RemoteVersionLike;
    return {
      id: `${options.docId ?? ''}-${like.rev}-${like.hash}-${like.createdAt}`,
      docId: options.docId || docIdFromVersionKey(like.storageKey),
      rev: like.rev,
      hash: like.hash,
      size: like.size,
      createdAt: like.createdAt,
      origin: 'save',
      storageKey: like.storageKey,
      synced: true,
      label: '云端',
    };
  });
  return sortAndDedupeVersions([...local, ...remoteRecords]).slice(0, limit);
}
