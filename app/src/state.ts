import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, DocMeta, SyncState, ToastMsg, VersionEntry } from './core/types';
import { loadSettingsSync, saveSettings } from './core/settings';
import { docStore, versionStore } from './core/db';
import type { VaultAdapter } from './core/adapters/types';
import { titleOf } from './core/adapters/types';
import { openVault } from './core/adapters';
import { SyncEngine } from './core/sync';
import {
  countChars, extractExcerpt, fmtKey, sha1, uid, utf8ToBytes,
} from './lib/util';

export interface AppStore {
  ready: boolean;
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
  replaceSettings: (s: AppSettings) => void;

  adapter: VaultAdapter | null;
  docs: DocMeta[];
  refreshDocs: () => Promise<void>;

  currentPath: string | null;
  currentContent: string;
  dirty: boolean;
  /** 当前打开的是否为未入库的临时文档 */
  scratch: boolean;
  openDoc: (path: string) => Promise<void>;
  /** 以临时文档形式打开内容（不写入仓库、不进索引） */
  openScratch: (name: string, content: string) => void;
  /** 把当前临时文档保存进仓库 */
  commitScratch: (name?: string) => Promise<string | null>;
  setContent: (text: string) => void;
  saveDoc: () => Promise<void>;
  createDoc: (name: string, content?: string, dir?: string) => Promise<string | null>;
  deleteDoc: (path: string) => Promise<void>;
  renameDoc: (oldPath: string, newName: string) => Promise<void>;

  versions: VersionEntry[];
  loadVersions: (path: string) => Promise<void>;
  restoreVersion: (v: VersionEntry) => Promise<void>;
  snapshot: (reason?: VersionEntry['reason']) => Promise<void>;

  syncState: SyncState;
  syncNow: () => Promise<void>;
  engine: SyncEngine | null;

  toasts: ToastMsg[];
  toast: (text: string, kind?: ToastMsg['kind']) => void;

  pickVault: () => Promise<void>;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean | ((p: boolean) => boolean)) => void;
}

