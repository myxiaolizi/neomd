import { useMemo, useState } from 'react';
import type { AppStore } from '../state';
import type { DocMeta } from '../core/types';
import { fmtShortDate, fmtCount } from '../lib/util';
import { Icon } from './icons';

interface Props {
  store: AppStore;
  onNewDoc: () => void;
  onOpenSettings: () => void;
  onClose?: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  doc?: DocMeta;
}

export function Sidebar({ store, onNewDoc, onOpenSettings, onClose }: Props) {
  const { docs, currentPath, openDoc, settings, setSettings, syncState, syncNow, pickVault, adapter, deleteDoc, toast } = store;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.path.toLowerCase().includes(q) ||
        (d.excerpt ?? '').toLowerCase().includes(q),
    );
  }, [docs, query]);

  /** 构建目录树 */
  const tree = useMemo(() => {
    const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
    const dirMap = new Map<string, TreeNode>([['', root]]);

    for (const doc of filtered) {
      const parts = doc.path.split('/');
      let curPath = '';
      let parent = root;
      for (let i = 0; i < parts.length - 1; i++) {
        curPath = curPath ? `${curPath}/${parts[i]}` : parts[i];
        let node = dirMap.get(curPath);
        if (!node) {
          node = { name: parts[i], path: curPath, isDir: true, children: [] };
          dirMap.set(curPath, node);
          parent.children.push(node);
        }
        parent = node;
      }
      parent.children.push({
        name: doc.title,
        path: doc.path,
        isDir: false,
        children: [],
        doc,
      });
    }

    const sortNode = (n: TreeNode) => {
      n.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
      n.children.forEach((c) => c.isDir && sortNode(c));
    };
    sortNode(root);
    return root;
  }, [filtered]);

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.isDir) {
      if (!node.name) {
        return node.children.map((c) => renderNode(c, depth));
      }
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={node.path} className={`tree-folder ${isCollapsed ? '' : 'open'}`}>
          <div
            className="tree-item"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggleDir(node.path)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && toggleDir(node.path)}
          >
            <span className="caret"><Icon name="chevron" size={13} /></span>
            <Icon name="folder" size={14} />
            <span className="label">{node.name}</span>
            <span className="meta">{node.children.length}</span>
          </div>
          {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }

    const doc = node.doc!;
    const active = doc.path === currentPath;
    return (
      <div
        key={doc.path}
        className={`tree-item ${active ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => void openDoc(doc.path)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && void openDoc(doc.path)}
        title={doc.path}
      >
        <Icon name="file" size={14} />
        <span className="label">{doc.title}</span>
        <span className="meta">{fmtShortDate(doc.modified)}</span>
        <button
          className="icon-btn row-act"
          style={{ width: 22, height: 22 }}
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`删除「${doc.title}」？`)) void deleteDoc(doc.path);
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    );
  };

  const totalChars = useMemo(() => docs.reduce((n, d) => n + d.chars, 0), [docs]);

  return (
    <>
      <div className="sidebar-head">
        <button className="vault-btn" onClick={() => void pickVault()} title="点击切换仓库文件夹">
          <Icon name="folder" size={16} />
          <div style={{ minWidth: 0, textAlign: 'left' }}>
            <div className="name">{adapter?.name ?? '未选择仓库'}</div>
            <div className="sub">{fmtCount(docs.length)} 篇 · {fmtCount(totalChars)} 字符</div>
          </div>
        </button>
        <button className="icon-btn mobile-only" onClick={onClose} title="关闭">
          <Icon name="close" />
        </button>
      </div>

      <div className="sidebar-actions">
        <div className="search-box">
          <span className="icon"><Icon name="search" size={14} /></span>
          <input
            placeholder="搜索笔记"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="icon-btn" onClick={onNewDoc} title="新建笔记">
          <Icon name="plus" />
        </button>
      </div>

      <div className="tree">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="glyph"><Icon name="file" size={26} /></div>
            <div>{query ? '没有匹配的笔记' : '还没有笔记'}</div>
            {!query && (
              <button className="btn sm primary" onClick={onNewDoc} style={{ marginTop: 4 }}>
                新建第一篇
              </button>
            )}
          </div>
        ) : (
          renderNode(tree, 0)
        )}
      </div>

      <div className="sidebar-foot">
        <button
          className="sync-pill"
          onClick={() => void syncNow()}
          title={syncState.message}
          style={{ flex: 1 }}
        >
          <span
            className={`dot ${
              syncState.status === 'ok' ? 'ok'
                : syncState.status === 'syncing' ? 'busy'
                : syncState.status === 'error' ? 'err' : ''
            }`}
          />
          <span className="txt">{syncState.message}</span>
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            const next = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'auto' : 'dark';
            setSettings({ theme: next });
            toast(next === 'dark' ? '深色模式' : next === 'light' ? '浅色模式' : '跟随系统');
          }}
          title="切换主题"
        >
          <Icon name={settings.theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="设置">
          <Icon name="settings" />
        </button>
      </div>
    </>
  );
}
