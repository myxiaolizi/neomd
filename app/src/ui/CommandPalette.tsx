import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppStore } from '../state';
import { openExternal } from './ExternalFile';
import { Icon } from './icons';

interface Props {
  store: AppStore;
  onClose: () => void;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ store, onClose }: Props) {
  const { docs, openDoc, createDoc, toast, syncNow, settings } = store;
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭（捕获阶段，优先于编辑器）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'sync', label: '立即同步', hint: 'S3', run: () => void syncNow() },
      {
        id: 'new',
        label: '新建笔记',
        run: () => {
          onClose();
          window.dispatchEvent(new CustomEvent('mdnote:new'));
        },
      },
      {
        id: 'open-external',
        label: '打开外部 Markdown 文件',
        hint: '本地文件',
        run: () => {
          onClose();
          void openExternal(
            (f) => window.dispatchEvent(new CustomEvent('mdnote:external-file', { detail: f })),
            (msg) => toast(msg, 'err'),
          );
        },
      },
      {
        id: 'settings',
        label: '打开设置',
        run: () => {
          onClose();
          window.dispatchEvent(new CustomEvent('mdnote:settings'));
        },
      },
      {
        id: 'export',
        label: '导出当前笔记',
        run: () => {
          const content = store.currentContent;
          if (!store.currentPath) return;
          const name = (store.currentPath.split('/').pop() ?? 'note.md');
          const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
          onClose();
        },
      },
      {
        id: 'theme',
        label: '切换主题',
        run: () => {
          const next = settings.theme === 'dark' ? 'light' : 'dark';
          store.setSettings({ theme: next });
          onClose();
        },
      },
    ];

    // 匹配笔记
    const query = q.trim().toLowerCase();
    if (query) {
      const hits = docs
        .filter(
          (d) =>
            d.title.toLowerCase().includes(query) ||
            d.path.toLowerCase().includes(query),
        )
        .slice(0, 8)
        .map<Command>((d) => ({
          id: `doc:${d.path}`,
          label: d.title,
          hint: d.path.includes('/') ? d.path.split('/').slice(0, -1).join('/') : '笔记',
          run: () => {
            void openDoc(d.path);
            onClose();
          },
        }));

      if (hits.length === 0) {
        hits.push({
          id: 'create',
          label: `新建「${q.trim()}」`,
          hint: '创建',
          run: async () => {
            await createDoc(q.trim());
            onClose();
          },
        });
      }
      return [...hits, ...cmds.filter((c) => c.label.toLowerCase().includes(query))];
    }
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, docs, settings.theme]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const runAt = (i: number) => {
    const c = commands[i];
    if (!c) return;
    c.run();
  };

  return (
    <div className="overlay palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="搜索笔记或执行命令…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, commands.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runAt(idx);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {commands.length === 0 && (
            <div className="empty-state" style={{ padding: 24 }}>没有结果</div>
          )}
          {commands.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => runAt(i)}
            >
              <Icon name={c.id.startsWith('doc:') ? 'file' : 'chevron'} size={14} />
              <span>{c.label}</span>
              {c.hint && <span className="sub">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
