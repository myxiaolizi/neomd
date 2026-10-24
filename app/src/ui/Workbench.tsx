import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { MarkdownEditor, type EditorHandle } from '../editor/MarkdownEditor';
import {
  setHeading, toggleBold, toggleItalic, toggleStrike, toggleCode, toggleQuote,
  toggleBulletList, toggleOrderedList, toggleTaskList, insertCodeBlock,
  insertLink, insertHr, insertTable, insertHighlight, insertImage,
} from '../editor/commands';
import type { AppStore } from '../state';
import { fmtKey, fmtCount, fmtShortDate, fmtRelative, fmtBytes } from '../lib/util';
import { Icon } from './icons';

type Panel = 'history' | 'info' | null;

interface Props {
  store: AppStore;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  onNewDoc: () => void;
  onToggleSidebar: () => void;
  onSave: () => void;
}

export function Workbench({
  store, onOpenSettings, onOpenPalette, onNewDoc, onToggleSidebar, onSave,
}: Props) {
  const {
    settings, currentPath, currentContent, dirty, docs, versions, scratch,
    setContent, saveDoc, snapshot, restoreVersion, syncNow, syncState, toast,
    commitScratch,
  } = store;

  const editorRef = useRef<EditorHandle | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selLen: 0, chars: 0 });
  const [titleDraft, setTitleDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const title = currentPath ? (currentPath.split('/').pop() ?? '').replace(/\.md$/i, '') : '';
  const docMeta = useMemo(() => docs.find((d) => d.path === currentPath), [docs, currentPath]);

  useEffect(() => {
    setTitleDraft(title);
    setRenaming(false);
  }, [title, currentPath]);

  const runFormat = useCallback((fn: (v: EditorView) => boolean) => {
    editorRef.current?.run(fn);
  }, []);

  // 供快捷键闭包读取最新值
  const scratchRef = useRef(scratch);
  scratchRef.current = scratch;
  const pathRef = useRef<string | null>(currentPath);
  pathRef.current = currentPath;

  /* ---------------- 全局快捷键 ---------------- */
  const actions = useMemo<Record<string, () => void>>(
    () => ({
      'format.h1': () => runFormat((v) => setHeading(v, 1)),
      'format.h2': () => runFormat((v) => setHeading(v, 2)),
      'format.h3': () => runFormat((v) => setHeading(v, 3)),
      'format.h4': () => runFormat((v) => setHeading(v, 4)),
      'format.h5': () => runFormat((v) => setHeading(v, 5)),
      'format.h6': () => runFormat((v) => setHeading(v, 6)),
      'format.paragraph': () => runFormat((v) => setHeading(v, 0)),
      'format.bold': () => runFormat(toggleBold),
      'format.italic': () => runFormat(toggleItalic),
      'format.strike': () => runFormat(toggleStrike),
      'format.code': () => runFormat(toggleCode),
      'format.codeblock': () => runFormat(insertCodeBlock),
      'format.quote': () => runFormat(toggleQuote),
      'format.ul': () => runFormat(toggleBulletList),
      'format.ol': () => runFormat(toggleOrderedList),
      'format.task': () => runFormat(toggleTaskList),
      'format.link': () => runFormat(insertLink),
      'format.hr': () => runFormat(insertHr),
      'format.table': () => runFormat(insertTable),
      'edit.save': () => {
        // 临时文档的「保存」等于加入仓库
        if (scratchRef.current) void commitScratch(pathRef.current ?? undefined);
        else onSave();
      },
      'edit.sync': () => void syncNow(),
      'edit.new': onNewDoc,
      'edit.rename': () => setRenaming(true),
      'edit.palette': onOpenPalette,
      'edit.toggleSidebar': onToggleSidebar,
      'edit.toggleHistory': () => setPanel((p) => (p === 'history' ? null : 'history')),
      'edit.settings': onOpenSettings,
    }),
    [runFormat, onSave, syncNow, onNewDoc, onOpenPalette, onToggleSidebar, onOpenSettings, commitScratch],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();

      for (const [action, spec] of Object.entries(settings.keymap)) {
        const parts = spec.split('+').map((p) => p.trim().toLowerCase());
        const needCtrl = parts.includes('mod') || parts.includes('ctrl') || parts.includes('cmd');
        const needShift = parts.includes('shift');
        const needAlt = parts.includes('alt');
        const main = parts.filter((p) => !['mod', 'ctrl', 'cmd', 'shift', 'alt', 'meta'].includes(p))[0];
        if (!main) continue;
        if (!needCtrl) continue;
        if (needShift !== e.shiftKey || needAlt !== e.altKey) continue;

        const hit =
          key === main ||
          (/^[a-z]$/.test(main) && e.code === `Key${main.toUpperCase()}`) ||
          (/^[0-9]$/.test(main) && e.code === `Digit${main}`) ||
          (main === '\\' && e.code === 'Backslash') ||
          (main === ',' && e.code === 'Comma') ||
          (main === '.' && e.code === 'Period') ||
          (main === '-' && e.code === 'Minus') ||
          (main === '8' && e.code === 'Digit8') ||
          (main === '7' && e.code === 'Digit7') ||
          (main === '9' && e.code === 'Digit9');

        if (!hit) continue;

        const fn = actions[action];
        if (fn) {
          e.preventDefault();
          e.stopPropagation();
          fn();
          return;
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [settings.keymap, actions]);

  /* ---------------- 链接 ---------------- */
  const handleOpenLink = useCallback(
    async (href: string) => {
      if (/^(https?:|mailto:|tel:)/i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const clean = href.replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase();
      const target = docs.find(
        (d) =>
          d.path.replace(/\.md$/i, '').toLowerCase() === clean ||
          d.title.toLowerCase() === clean ||
          d.path.toLowerCase().endsWith(`/${clean}.md`),
      );
      if (target) await store.openDoc(target.path);
      else toast(`未找到笔记：${clean}`, 'err');
    },
    [docs, store, toast],
  );

  /* ---------------- 拖放导入 ---------------- */
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files).filter((f) => /\.md$/i.test(f.name));
      if (!files.length) return;

      // 单文件且未开启「默认入库」时，先给用户一次选择机会
      if (files.length === 1 && !settings.autoImportExternal) {
        const text = await files[0].text();
        store.openScratch(files[0].name.replace(/\.md$/i, ''), text);
        toast('已作为临时文档打开，可点「加入仓库」保存', 'info');
        return;
      }

      for (const f of files) {
        const text = await f.text();
        await store.createDoc(f.name.replace(/\.md$/i, ''), text);
      }
      toast(`已导入 ${files.length} 个文件`, 'ok');
    },
    [store, toast, settings.autoImportExternal],
  );

  /* ---------------- 空态 ---------------- */
  if (!currentPath) {
    return (
      <div className="main">
        <div className="topbar">
          <button className="icon-btn mobile-only" onClick={onToggleSidebar} title="文档列表">
            <Icon name="menu" />
          </button>
          <div className="doc-title-input" style={{ color: 'var(--c-text-3)', fontWeight: 500 }}>
            Markdown 笔记
          </div>
          <button className="icon-btn" onClick={onOpenPalette} title="命令面板">
            <Icon name="search" />
          </button>
          <button className="icon-btn" onClick={onNewDoc} title="新建笔记">
            <Icon name="plus" />
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="设置">
            <Icon name="settings" />
          </button>
        </div>
        <WelcomeScreen store={store} onNewDoc={onNewDoc} onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  return (
    <div className="main">
      <div className="topbar">
        <button className="icon-btn mobile-only" onClick={onToggleSidebar} title="文档列表">
          <Icon name="menu" />
        </button>

        {renaming ? (
          <input
            className="doc-title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              const t = titleDraft.trim();
              if (t && t !== title) void store.renameDoc(currentPath, t);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                setTitleDraft(title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <div
            className="doc-title-input"
            role="button"
            tabIndex={0}
            title="点击重命名"
            onClick={() => setRenaming(true)}
            onKeyDown={(e) => e.key === 'Enter' && setRenaming(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'text' }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title || '未命名'}
            </span>
            {scratch && (
              <span className="chip" style={{ height: 18, fontSize: 10.5 }}>临时</span>
            )}
            {dirty && !scratch && <span className="chip orange" style={{ height: 18, fontSize: 10.5 }}>未保存</span>}
          </div>
        )}

        {scratch ? (
          <button
            className="btn sm primary"
            onClick={() => void commitScratch(title)}
            title="把这个临时文档保存到仓库，纳入同步与版本管理"
          >
            加入仓库
          </button>
        ) : (
          <button className="icon-btn" onClick={onSave} title={`保存 (${fmtKey(settings.keymap['edit.save'] ?? 'Mod+S').join('+')})`}>
            <Icon name="save" />
          </button>
        )}
        <button className="icon-btn" onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))} title="历史版本">
          <Icon name="history" />
        </button>
        <button className="icon-btn" onClick={() => setPanel((p) => (p === 'info' ? null : 'info'))} title="文件信息">
          <Icon name="info" />
        </button>
        <button
          className={`icon-btn ${syncState.status === 'syncing' ? 'on' : ''}`}
          onClick={() => void syncNow()}
          title={`同步 (${fmtKey(settings.keymap['edit.sync'] ?? 'Mod+Shift+S').join('+')})`}
        >
          <Icon name="cloud" />
        </button>
      </div>

      <div className="toolbar">
        <ToolBtn label="H1" hint="一级标题" onClick={() => runFormat((v) => setHeading(v, 1))} />
        <ToolBtn label="H2" hint="二级标题" onClick={() => runFormat((v) => setHeading(v, 2))} />
        <ToolBtn label="H3" hint="三级标题" onClick={() => runFormat((v) => setHeading(v, 3))} />
        <span className="sep" />
        <ToolBtn icon="bold" hint="加粗" onClick={() => runFormat(toggleBold)} />
        <ToolBtn icon="italic" hint="斜体" onClick={() => runFormat(toggleItalic)} />
        <ToolBtn icon="strike" hint="删除线" onClick={() => runFormat(toggleStrike)} />
        <ToolBtn icon="code" hint="行内代码" onClick={() => runFormat(toggleCode)} />
        <span className="sep" />
        <ToolBtn icon="quote" hint="引用" onClick={() => runFormat(toggleQuote)} />
        <ToolBtn icon="ul" hint="无序列表" onClick={() => runFormat(toggleBulletList)} />
        <ToolBtn icon="ol" hint="有序列表" onClick={() => runFormat(toggleOrderedList)} />
        <ToolBtn icon="task" hint="任务列表" onClick={() => runFormat(toggleTaskList)} />
        <span className="sep" />
        <ToolBtn icon="link" hint="链接" onClick={() => runFormat(insertLink)} />
        <ToolBtn
          icon="image"
          hint="图片"
          onClick={() =>
            runFormat((v) => {
              const url = window.prompt('图片地址（URL 或仓库内相对路径）');
              if (!url) return false;
              return insertImage(v, url, '');
            })
          }
        />
        <ToolBtn icon="table" hint="表格" onClick={() => runFormat(insertTable)} />
        <ToolBtn icon="hr" hint="分割线" onClick={() => runFormat(insertHr)} />
        <ToolBtn icon="codeblock" hint="代码块" onClick={() => runFormat(insertCodeBlock)} />
        <span className="sep" />
        <ToolBtn icon="highlight" hint="高亮" onClick={() => runFormat(insertHighlight)} />
        <div className="spacer" />
        <button className="icon-btn" onClick={() => setPanel((p) => (p === 'info' ? null : 'info'))} title="文档信息">
          <Icon name="more" />
        </button>
      </div>

      <div className="workbench">
        <div className="pane-main">
          <div
            className="editor-wrap"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <MarkdownEditor
              content={currentContent}
              onChange={setContent}
              onSave={onSave}
              onOpenLink={handleOpenLink}
              settings={settings.editor}
              docKey={currentPath}
              onSelectionChange={setCursor}
              handleRef={(h) => { editorRef.current = h; }}
            />
            {dragOver && <div className="drop-hint">松开以导入 Markdown 文件</div>}
          </div>

          <div className="statusbar">
            <span className="item">{fmtCount(cursor.chars)} 字符</span>
            <span className="item">行 {cursor.line}，列 {cursor.col}</span>
            {cursor.selLen > 0 && <span className="item">已选 {fmtCount(cursor.selLen)}</span>}
            <div className="spacer" />
            <span className="item">{docMeta ? fmtBytes(docMeta.size) : '—'}</span>
            <span className="item clickable" onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))}>
              {versions.length} 个版本
            </span>
            <span className="item">
              <span
                className={`dot ${
                  syncState.status === 'ok' ? 'ok'
                    : syncState.status === 'syncing' ? 'busy'
                    : syncState.status === 'error' ? 'err' : ''
                }`}
              />
              {syncState.message}
            </span>
          </div>
        </div>

        {panel === 'history' && (
          <aside className="side-panel">
            <div className="side-panel-head">
              <span className="title">历史版本</span>
              <button className="btn sm" onClick={() => void snapshot('manual')}>快照</button>
              <button className="icon-btn" onClick={() => setPanel(null)} title="关闭">
                <Icon name="close" />
              </button>
            </div>
            <div className="side-panel-body">
              {versions.length === 0 ? (
                <div className="empty-state">
                  <div className="glyph"><Icon name="history" size={30} /></div>
                  <div>还没有历史版本</div>
                  <div style={{ fontSize: 11.5 }}>保存或手动快照后会自动记录</div>
                </div>
              ) : (
                versions.map((v) => (
                  <div
                    key={v.id}
                    className="ver-item"
                    onClick={() => {
                      if (window.confirm(`恢复到 ${fmtRelative(v.ts)} 的版本？当前内容会先存为快照。`)) {
                        void restoreVersion(v);
                      }
                    }}
                  >
                    <div className="rail"><span className="node" /></div>
                    <div className="body">
                      <div className="when">
                        {fmtRelative(v.ts)}
                        <span className="chip" style={{ height: 17, fontSize: 10 }}>
                          {v.reason === 'manual' ? '手动'
                            : v.reason === 'auto' ? '自动'
                            : v.reason === 'sync' ? '同步'
                            : v.reason === 'pre-restore' ? '恢复前' : '创建'}
                        </span>
                      </div>
                      <div className="preview">{v.content.slice(0, 120) || '（空）'}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--c-text-3)', marginTop: 3 }}>
                        {fmtBytes(v.size)} · {fmtShortDate(v.ts)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        {panel === 'info' && (
          <aside className="side-panel">
            <div className="side-panel-head">
              <span className="title">文件信息</span>
              <button className="icon-btn" onClick={() => setPanel(null)} title="关闭">
                <Icon name="close" />
              </button>
            </div>
            <div className="side-panel-body">
              <dl className="info-grid">
                <dt>路径</dt>
                <dd>{currentPath}</dd>
                <dt>字数</dt>
                <dd>{fmtCount(docMeta?.chars ?? currentContent.length)}</dd>
                <dt>大小</dt>
                <dd>{fmtBytes(docMeta?.size ?? new Blob([currentContent]).size)}</dd>
                <dt>创建时间</dt>
                <dd>{docMeta ? fmtRelative(docMeta.created) : '—'}</dd>
                <dt>修改时间</dt>
                <dd>{docMeta ? fmtRelative(docMeta.modified) : '—'}</dd>
                <dt>版本数</dt>
                <dd>{versions.length}</dd>
                <dt>同步状态</dt>
                <dd>{docMeta?.syncedAt ? `已同步 · ${fmtRelative(docMeta.syncedAt)}` : '尚未同步'}</dd>
                <dt>内容哈希</dt>
                <dd style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {docMeta?.hash?.slice(0, 16) ?? '—'}
                </dd>
              </dl>
              <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button className="btn block" onClick={() => void snapshot('manual')}>创建版本快照</button>
                <button
                  className="btn block"
                  onClick={() => {
                    navigator.clipboard.writeText(currentContent).then(
                      () => toast('已复制全文', 'ok'),
                      () => toast('复制失败', 'err'),
                    );
                  }}
                >
                  复制全文
                </button>
                <button
                  className="btn block danger"
                  onClick={() => {
                    if (window.confirm(`删除「${title}」？该操作会同时移除本地文件。`)) {
                      void store.deleteDoc(currentPath);
                      setPanel(null);
                    }
                  }}
                >
                  删除此笔记
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ToolBtn({
  label, icon, hint, onClick,
}: { label?: string; icon?: string; hint: string; onClick: () => void }) {
  return (
    <button
      className="icon-btn"
      onClick={onClick}
      title={hint}
      style={label ? { width: 'auto', padding: '0 7px', fontWeight: 650, fontSize: 12 } : undefined}
    >
      {icon ? <Icon name={icon} /> : label}
    </button>
  );
}

function WelcomeScreen({
  store, onNewDoc, onOpenSettings,
}: { store: AppStore; onNewDoc: () => void; onOpenSettings: () => void }) {
  const { docs, pickVault, adapter } = store;
  return (
    <div className="welcome">
      <div className="logo"><Icon name="logo" size={40} /></div>
      <div>
        <h1>Markdown 笔记</h1>
        <p style={{ marginTop: 8 }}>
          轻量、快速、本地优先。笔记以明文 Markdown 保存在你的文件夹里，可通过 S3 在多台设备间同步。
        </p>
      </div>
      <div className="cta">
        <button className="btn primary" onClick={onNewDoc}>
          <Icon name="plus" size={15} /> 新建笔记
        </button>
        <button className="btn" onClick={() => void pickVault()}>
          <Icon name="folder" size={15} /> 选择仓库文件夹
        </button>
        <button className="btn ghost" onClick={onOpenSettings}>
          <Icon name="settings" size={15} /> 设置
        </button>
      </div>
      <div className="features">
        <div className="feature">
          <div className="t"><Icon name="file" size={14} /> 明文存储</div>
          <div className="d">{adapter ? `${docs.length} 篇笔记 · ${adapter.location}` : '笔记就是普通的 .md 文件'}</div>
        </div>
        <div className="feature">
          <div className="t"><Icon name="cloud" size={14} /> S3 同步</div>
          <div className="d">兼容 AWS S3 / MinIO / R2 / 对象存储</div>
        </div>
        <div className="feature">
          <div className="t"><Icon name="history" size={14} /> 历史版本</div>
          <div className="d">自动留存每次修改，可随时回滚</div>
        </div>
        <div className="feature">
          <div className="t"><Icon name="keyboard" size={14} /> 自定义快捷键</div>
          <div className="d">Ctrl+1 到 Ctrl+6 快速设置标题级别</div>
        </div>
      </div>
    </div>
  );
}
