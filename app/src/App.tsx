import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from './state';
import { Sidebar } from './ui/Sidebar';
import { Workbench } from './ui/Workbench';
import { SettingsDialog } from './ui/Settings';
import { NewDocDialog } from './ui/NewDoc';
import { CommandPalette } from './ui/CommandPalette';
import { AiTitleDialog } from './ui/AiTitle';
import { ExternalImportDialog, useExternalFiles } from './ui/ExternalFile';
import type { ExternalFile } from './core/external';
import { Icon } from './ui/icons';
import { isMobile } from './lib/util';

const DEFAULT_TIMESTAMP_NAME = /^\d{2}年\d{2}月\d{2}日\d{4}-【/;

export default function App() {
  const store = useAppStore();
  const { settings, setSettings, sidebarOpen, setSidebarOpen, toasts, ready } = store;

  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showAiTitle, setShowAiTitle] = useState(false);
  const [externalFile, setExternalFile] = useState<ExternalFile | null>(null);

  // 系统关联打开 / PWA 文件处理 / 启动参数
  useExternalFiles((f) => setExternalFile(f));

  const collapsed = settings.sidebarCollapsed && !sidebarOpen;

  const openNew = useCallback(() => setShowNew(true), []);
  const openSettings = useCallback(() => setShowSettings(true), []);
  const openPalette = useCallback(() => setShowPalette(true), []);

  const toggleSidebar = useCallback(() => {
    if (isMobile()) setSidebarOpen(!sidebarOpen);
    else setSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
  }, [sidebarOpen, setSidebarOpen, setSettings, settings.sidebarCollapsed]);

  /* 命令面板派发的自定义事件 */
  useEffect(() => {
    const onNew = () => setShowNew(true);
    const onSettings = () => setShowSettings(true);
    const onExternal = (e: Event) => {
      const detail = (e as CustomEvent).detail as ExternalFile | undefined;
      if (detail) setExternalFile(detail);
    };
    window.addEventListener('mdnote:new', onNew);
    window.addEventListener('mdnote:settings', onSettings);
    window.addEventListener('mdnote:external-file', onExternal);
    return () => {
      window.removeEventListener('mdnote:new', onNew);
      window.removeEventListener('mdnote:settings', onSettings);
      window.removeEventListener('mdnote:external-file', onExternal);
    };
  }, []);

  /* 应用级快捷键 */
  useEffect(() => {
    const matches = (spec: string, e: KeyboardEvent): boolean => {
      const parts = spec.split('+').map((p) => p.trim().toLowerCase());
      const needCtrl = parts.includes('mod') || parts.includes('ctrl') || parts.includes('cmd');
      const needShift = parts.includes('shift');
      const needAlt = parts.includes('alt');
      const main = parts.filter((p) => !['mod', 'ctrl', 'cmd', 'shift', 'alt', 'meta'].includes(p))[0];
      if (!main) return false;
      if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
      if (needShift !== e.shiftKey) return false;
      if (needAlt !== e.altKey) return false;
      const key = e.key.toLowerCase();
      if (key === main) return true;
      if (/^[a-z]$/.test(main) && e.code === `Key${main.toUpperCase()}`) return true;
      if (/^[0-9]$/.test(main) && e.code === `Digit${main}`) return true;
      if (main === '\\' && (e.code === 'Backslash' || key === '\\')) return true;
      if (main === ',' && (e.code === 'Comma' || key === ',')) return true;
      if (main === '.' && (e.code === 'Period' || key === '.')) return true;
      if (main === '-' && (e.code === 'Minus' || key === '-')) return true;
      return false;
    };

    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const km = settings.keymap;

      if (matches(km['edit.palette'] ?? 'Mod+P', e)) {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }
      if (matches(km['edit.settings'] ?? 'Mod+,', e)) {
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      if (matches(km['edit.new'] ?? 'Mod+N', e)) {
        e.preventDefault();
        setShowNew(true);
        return;
      }
      if (matches(km['edit.toggleSidebar'] ?? 'Mod+\\', e)) {
        e.preventDefault();
        if (isMobile()) setSidebarOpen((v) => !v);
        else setSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settings.keymap, settings.sidebarCollapsed, setSettings, setSidebarOpen]);

  /* 保存：AI 命名模式下若仍是时间戳文件名，弹出标题生成 */
  const handleSave = useCallback(async () => {
    const pathBefore = store.currentPath;
    await store.saveDoc();
    if (!pathBefore) return;
    if (!settings.ai.enabled) return;

    const name = (pathBefore.split('/').pop() ?? '').replace(/\.md$/i, '');
    if (DEFAULT_TIMESTAMP_NAME.test(name)) {
      setShowAiTitle(true);
    }
  }, [store, settings.ai.enabled]);

  if (!ready) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: 'var(--c-bg)' }}>
        <div style={{ display: 'grid', placeItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 15,
              background: 'linear-gradient(145deg, var(--c-primary), #4c9aff)',
              display: 'grid', placeItems: 'center', color: '#fff',
            }}
          >
            <Icon name="logo" size={30} />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--c-text-3)' }}>正在加载仓库…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${sidebarOpen ? 'drawer-open' : ''}`}>
      <aside className="sidebar">
        <Sidebar
          store={store}
          onNewDoc={openNew}
          onOpenSettings={openSettings}
          onClose={() => setSidebarOpen(false)}
        />
      </aside>

      {sidebarOpen && isMobile() && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <Workbench
        store={store}
        onOpenSettings={openSettings}
        onOpenPalette={openPalette}
        onNewDoc={openNew}
        onToggleSidebar={toggleSidebar}
        onSave={() => void handleSave()}
      />

      {showSettings && <SettingsDialog store={store} onClose={() => setShowSettings(false)} />}
      {showNew && <NewDocDialog store={store} onClose={() => setShowNew(false)} />}
      {showPalette && <CommandPalette store={store} onClose={() => setShowPalette(false)} />}
      {showAiTitle && <AiTitleDialog store={store} onClose={() => setShowAiTitle(false)} />}
      {externalFile && (
        <ExternalImportDialog
          store={store}
          file={externalFile}
          onClose={() => setExternalFile(null)}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' && <Icon name="check" size={14} />}
            {t.kind === 'err' && <Icon name="info" size={14} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