export function useAppStore(): AppStore {
  const [ready, setReady] = useState(false);
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSettingsSync());
  const [adapter, setAdapter] = useState<VaultAdapter | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [scratch, setScratch] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'off', message: '同步未启用' });
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  const dirtyRef = useRef(false);
  const pathRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const adapterRef = useRef<VaultAdapter | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  const lastVersionAt = useRef<Record<string, number>>({});
  /** 当前是否为未入库的临时文档 */
  const scratchRef = useRef(false);
  /** 供 commitScratch 延迟引用 createDoc */
  const createDocRef = useRef<((name: string, content?: string, dir?: string) => Promise<string | null>) | null>(null);

  dirtyRef.current = dirty;
  pathRef.current = currentPath;
  contentRef.current = currentContent;
  adapterRef.current = adapter;
  settingsRef.current = settings;
  scratchRef.current = scratch;

  /* ------------------------- 提示 ------------------------- */

  const toast = useCallback((text: string, kind: ToastMsg['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'err' ? 5200 : 2600);
  }, []);

  /* ------------------------- 设置 ------------------------- */

  const setSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  const replaceSettings = useCallback((s: AppSettings) => {
    setSettingsState(s);
    void saveSettings(s);
  }, []);

  /* ------------------------- 文档列表 ------------------------- */

  const refreshDocs = useCallback(async () => {
    const list = await docStore.all();
    list.sort((a, b) => b.modified - a.modified);
    setDocs(list);
  }, []);

  /* ------------------------- 历史版本 ------------------------- */

  const loadVersionsFor = useCallback(async (path: string) => {
    setVersions(await versionStore.byPath(path));
  }, []);

  const loadVersions = useCallback(async (path: string) => loadVersionsFor(path), [loadVersionsFor]);

  /** 写入一个历史版本 */
  const pushVersion = useCallback(
    async (path: string, content: string, hash: string, reason: VersionEntry['reason']) => {
      const bytes = utf8ToBytes(content);
      await versionStore.put({
        id: uid(16),
        path,
        ts: Date.now(),
        hash,
        size: bytes.length,
        reason,
        content,
        synced: false,
        syncedFlag: 0,
      });
      await versionStore.prune(path, settingsRef.current.versionLimit);
      lastVersionAt.current[path] = Date.now();
      if (pathRef.current === path) await loadVersionsFor(path);
    },
    [loadVersionsFor],
  );

  const snapshot = useCallback(
    async (reason: VersionEntry['reason'] = 'manual') => {
      const path = pathRef.current;
      if (!path) return;
      const content = contentRef.current;
      const hash = await sha1(content);
      await pushVersion(path, content, hash, reason);
      toast('已创建版本快照', 'ok');
    },
    [pushVersion, toast],
  );

  const restoreVersion = useCallback(
    async (v: VersionEntry) => {
      const path = pathRef.current;
      const a = adapterRef.current;
      if (!path || !a) return;
      // 恢复前先留存当前内容
      await pushVersion(path, contentRef.current, await sha1(contentRef.current), 'pre-restore');
      await a.write(path, v.content);
      setCurrentContent(v.content);
      contentRef.current = v.content;
      setDirty(false);
      dirtyRef.current = false;
      const bytes = utf8ToBytes(v.content);
      const meta: DocMeta = {
        path,
        title: titleOf(path),
        hash: v.hash,
        size: bytes.length,
        chars: countChars(v.content),
        created: (await docStore.get(path))?.created ?? Date.now(),
        modified: Date.now(),
        excerpt: extractExcerpt(v.content, 90),
      };
      await docStore.put(meta);
      await refreshDocs();
      await loadVersionsFor(path);
      toast('已恢复到所选版本', 'ok');
    },
    [pushVersion, refreshDocs, loadVersionsFor, toast],
  );

  /* ------------------------- 保存 ------------------------- */

  /** 落盘并更新索引；changed=true 时按间隔留存版本 */
  const persist = useCallback(
    async (path: string, content: string, opts: { version?: VersionEntry['reason'] } = {}) => {
      const a = adapterRef.current;
      if (!a) return;
      const prev = await docStore.get(path);
      const hash = await sha1(content);
      const bytes = utf8ToBytes(content);

      // 内容确实变化才留存旧版本
      if (prev && prev.hash !== hash) {
        const gap = Date.now() - (lastVersionAt.current[path] ?? 0);
        const minGap = settingsRef.current.versionIntervalSec * 1000;
        if (opts.version === 'manual' || gap >= minGap) {
          const oldText = await a.read(path).catch(() => null);
          if (oldText !== null && oldText !== content) {
            await pushVersion(path, oldText, prev.hash, opts.version ?? 'auto');
          }
        }
      }

      await a.write(path, content);

      const meta: DocMeta = {
        path,
        title: titleOf(path),
        hash,
        syncedHash: prev?.syncedHash,
        etag: prev?.etag,
        syncedAt: prev?.syncedAt,
        size: bytes.length,
        chars: countChars(content),
        created: prev?.created ?? Date.now(),
        modified: Date.now(),
        excerpt: extractExcerpt(content, 90),
      };
      await docStore.put(meta);
      await refreshDocs();
    },
    [pushVersion, refreshDocs],
  );

  const saveDoc = useCallback(async () => {
    const path = pathRef.current;
    if (!path) return;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    await persist(path, contentRef.current, { version: 'manual' });
    setDirty(false);
    dirtyRef.current = false;
  }, [persist]);

  /* ------------------------- 临时文档 ------------------------- */

  /**
   * 打开一个未入库的临时文档。
   * 内容只存在于内存，不写仓库、不进索引、不参与同步与版本管理。
   */
  const openScratch = useCallback((name: string, content: string) => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    const clean = name.replace(/\.(md|markdown)$/i, '').trim() || '临时文档';
    setCurrentPath(clean);
    pathRef.current = clean;
    setCurrentContent(content);
    contentRef.current = content;
    setScratch(true);
    setDirty(true);
    dirtyRef.current = true;
    setVersions([]);
  }, []);

  /** 把当前临时文档写入仓库 */
  const commitScratch = useCallback(
    async (name?: string) => {
      const target = (name ?? pathRef.current ?? '未命名').replace(/\.(md|markdown)$/i, '');
      const content = contentRef.current;
      const create = createDocRef.current;
      if (!create) return null;
      const path = await create(target, content);
      if (path) {
        setScratch(false);
        scratchRef.current = false;
        setDirty(false);
        dirtyRef.current = false;
        toast('已加入仓库', 'ok');
      }
      return path;
    },
    [toast],
  );

  /* ------------------------- 编辑 ------------------------- */

  const setContent = useCallback(
    (text: string) => {
      setCurrentContent(text);
      contentRef.current = text;
      setDirty(true);
      dirtyRef.current = true;

      // 临时文档不落盘，仅保留在内存
      if (scratchRef.current) return;

      // 防抖自动保存
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        const p = pathRef.current;
        if (!p || !dirtyRef.current) return;
        void persist(p, contentRef.current).then(() => {
          setDirty(false);
          dirtyRef.current = false;
        });
      }, 800);
    },
    [persist],
  );

  /* ------------------------- 打开 / 新建 / 删除 ------------------------- */

  const openDoc = useCallback(
    async (path: string) => {
      const a = adapterRef.current;
      if (!a) return;
      // 切换前保存当前文档（临时文档不落盘，直接丢弃）
      if (dirtyRef.current && pathRef.current && pathRef.current !== path && !scratchRef.current) {
        await persist(pathRef.current, contentRef.current).catch(() => undefined);
      }
      try {
        const content = await a.read(path);
        setCurrentPath(path);
        pathRef.current = path;
        setCurrentContent(content);
        contentRef.current = content;
        setDirty(false);
        dirtyRef.current = false;
        setScratch(false);
        scratchRef.current = false;
        await loadVersionsFor(path);
        setSettings({ lastDocPath: path });
      } catch (e) {
        toast(`打开失败：${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    },
    [persist, loadVersionsFor, setSettings, toast],
  );

  const createDoc = useCallback(
    async (name: string, content = '', dir = ''): Promise<string | null> => {
      const a = adapterRef.current;
      if (!a) return null;
      const clean = name.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
      const path = dir ? `${dir.replace(/\/+$/, '')}/${clean}.md` : `${clean}.md`;

      try {
        let finalPath = path;
        let n = 2;
        while (await a.exists(finalPath)) {
          finalPath = dir ? `${dir.replace(/\/+$/, '')}/${clean} ${n}.md` : `${clean} ${n}.md`;
          n++;
          if (n > 999) break;
        }
        if (dir) await a.ensureDir(dir);
        await a.write(finalPath, content);

        const bytes = utf8ToBytes(content);
        await docStore.put({
          path: finalPath,
          title: titleOf(finalPath),
          hash: await sha1(content),
          size: bytes.length,
          chars: countChars(content),
          created: Date.now(),
          modified: Date.now(),
          excerpt: extractExcerpt(content, 90),
        });
        await refreshDocs();
        await openDoc(finalPath);
        return finalPath;
      } catch (e) {
        toast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'err');
        return null;
      }
    },
    [openDoc, refreshDocs, toast],
  );

  // 供 commitScratch 延迟调用
  createDocRef.current = createDoc;

  const deleteDoc = useCallback(
    async (path: string) => {
      const a = adapterRef.current;
      if (!a) return;
      try {
        await a.remove(path);
        const meta = await docStore.get(path);
        if (meta) await docStore.put({ ...meta, deleted: true });
        await versionStore.removeByPath(path);
        if (pathRef.current === path) {
          setCurrentPath(null);
          pathRef.current = null;
          setCurrentContent('');
          contentRef.current = '';
          setVersions([]);
        }
        await refreshDocs();
        toast('已删除', 'ok');
      } catch (e) {
        toast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    },
    [refreshDocs, toast],
  );

  const renameDoc = useCallback(
    async (oldPath: string, newName: string) => {
      const a = adapterRef.current;
      if (!a) return;
      const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
      const clean = newName.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!clean) return;
      const newPath = dir ? `${dir}/${clean}.md` : `${clean}.md`;
      if (newPath === oldPath) return;

      try {
        if (await a.exists(newPath)) {
          toast('目标名称已存在', 'err');
          return;
        }
        await a.move(oldPath, newPath);
        const meta = await docStore.get(oldPath);
        if (meta) {
          await docStore.remove(oldPath);
          await docStore.put({ ...meta, path: newPath, title: clean, modified: Date.now() });
        }
        const vs = await versionStore.byPath(oldPath);
        for (const v of vs) {
          await versionStore.put({ ...v, path: newPath, synced: false, syncedFlag: 0 });
        }
        if (pathRef.current === oldPath) {
          setCurrentPath(newPath);
          pathRef.current = newPath;
          await loadVersionsFor(newPath);
        }
        await refreshDocs();
        toast('已重命名', 'ok');
      } catch (e) {
        toast(`重命名失败：${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    },
    [refreshDocs, loadVersionsFor, toast],
  );

  /* ------------------------- 同步 ------------------------- */

  const syncNow = useCallback(async () => {
    const e = engine;
    const a = adapterRef.current;
    if (!e) {
      toast('同步引擎尚未就绪', 'err');
      return;
    }
    if (!e.isConfigured()) {
      toast('请先在设置中填写 S3 连接信息', 'err');
      return;
    }
    // 同步前先落盘
    if (dirtyRef.current && pathRef.current) {
      await persist(pathRef.current, contentRef.current).catch(() => undefined);
      setDirty(false);
      dirtyRef.current = false;
    }

    const r = await e.sync(a!, { force: true });
    await refreshDocs();

    // 当前文档若被远端更新，重新载入
    const cur = pathRef.current;
    if (cur && !dirtyRef.current) {
      const fresh = await adapterRef.current?.read(cur).catch(() => null);
      if (fresh !== null && fresh !== undefined && fresh !== contentRef.current) {
        setCurrentContent(fresh);
        contentRef.current = fresh;
      }
      await loadVersionsFor(cur);
    }

    if (r.errors.length) {
      toast(`同步完成，${r.errors.length} 个错误：${r.errors[0]}`, 'err');
    } else {
      toast(
        `同步完成 · 上传 ${r.uploaded} · 下载 ${r.downloaded}${r.conflicts ? ` · 冲突 ${r.conflicts}` : ''}`,
        'ok',
      );
    }
  }, [engine, persist, refreshDocs, loadVersionsFor, toast]);

  /* ------------------------- 切换仓库 ------------------------- */

  const pickVault = useCallback(async () => {
    const opened = await openVault(true);
    if (!opened) return;
    // 保存当前
    if (dirtyRef.current && pathRef.current) {
      await persist(pathRef.current, contentRef.current).catch(() => undefined);
    }
    setAdapter(opened.adapter);
    adapterRef.current = opened.adapter;
    await docStore.clear();
    await refreshDocs();
    setCurrentPath(null);
    pathRef.current = null;
    setCurrentContent('');
    contentRef.current = '';
    setVersions([]);
    toast(`已切换到：${opened.adapter.location}`, 'ok');
  }, [persist, refreshDocs, toast]);

  /* ------------------------- 初始化 ------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opened = await openVault();
        if (cancelled) return;
        if (!opened) {
          setReady(true);
          return;
        }
        setAdapter(opened.adapter);
        adapterRef.current = opened.adapter;

        // 索引仓库中已有的 .md 文件
        const files = await opened.adapter.list();
        const indexed = new Map((await docStore.allWithDeleted()).map((d) => [d.path, d]));
        const fresh: DocMeta[] = [];

        for (const f of files) {
          const known = indexed.get(f.path);
          if (known && !known.deleted && known.modified >= f.mtime) continue;
          try {
            const text = await opened.adapter.read(f.path);
            const bytes = utf8ToBytes(text);
            fresh.push({
              path: f.path,
              title: titleOf(f.path),
              hash: await sha1(text),
              size: bytes.length,
              chars: countChars(text),
              created: known?.created ?? f.mtime,
              modified: f.mtime,
              excerpt: extractExcerpt(text, 90),
            });
          } catch {
            /* 跳过不可读文件 */
          }
        }
        if (fresh.length) await docStore.putMany(fresh);
        await refreshDocs();

        // 恢复上次文档
        const s = settingsRef.current;
        if (s.restoreLast && s.lastDocPath) {
          const exists = await opened.adapter.exists(s.lastDocPath).catch(() => false);
          if (exists) {
            const text = await opened.adapter.read(s.lastDocPath);
            setCurrentPath(s.lastDocPath);
            pathRef.current = s.lastDocPath;
            setCurrentContent(text);
            contentRef.current = text;
            await loadVersionsFor(s.lastDocPath);
          }
        }
      } catch (e) {
        toast(`初始化失败：${e instanceof Error ? e.message : String(e)}`, 'err');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- 同步引擎生命周期 ------------------------- */

  useEffect(() => {
    const e = new SyncEngine(settings.sync, {
      onState: (s) => setSyncState(s),
      onDocChanged: () => {
        void refreshDocs();
      },
    });
    setEngine(e);
    setSyncState(
      settings.sync.enabled && e.isConfigured()
        ? { status: 'idle', message: '待同步' }
        : { status: 'off', message: '同步未启用' },
    );
  }, [settings.sync, refreshDocs]);

  /* 自动同步 */
  useEffect(() => {
    if (!settings.sync.enabled || !settings.sync.autoInterval) return;
    const interval = Math.max(60, settings.sync.autoInterval) * 1000;
    const id = setInterval(() => {
      if (engine && adapterRef.current && !engine.isRunning) {
        void engine.sync(adapterRef.current);
      }
    }, interval);
    return () => clearInterval(id);
  }, [settings.sync.enabled, settings.sync.autoInterval, engine]);

  /* ------------------------- 主题 ------------------------- */

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = dark ? 'dark' : 'light';
      root.style.setProperty('--c-primary', settings.accent);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#10141c' : '#f3f6fb');
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme, settings.accent]);

  /* 关闭前提醒 */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  /* 刷新快捷键提示用 */
  const keymapHint = useMemo(() => fmtKey(settings.keymap['edit.save'] ?? 'Mod+S'), [settings.keymap]);

  return useMemo(
    () => ({
      ready,
      settings,
      setSettings,
      replaceSettings,
      adapter,
      docs,
      refreshDocs,
      currentPath,
      currentContent,
      dirty,
      scratch,
      openDoc,
      openScratch,
      commitScratch,
      setContent,
      saveDoc,
      createDoc,
      deleteDoc,
      renameDoc,
      versions,
      loadVersions,
      restoreVersion,
      snapshot,
      syncState,
      syncNow,
      engine,
      toasts,
      toast,
      pickVault,
      sidebarOpen,
      setSidebarOpen,
    }),
    [
      ready, settings, setSettings, replaceSettings, adapter, docs, refreshDocs,
      currentPath, currentContent, dirty, scratch, openDoc, openScratch, commitScratch,
      setContent, saveDoc, createDoc,
      deleteDoc, renameDoc, versions, loadVersions, restoreVersion, snapshot,
      syncState, syncNow, engine, toasts, toast, pickVault, sidebarOpen, keymapHint,
    ],
  );
}
