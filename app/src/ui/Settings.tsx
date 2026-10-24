import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../state';
import { DEFAULT_KEYMAP, ACTION_LABELS } from '../core/settings';
import { eventToSpec, fmtKey, fmtBytes, fmtCount } from '../lib/util';
import { Icon } from './icons';
import type { NamingMode } from '../core/types';

type Tab = 'general' | 'editor' | 'keys' | 'sync' | 'ai' | 'about';

interface Props {
  store: AppStore;
  onClose: () => void;
}

export function SettingsDialog({ store, onClose }: Props) {
  const { settings, setSettings, replaceSettings, engine, toast, adapter, docs } = store;
  const [tab, setTab] = useState<Tab>('general');

  // Esc 关闭
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

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>

        <div className="tabs">
          {(
            [
              ['general', '通用'],
              ['editor', '编辑'],
              ['keys', '快捷键'],
              ['sync', '同步'],
              ['ai', 'AI 命名'],
              ['about', '关于'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={`tab ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'general' && <GeneralTab store={store} />}
          {tab === 'editor' && <EditorTab store={store} />}
          {tab === 'keys' && <KeysTab store={store} />}
          {tab === 'sync' && <SyncTab store={store} engine={engine} toast={toast} />}
          {tab === 'ai' && <AiTab store={store} />}
          {tab === 'about' && <AboutTab store={store} adapterName={adapter?.location} count={docs.length} />}
        </div>

        <div className="modal-foot">
          <button
            className="btn sm"
            onClick={() => {
              replaceSettings({ ...settings, keymap: { ...DEFAULT_KEYMAP } });
              toast('已恢复默认快捷键', 'ok');
            }}
          >
            恢复默认
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- 通用 ------------------------- */

function GeneralTab({ store }: { store: AppStore }) {
  const { settings, setSettings, adapter, pickVault } = store;
  return (
    <div className="settings-section">
      <h3>外观</h3>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">主题</div>
          <div className="desc">跟随系统时会随系统明暗自动切换</div>
        </div>
        <select
          className="input"
          style={{ width: 130 }}
          value={settings.theme}
          onChange={(e) => setSettings({ theme: e.target.value as 'light' | 'dark' | 'auto' })}
        >
          <option value="auto">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">主色调</div>
          <div className="desc">影响按钮、选中态与强调色</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['#1677ff', '#0f766e', '#7c3aed', '#db2777', '#ea580c'].map((c) => (
            <button
              key={c}
              onClick={() => setSettings({ accent: c })}
              title={c}
              style={{
                width: 24, height: 24, borderRadius: 6, background: c,
                border: settings.accent === c ? '2px solid var(--c-text)' : '1px solid var(--c-line-strong)',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>

      <h3 style={{ marginTop: 8 }}>命名方式</h3>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">新建笔记时的标题来源</div>
          <div className="desc">
            {settings.namingMode === 'ai'
              ? '保存时调用 AI 阅读正文生成标题'
              : '格式：YY年MM月DD日HHMM-【关键词】'}
          </div>
        </div>
        <select
          className="input"
          style={{ width: 190 }}
          value={settings.namingMode}
          onChange={(e) => setSettings({ namingMode: e.target.value as NamingMode })}
        >
          <option value="datetime">日期时间 + 关键词</option>
          <option value="ai">AI 生成标题</option>
        </select>
      </div>

      <h3 style={{ marginTop: 8 }}>仓库</h3>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">当前仓库位置</div>
          <div className="desc" style={{ wordBreak: 'break-all' }}>{adapter?.location ?? '未选择'}</div>
        </div>
        <button className="btn sm" onClick={() => void pickVault()}>更换文件夹</button>
      </div>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">启动时打开上次的笔记</div>
        </div>
        <button
          className={`switch ${settings.restoreLast ? 'on' : ''}`}
          onClick={() => setSettings({ restoreLast: !settings.restoreLast })}
          aria-pressed={settings.restoreLast}
        />
      </div>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">打开外部文件时默认加入仓库</div>
          <div className="desc">
            双击 .md 文件或用拖放导入时，默认勾选「加入当前仓库」；
            关闭后可在弹窗中逐次决定
          </div>
        </div>
        <button
          className={`switch ${settings.autoImportExternal ? 'on' : ''}`}
          onClick={() => setSettings({ autoImportExternal: !settings.autoImportExternal })}
          aria-pressed={settings.autoImportExternal}
        />
      </div>

      <h3 style={{ marginTop: 8 }}>历史版本</h3>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">每篇保留版本数</div>
          <div className="desc">超出后自动清理最旧的版本</div>
        </div>
        <input
          className="input"
          type="number"
          min={5}
          max={500}
          style={{ width: 90 }}
          value={settings.versionLimit}
          onChange={(e) => setSettings({ versionLimit: Math.max(5, Number(e.target.value) || 80) })}
        />
      </div>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">自动版本最小间隔</div>
          <div className="desc">单位秒，避免频繁修改产生大量版本</div>
        </div>
        <input
          className="input"
          type="number"
          min={10}
          max={3600}
          style={{ width: 90 }}
          value={settings.versionIntervalSec}
          onChange={(e) => setSettings({ versionIntervalSec: Math.max(10, Number(e.target.value) || 90) })}
        />
      </div>
    </div>
  );
}

/* ------------------------- 编辑 ------------------------- */

function EditorTab({ store }: { store: AppStore }) {
  const { settings, setSettings } = store;
  const e = settings.editor;
  const patch = (p: Partial<typeof e>) => setSettings({ editor: { ...e, ...p } });

  return (
    <div className="settings-section">
      <h3>排版</h3>
      <Slider label="字号" value={e.fontSize} min={12} max={24} step={0.5} unit="px"
        onChange={(v) => patch({ fontSize: v })} />
      <Slider label="行高" value={e.lineHeight} min={1.3} max={2.2} step={0.02} unit=""
        onChange={(v) => patch({ lineHeight: v })} />
      <Slider label="正文宽度" value={e.maxWidth} min={560} max={1200} step={20} unit="px"
        onChange={(v) => patch({ maxWidth: v })} />

      <div className="settings-row">
        <div className="grow">
          <div className="lbl">正文字体</div>
          <div className="desc">留空使用系统默认字体</div>
        </div>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="例如：思源宋体"
          value={e.fontFamily}
          onChange={(ev) => patch({ fontFamily: ev.target.value })}
        />
      </div>

      <h3 style={{ marginTop: 8 }}>行为</h3>
      <Toggle label="拼写检查" value={e.spellcheck} onChange={(v) => patch({ spellcheck: v })} />
      <Toggle label="自动配对括号与符号" value={e.autoPair} onChange={(v) => patch({ autoPair: v })} />
    </div>
  );
}

function Slider({
  label, value, min, max, step, unit, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings-row">
      <div className="grow">
        <div className="lbl">{label}</div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 150, accentColor: 'var(--c-primary)' }}
      />
      <span style={{ width: 54, textAlign: 'right', fontSize: 12, color: 'var(--c-text-2)', fontVariantNumeric: 'tabular-nums' }}>
        {value}{unit}
      </span>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="settings-row">
      <div className="grow"><div className="lbl">{label}</div></div>
      <button className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)} aria-pressed={value} />
    </div>
  );
}

/* ------------------------- 快捷键 ------------------------- */

function KeysTab({ store }: { store: AppStore }) {
  const { settings, setSettings, toast } = store;
  const [recording, setRecording] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const recRef = useRef<string | null>(null);
  recRef.current = recording;

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const spec = eventToSpec(e);
      const conflict = Object.entries(settings.keymap).find(
        ([k, v]) => v === spec && k !== recording,
      );
      if (conflict) {
        toast(`该组合已被「${ACTION_LABELS[conflict[0]] ?? conflict[0]}」占用`, 'err');
        return;
      }
      setSettings({ keymap: { ...settings.keymap, [recording]: spec } });
      setRecording(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, settings.keymap, setSettings, toast]);

  const entries = Object.entries(settings.keymap).filter(([action]) => {
    if (!filter) return true;
    const label = ACTION_LABELS[action] ?? action;
    return label.includes(filter) || action.includes(filter.toLowerCase());
  });

  return (
    <div className="settings-section">
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">点击右侧按键组合即可重新录制</div>
          <div className="desc">按 Esc 取消录制；修改即时生效</div>
        </div>
        <input
          className="input"
          style={{ width: 160 }}
          placeholder="筛选…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="keymap">
        {entries.map(([action, spec]) => (
          <div key={action} className={`keymap-row ${recording === action ? 'recording' : ''}`}>
            <span className="kname">{ACTION_LABELS[action] ?? action}</span>
            <span className="kkeys">
              <button
                className="kbd"
                onClick={() => setRecording(recording === action ? null : action)}
                title="点击后按下新的组合键"
              >
                {recording === action ? '按下组合键…' : fmtKey(spec).join(' + ')}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------- 同步 ------------------------- */

function SyncTab({
  store, engine, toast,
}: { store: AppStore; engine: AppStore['engine']; toast: AppStore['toast'] }) {
  const { settings, setSettings } = store;
  const s = settings.sync;
  const [testing, setTesting] = useState(false);
  const patch = (p: Partial<typeof s>) => setSettings({ sync: { ...s, ...p } });

  const test = async () => {
    if (!engine) return;
    setTesting(true);
    const r = await engine.testConnection();
    setTesting(false);
    toast(r.message, r.ok ? 'ok' : 'err');
  };

  return (
    <div className="settings-section">
      <h3>连接</h3>
      <Toggle
        label="启用 S3 同步"
        value={s.enabled}
        onChange={(v) => patch({ enabled: v })}
      />
      <div className="field">
        <label>服务端点 Endpoint</label>
        <input
          className="input"
          placeholder="https://s3.us-east-1.amazonaws.com 或 https://minio.example.com"
          value={s.endpoint}
          onChange={(e) => patch({ endpoint: e.target.value })}
        />
        <div className="hint">AWS S3、MinIO、Cloudflare R2、阿里云 OSS、腾讯云 COS 均可</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label>区域 Region</label>
          <input className="input" value={s.region} onChange={(e) => patch({ region: e.target.value })} />
        </div>
        <div className="field">
          <label>存储桶 Bucket</label>
          <input className="input" value={s.bucket} onChange={(e) => patch({ bucket: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>前缀 Prefix</label>
        <input
          className="input"
          placeholder="mdnote/"
          value={s.prefix}
          onChange={(e) => patch({ prefix: e.target.value })}
        />
        <div className="hint">笔记会上传到 前缀/notes/，历史版本在 前缀/versions/</div>
      </div>

      <h3 style={{ marginTop: 8 }}>凭证</h3>
      <div className="field">
        <label>Access Key ID</label>
        <input className="input" value={s.accessKeyId} onChange={(e) => patch({ accessKeyId: e.target.value })} />
      </div>
      <div className="field">
        <label>Secret Access Key</label>
        <input
          className="input"
          type="password"
          value={s.secretAccessKey}
          onChange={(e) => patch({ secretAccessKey: e.target.value })}
        />
        <div className="hint">凭证仅保存在本机，不会上传到任何服务器</div>
      </div>

      <div className="settings-row">
        <div className="grow">
          <div className="lbl">路径风格寻址</div>
          <div className="desc">MinIO 等自建服务通常需要开启</div>
        </div>
        <button
          className={`switch ${s.forcePathStyle ? 'on' : ''}`}
          onClick={() => patch({ forcePathStyle: !s.forcePathStyle })}
          aria-pressed={s.forcePathStyle}
        />
      </div>

      <h3 style={{ marginTop: 8 }}>同步行为</h3>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">同步历史版本</div>
          <div className="desc">版本数据会一并上传，多设备可共享</div>
        </div>
        <button
          className={`switch ${s.syncVersions ? 'on' : ''}`}
          onClick={() => patch({ syncVersions: !s.syncVersions })}
          aria-pressed={s.syncVersions}
        />
      </div>
      <div className="settings-row">
        <div className="grow">
          <div className="lbl">自动同步间隔</div>
          <div className="desc">单位秒，0 表示只手动同步</div>
        </div>
        <input
          className="input"
          type="number"
          min={0}
          max={3600}
          style={{ width: 90 }}
          value={s.autoInterval}
          onChange={(e) => patch({ autoInterval: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, paddingTop: 6 }}>
        <button className="btn" onClick={() => void test()} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button className="btn primary" onClick={() => void store.syncNow()}>
          立即同步
        </button>
      </div>
    </div>
  );
}

/* ------------------------- AI ------------------------- */

function AiTab({ store }: { store: AppStore }) {
  const { settings, setSettings } = store;
  const a = settings.ai;
  const patch = (p: Partial<typeof a>) => setSettings({ ai: { ...a, ...p } });

  return (
    <div className="settings-section">
      <h3>标题生成</h3>
      <Toggle
        label="启用 AI 自动命名"
        value={a.enabled}
        onChange={(v) => {
          patch({ enabled: v });
          if (v && settings.namingMode !== 'ai') setSettings({ namingMode: 'ai' });
        }}
      />
      <div className="field">
        <label>接口地址</label>
        <input
          className="input"
          placeholder="https://api.openai.com/v1/chat/completions"
          value={a.endpoint}
          onChange={(e) => patch({ endpoint: e.target.value })}
        />
        <div className="hint">兼容 OpenAI Chat Completions 协议的任意服务</div>
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          className="input"
          type="password"
          value={a.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
        />
      </div>
      <div className="field">
        <label>模型</label>
        <input
          className="input"
          placeholder="gpt-4o-mini / qwen-plus / deepseek-chat"
          value={a.model}
          onChange={(e) => patch({ model: e.target.value })}
        />
      </div>
      <div className="field">
        <label>提示词</label>
        <textarea
          className="input"
          rows={5}
          value={a.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
        />
        <div className="hint">AI 不可用时会自动回退到本地提取首行作为标题</div>
      </div>
    </div>
  );
}

/* ------------------------- 关于 ------------------------- */

function AboutTab({
  store, adapterName, count,
}: { store: AppStore; adapterName?: string; count: number }) {
  const { settings } = store;
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      setUsage({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
    });
  }, []);

  return (
    <div className="settings-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 52, height: 52, borderRadius: 14,
            background: 'linear-gradient(145deg, var(--c-primary), #4c9aff)',
            display: 'grid', placeItems: 'center', color: '#fff', flex: 'none',
          }}
        >
          <Icon name="logo" size={28} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 650 }}>Markdown 笔记</div>
          <div style={{ fontSize: 12, color: 'var(--c-text-3)' }}>版本 1.0.0 · Windows / Android / Web</div>
        </div>
      </div>

      <h3 style={{ marginTop: 10 }}>存储</h3>
      <dl className="info-grid" style={{ padding: 0 }}>
        <dt>仓库位置</dt>
        <dd>{adapterName ?? '未选择'}</dd>
        <dt>笔记数量</dt>
        <dd>{fmtCount(count)}</dd>
        <dt>已用空间</dt>
        <dd>{fmtBytes(usage.usage)}{usage.quota ? ` / ${fmtBytes(usage.quota)}` : ''}</dd>
        <dt>命名方式</dt>
        <dd>{settings.namingMode === 'ai' ? 'AI 生成' : '日期时间 + 关键词'}</dd>
      </dl>

      <div className="field" style={{ marginTop: 6 }}>
        <div className="hint">
          笔记以明文 Markdown 保存在你选择的文件夹中，可直接用其他编辑器打开。
          元数据与历史版本存放在本机数据库中。
        </div>
      </div>
    </div>
  );
}
