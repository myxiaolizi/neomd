import { useEffect, useState } from 'react';
import type { AppStore } from '../state';
import { buildDefaultName } from '../lib/util';
import { Icon } from './icons';
import type { NamingMode } from '../core/types';

interface Props {
  store: AppStore;
  onClose: () => void;
}

export function NewDocDialog({ store, onClose }: Props) {
  const { settings, setSettings, createDoc, toast } = store;
  const [mode, setMode] = useState<NamingMode>(settings.namingMode);
  const [keyword, setKeyword] = useState('');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === 'datetime') {
      setPreview(buildDefaultName(keyword || '关键词') + '.md');
    } else {
      setPreview(keyword ? `（保存时由 AI 生成标题）· 暂存为 ${buildDefaultName(keyword)}.md` : '保存时由 AI 根据正文生成标题');
    }
  }, [mode, keyword]);

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

  const submit = async () => {
    setBusy(true);
    try {
      const name =
        mode === 'datetime'
          ? buildDefaultName(keyword)
          : buildDefaultName(keyword || '未命名');
      const path = await createDoc(name, '');
      if (path) {
        if (mode !== settings.namingMode) setSettings({ namingMode: mode });
        toast(
          mode === 'ai' ? '已创建，保存时将生成标题' : '已创建',
          'ok',
        );
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
          <h2>新建笔记</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section" style={{ paddingTop: 4 }}>
            <div className="field">
              <label>命名方式</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button
                  className={`btn ${mode === 'datetime' ? 'primary' : ''}`}
                  style={{ height: 'auto', padding: '10px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}
                  onClick={() => setMode('datetime')}
                >
                  <span style={{ fontWeight: 650 }}>日期时间 + 关键词</span>
                  <span style={{ fontSize: 11, opacity: mode === 'datetime' ? 0.85 : 0.65, fontWeight: 400 }}>
                    YY年MM月DD日HHMM-【关键词】
                  </span>
                </button>
                <button
                  className={`btn ${mode === 'ai' ? 'primary' : ''}`}
                  style={{ height: 'auto', padding: '10px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}
                  onClick={() => setMode('ai')}
                >
                  <span style={{ fontWeight: 650 }}>AI 生成标题</span>
                  <span style={{ fontSize: 11, opacity: mode === 'ai' ? 0.85 : 0.65, fontWeight: 400 }}>
                    保存时根据正文自动命名
                  </span>
                </button>
              </div>
            </div>

            <div className="field">
              <label>{mode === 'datetime' ? '关键词' : '初始关键词（可选）'}</label>
              <input
                className="input"
                autoFocus
                placeholder={mode === 'datetime' ? '例如：会议记录' : '留空则完全由 AI 决定'}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void submit();
                  if (e.key === 'Escape') onClose();
                }}
              />
            </div>

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--r-md)',
                background: 'var(--c-surface-2)',
                border: '1px solid var(--c-line)',
                fontSize: 12,
                color: 'var(--c-text-2)',
                wordBreak: 'break-all',
                lineHeight: 1.6,
              }}
            >
              <span style={{ color: 'var(--c-text-3)' }}>文件名预览：</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{preview}</span>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
