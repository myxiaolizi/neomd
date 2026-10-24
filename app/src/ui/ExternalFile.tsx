import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../state';
import {
  onExternalFile, pickExternalFile, registerFileHandlers, takeStartupFile,
  type ExternalFile,
} from '../core/external';
import { Icon } from './icons';

interface Props {
  store: AppStore;
  file: ExternalFile;
  onClose: () => void;
}

/**
 * 外部 Markdown 文件导入确认。
 * 用户可决定是否将其加入当前仓库。
 */
export function ExternalImportDialog({ store, file, onClose }: Props) {
  const { settings, createDoc, toast, openScratch } = store;
  const [name, setName] = useState(file.name.replace(/\.(md|markdown)$/i, ''));
  const [addToVault, setAddToVault] = useState(settings.autoImportExternal);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      if (!addToVault) {
        // 不入库：直接把内容作为「未保存的临时文档」在编辑器中打开。
        // 不写入仓库目录，也不进索引，关闭后不留痕。
        openScratch(name, file.content);
        toast('已作为临时文档打开（未加入仓库）', 'ok');
        onClose();
        return;
      }
      const path = await createDoc(name, file.content);
      if (path) {
        toast(`已加入仓库：${name}`, 'ok');
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>打开外部文件</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section" style={{ paddingTop: 4 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 'var(--r-md)',
                background: 'var(--c-surface-2)',
                border: '1px solid var(--c-line)',
              }}
            >
              <Icon name="file" size={18} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.name}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--c-text-3)' }}>
                  {file.content.length} 字符
                  {file.path ? ` · ${file.path}` : ''}
                </div>
              </div>
            </div>

            <div className="field">
              <label>保存名称</label>
              <input
                className="input"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void apply();
                  if (e.key === 'Escape') onClose();
                }}
              />
            </div>

            <div className="settings-row">
              <div className="grow">
                <div className="lbl">加入当前仓库</div>
                <div className="desc">
                  {addToVault
                    ? '文件会被复制到仓库目录，并纳入同步与历史版本管理'
                    : '仅在本次会话中查看，不写入仓库'}
                </div>
              </div>
              <button
                className={`switch ${addToVault ? 'on' : ''}`}
                onClick={() => setAddToVault((v) => !v)}
                aria-pressed={addToVault}
              />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={() => void apply()} disabled={busy || !name.trim()}>
            {busy ? '打开中…' : '打开'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 监听外部打开请求的 Hook */
export function useExternalFiles(onFile: (f: ExternalFile) => void) {
  const cbRef = useRef(onFile);
  cbRef.current = onFile;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const startup = await takeStartupFile();
      if (!cancelled && startup) cbRef.current(startup);
    })();

    const off = onExternalFile((f) => cbRef.current(f));
    void registerFileHandlers((f) => cbRef.current(f));

    return () => {
      cancelled = true;
      off();
    };
  }, []);
}

/** 工具栏「打开外部文件」按钮逻辑 */
export async function openExternal(
  onFile: (f: ExternalFile) => void,
  onError: (msg: string) => void,
): Promise<void> {
  const file = await pickExternalFile();
  if (!file) return;
  if (!/\.(md|markdown)$/i.test(file.name)) {
    onError('请选择 Markdown 文件');
    return;
  }
  onFile(file);
}

export { Icon };
