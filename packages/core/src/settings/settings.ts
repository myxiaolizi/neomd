import type { Settings, ShortcutBinding, PageWidth, ServerSettings } from '@neomd/shared';
import { PLUGINS, DEFAULT_NAMING_TEMPLATE } from '@neomd/shared';

/** 服务端连接默认值（严格本地配置，跨端不同步） */
const DEFAULT_SERVER: ServerSettings = {
  mode: 'official',
  customBaseUrl: '',
  privacyMode: false,
};

export const SETTINGS_KEY = 'neomd.settings.v1';

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { command: 'editor.h1', keys: ['Ctrl+1'] },
  { command: 'editor.h2', keys: ['Ctrl+2'] },
  { command: 'editor.h3', keys: ['Ctrl+3'] },
  { command: 'editor.h4', keys: ['Ctrl+4'] },
  { command: 'editor.h5', keys: ['Ctrl+5'] },
  { command: 'editor.h6', keys: ['Ctrl+6'] },
  { command: 'editor.bold', keys: ['Ctrl+B'] },
  { command: 'editor.italic', keys: ['Ctrl+I'] },
  { command: 'editor.underline', keys: ['Ctrl+U'] },
  { command: 'editor.strike', keys: ['Ctrl+Shift+X'] },
  { command: 'editor.highlight', keys: ['Ctrl+Shift+H'] },
  { command: 'editor.code', keys: ['Ctrl+E'] },
  { command: 'editor.codeBlock', keys: ['Ctrl+Shift+E'] },
  { command: 'editor.link', keys: ['Ctrl+K'] },
  { command: 'editor.quote', keys: ['Ctrl+Shift+Q'] },
  { command: 'editor.taskList', keys: ['Ctrl+Shift+T'] },
  { command: 'editor.bulletList', keys: ['Ctrl+Shift+8'] },
  { command: 'editor.numberedList', keys: ['Ctrl+Shift+9'] },
  { command: 'editor.table', keys: ['Ctrl+Shift+M'] },
  { command: 'editor.hr', keys: ['Ctrl+Shift+-'] },
  { command: 'app.save', keys: ['Ctrl+S'] },
  { command: 'app.sync', keys: ['Ctrl+S'] },
  { command: 'app.commandPalette', keys: ['Ctrl+P'] },
  { command: 'app.quickSwitch', keys: ['Ctrl+O'] },
  { command: 'app.search', keys: ['Ctrl+Shift+F'] },
  { command: 'app.newNote', keys: ['Ctrl+N'] },
  { command: 'app.closeTab', keys: ['Ctrl+W'] },
  { command: 'app.reopenTab', keys: ['Ctrl+Shift+T'] },
  { command: 'app.toggleSidebar', keys: ['Ctrl+\\'] },
  { command: 'app.toggleAi', keys: ['Ctrl+Shift+A'] },
  { command: 'app.toggleMode', keys: ['Ctrl+E'] },
  { command: 'app.settings', keys: ['Ctrl+,'] },
  { command: 'app.export', keys: ['Ctrl+Shift+P'] },
  { command: 'daily.today', keys: ['Ctrl+D'] },
  { command: 'random.open', keys: ['Ctrl+Shift+R'] },
];

export const DEFAULT_TOOLBAR_ITEMS: string[] = [
  'undo',
  'redo',
  'h1',
  'h2',
  'h3',
  'bold',
  'italic',
  'underline',
  'strike',
  'highlight',
  'code',
  'ul',
  'ol',
  'task',
  'quote',
  'table',
  'link',
  'codeblock',
  'hr',
];

export const DEFAULT_AI_TITLE_PROMPT = `你是笔记标题生成器。阅读用户给出的 Markdown 正文，生成一个准确、简洁的中文标题。
要求：
1. 只输出标题本身，不要引号、不要标点结尾、不要解释；
2. 长度 6-24 个汉字（英文概念可保留原词）；
3. 若正文含一级标题，可参考但需更精炼；
4. 不得包含 / \\ : * ? " < > | 等文件名非法字符。`;

