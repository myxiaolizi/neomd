import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../state';
import { generateTitle } from '../core/ai';
import { Icon } from './icons';
import { fmtCount } from '../lib/util';

interface Props {
  store: AppStore;
  onClose: () => void;
}

/** 保存时触发的 AI 标题生成与确认 */
export function AiTitleDialog({ store, onClose }: Props) {
  const { settings, currentContent, currentPath, renameDoc, toast } = store;
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await generateTitle(currentContent, settings.ai);
      if (cancelled) return;
      setTitle(r.title);
      if (r.error) setErr(r.error);
      setBusy(false);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async () => {
    const t = title.trim();
    if (!t || !currentPath) return;
    await renameDoc(currentPath, t);
    toast('已重命名为「' + t + '」', 'ok');
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>生成标题</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section" style={{ paddingTop: 4 }}>
            {busy ? (
              <div className="empty-state" style={{ padding: 32 }}>
                <div className="glyph"><Icon name="cloud" size={28} /></div>
                <div>正在阅读正文并生成标题…</div>
              </div>
            ) : (
              <>
                {err && (
                  <div
                    style={{
                      padding: '8px 11px',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-orange-soft)',
                      color: '#a45c14',
                      fontSize: 11.5,
                      lineHeight: 1.55,
                    }}
                  >
                    {err}（已改用本地提取的标题）
                  </div>
                )}
                <div className="field">
                  <label>标题</label>
                  <input
                    ref={inputRef}
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void apply();
                      if (e.key === 'Escape') onClose();
                    }}
                  />
                  <div className="hint">
                    正文 {fmtCount(currentContent.length)} 字符 · 可直接修改后确认
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>保留原名</button>
          <div className="spacer" />
          <button className="btn primary" onClick={() => void apply()} disabled={busy || !title.trim()}>
            应用标题
          </button>
        </div>
      </div>
    </div>
  );
}