export function defaultSettings(): Settings {
  const enabledPlugins: Record<string, boolean> = {};
  for (const p of PLUGINS) enabledPlugins[p.id] = p.defaultEnabled;
  return {
    version: 1,
    appearance: {
      theme: 'system',
      accent: '#1677FF',
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 1.75,
      pageWidth: 'standard' as PageWidth,
      showLineNumbers: true,
      spellcheck: false,
      typewriterMode: false,
      editorColorScheme: 'white',
      customEditorBg: '#ffffff',
      customEditorFg: '#1f2329',
      // 正文缩放：100% 为基准，Ctrl+滚轮每格 5%，范围 50-300
      zoom: 100,
      themePresetId: 'daylight',
      customThemes: [],
    },
    naming: {
      mode: 'datetime-input',
      // 1.0.2 起默认命名：YYMMDD日HHMM-（AI 可用时在末尾追加 4-10 字内容缩写）
      template: DEFAULT_NAMING_TEMPLATE,
      fallback: '无标题',
      confirmBeforeRename: false,
      aiPrompt: DEFAULT_AI_TITLE_PROMPT,
      appendAiSummary: true,
    },
    autosave: {
      enabled: true,
      versionMinutes: 5,
      versionChars: 300,
    },
    shareStyle: {
      brandTitle: '',
      brandSubtitle: '',
      accentColor: '#1677FF',
      paperStyle: 'white',
      hideProductBrand: true,
    },
    localVault: {
      root: '',
      keepVersions: false,
    },
    server: { ...DEFAULT_SERVER },
    // AI 知识库默认值（1.1.0）：默认关闭，开启后按段落切分，兼顾精度与上下文
    knowledge: {
      enabled: false,
      granularity: 'paragraph',
      chunkSize: 800,
      chunkOverlap: 120,
      topK: 6,
      minScore: 0.15,
      searchMode: 'hybrid',
      keepMarkdown: true,
      includeFrontmatter: false,
      excludeFolders: [],
      excludeTags: [],
      maxDocChars: 200_000,
      autoIndex: true,
      maxContextChunks: 8,
    },
    // 思维导图 / 流程图默认值（1.1.0）
    diagram: {
      mindmapLayout: 'right',
      grid: 'dot',
      snapToGrid: true,
      gridSize: 20,
      nodeFill: '#e8f2ff',
      nodeStroke: '#1677FF',
      edgeStroke: '#8a919c',
      autoSave: true,
      showMinimap: true,
    },
    layout: {
      ribbonEnabled: true,
      ribbonPosition: 'left',
      ribbonItems: [
        'daily-notes',
        'random-note',
        'graph',
        'tag-list',
        'bookmarks',
        'file-recovery',
        'whiteboard',
        'slides',
        'database',
        'web-browser',
      ],
      leftPanelMode: 'files',
      leftPanelOpen: true,
      leftPanelWidth: 260,
      rightPanelOpen: false,
      rightPanelWidth: 400,
      rightPanelSections: ['ai', 'file'],
      showRecent: true,
      recentCount: 8,
      editorToolbar: true,
      toolbarItems: [...DEFAULT_TOOLBAR_ITEMS],
      outlineHeight: 320,
    },
    shortcuts: DEFAULT_SHORTCUTS.map((s) => ({ ...s })),
    enabledPlugins,
    storage: {
      provider: 'aliyun-oss',
      endpoint: 'https://s3.oss-cn-guangzhou.aliyuncs.com',
      region: 'cn-guangzhou',
      bucket: '',
      accessKeyId: '',
      accessKeySecret: '',
      publicDomain: '',
      urlStyle: 'virtual-hosted',
      isPrivate: true,
      basePrefix: 'mdadmin/',
      useTls: true,
    },
    ai: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      models: [],
      temperature: 0.7,
      maxTokens: 4096,
      viaProxy: false,
      usePlatform: false,
    },
    sync: {
      rootPrefix: 'mdadmin/neomd/',
      deviceId: '',
      deviceName: '',
      autoSyncIntervalMs: 120_000,
      versionRetentionDays: 90,
      versionRetentionCount: 200,
    },
    cloudVersion: 0,
    updatedAt: Date.now(),
  };
}

/** 深度合并设置（用于云端->本地同步，保留本地密钥不被空值覆盖） */
export function mergeSettings(local: Settings, remote: Partial<Settings> | null | undefined): Settings {
  if (!remote) return local;
  const out: Settings = JSON.parse(JSON.stringify(local)) as Settings;
  if (remote.appearance) out.appearance = { ...out.appearance, ...remote.appearance };
  if (remote.naming) out.naming = { ...out.naming, ...remote.naming };
  if (remote.autosave) out.autosave = { ...(out.autosave ?? { enabled: true, versionMinutes: 5, versionChars: 300 }), ...remote.autosave };
  if (remote.shareStyle) out.shareStyle = { ...(out.shareStyle ?? { brandTitle: '', brandSubtitle: '', accentColor: '#1677FF', paperStyle: 'white', hideProductBrand: true }), ...remote.shareStyle };
  if (remote.localVault) out.localVault = { ...(out.localVault ?? { root: '', keepVersions: false }), ...remote.localVault };
  // server（自定义服务器/私有化）属于**严格本地配置**：
  // 云端下发的 server 一律忽略（避免 A 电脑的私有化开关把 B 电脑断网），
  // 但本地已存在的值必须原样保留——否则一次 merge 就会把用户的服务器地址清空。
  out.server = { ...DEFAULT_SERVER, ...out.server, ...(local.server ?? {}) };
  // knowledge / diagram 属于「按平台差异化」偏好，云端下发时按浅合并补齐缺省字段
  if (remote.knowledge) out.knowledge = { ...(out.knowledge ?? {}), ...remote.knowledge } as Settings['knowledge'];
  if (remote.diagram) out.diagram = { ...(out.diagram ?? {}), ...remote.diagram } as Settings['diagram'];
  if (remote.layout) out.layout = { ...out.layout, ...remote.layout };
  if (remote.enabledPlugins) out.enabledPlugins = { ...out.enabledPlugins, ...remote.enabledPlugins };
  if (remote.shortcuts && Array.isArray(remote.shortcuts)) out.shortcuts = remote.shortcuts;
  if (remote.storage) {
    // 云端不下发密钥时保留本地
    const merged = { ...out.storage, ...remote.storage };
    if (!remote.storage.accessKeySecret) merged.accessKeySecret = out.storage.accessKeySecret;
    if (!remote.storage.accessKeyId) merged.accessKeyId = out.storage.accessKeyId;
    out.storage = merged;
  }
  if (remote.ai) {
    const merged = { ...out.ai, ...remote.ai };
    if (!remote.ai.apiKey) merged.apiKey = out.ai.apiKey;
    out.ai = merged;
  }
  if (remote.sync) out.sync = { ...out.sync, ...remote.sync, deviceId: out.sync.deviceId };
  if (typeof remote.cloudVersion === 'number') out.cloudVersion = remote.cloudVersion;
  out.updatedAt = Date.now();
  return out;
}

/** 键盘事件 -> 规范化组合键字符串 */
export function eventToKeys(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key) return null;
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead'].includes(key)) return null;
  const parts: string[] = [];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  if (e.ctrlKey || e.metaKey) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let main = key;
  if (key === ' ') main = 'Space';
  else if (key.length === 1) main = key.toUpperCase();
  else if (key === 'Escape') main = 'Esc';
  else if (key === '\\') main = '\\';
  parts.push(main);
  return parts.join('+');
}

/** 组合键归一化（用于比较，兼容 Cmd/Ctrl 与大小写） */
export function normalizeKeys(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      const t = p.trim();
      if (!t) return '';
      const lower = t.toLowerCase();
      if (lower === 'cmd' || lower === 'meta') return 'Ctrl';
      if (lower === 'control') return 'Ctrl';
      if (lower === 'esc') return 'Esc';
      if (lower === 'space') return 'Space';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      return t.length === 1 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .filter(Boolean)
    .join('+');
}

export class ShortcutRegistry {
  private map = new Map<string, string[]>();

  constructor(bindings: ShortcutBinding[] = DEFAULT_SHORTCUTS) {
    this.setBindings(bindings);
  }

  setBindings(bindings: ShortcutBinding[]): void {
    this.map.clear();
    for (const b of bindings) {
      for (const key of b.keys) {
        const norm = normalizeKeys(key);
        const list = this.map.get(norm) ?? [];
        list.push(b.command);
        this.map.set(norm, list);
      }
    }
  }

  /** 返回命中的命令 id 列表（允许多命令共用组合键，按注册顺序） */
  resolve(combo: string): string[] {
    return this.map.get(normalizeKeys(combo)) ?? [];
  }

  /** 检测冲突：返回重复占用的组合键 */
  conflicts(): Array<{ keys: string; commands: string[] }> {
    const out: Array<{ keys: string; commands: string[] }> = [];
    for (const [keys, commands] of this.map) {
      if (commands.length > 1) out.push({ keys, commands });
    }
    return out;
  }

  commandsOf(keys: string): string[] {
    return this.map.get(normalizeKeys(keys)) ?? [];
  }
}
