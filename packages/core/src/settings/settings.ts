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
      /*
       * 默认行高 1.6（1.2.1 缺陷1）。
       *
       * 改前是 1.75。实测单行高度确实等于 16 × 1.75 = 28px（没有叠加），
       * 但 28px 行盒里 16px 字号的字形只占 20px，上下各 4px half-leading，
       * 叠上段落 margin 之后相邻两段的字形间净空白达到 21.6px（1.35em）——
       * 比一整行还空，这才是用户看到的「行距过大」。
       *
       * 为什么改默认值而不是只改 CSS：`--content-line-height` 由
       * `apps/web/src/stores/settings.ts` 按 `appearance.lineHeight` 写到 <html> 上，
       * 内联变量会**遮蔽** content.css 里的兜底值。所以只改 CSS 兜底对真实用户
       * 完全无效，必须连同默认值一起下调，两处才一致。
       *
       * 档位语义不变：设置面板仍是 1.2~2.6 的裸倍数，填 1.75 就是 1.75，
       * 不做任何隐式换算 —— 用户看到的值就是生效的值。
       */
      lineHeight: 1.6,
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
        'diagram-flowchart',
        'diagram-mindmap',
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

/* ------------------------------------------------------------------ */
/* 命名设置乱码纠偏（1.4.0 需求9）                                      */
/* ------------------------------------------------------------------ */

/**
 * 已知的「命名模板乱码签名」**精确匹配表**。
 *
 * ## 这不是 GBK 乱码，也不是字符集问题（已用实验排除）
 *
 * 1.4.0 排查结论（完整证据见 `docs/shots-140/re14-*`）：
 *  - 源文件按 UTF-8 扫描 GBK 特征串（`閿|銆|鏂|…`）**命中 0 处**；
 *  - `SHOW CREATE TABLE user_settings` 是 `utf8mb4`，连接/客户端/结果字符集均
 *    `utf8mb4`，且 `sql_mode` 含 `STRICT_TRANS_TABLES`（不可表示会**报错**而非静默替换）；
 *  - `crypto.js` 的编码参数全为 `utf8`；
 *  - **6 组对照值往返实验**（`ABC123` / `AB{CD}EF` / `AB日CD` / `YYMMDD日HHMM-{input}`
 *    / `AB-CD_EF.G` / `AB CD:E*F?G`）全部**原样完好** —— 证明当前代码库不存在产生该乱码的路径。
 *
 * 因此判定为**历史版本遗留在云端/本地的脏数据**。原值经逐字符对齐反推：
 *   落库 `YY?MM?DD?HHMM-?input?`（21 字符）
 *   原值 `YY年MM月DD日HHMM-{input}`（21 字符）
 *   规则 = **非 ASCII 字符 或 花括号 `{` `}` → 单个 `?`**
 * 旁证：`SettingsPage.vue` 的 placeholder 至今写着 `YY年MM月DD日HHMM`（该旧模板的前半段）。
 *
 * ## 为什么用「精确签名」而不是比例启发式
 *
 * 比例启发式（「不含 CJK 且 `?` 占比高」）会**误杀合法配置**：
 * 用户自定义模板 `A?B?C` 的 `?` 占比 40% 且不含 CJK，会被重置 —— 这是数据丢失。
 * 因此这里只认**已知签名**：命中即修复，不命中一律原样保留。
 * 宁可少纠一个，也不误重置一个用户的自定义设置。
 */
const KNOWN_GARBLED_TEMPLATES = new Set([
  // 旧版默认模板 `YY年MM月DD日HHMM-{input}` 被「非 ASCII/花括号 → ?」破坏的结果
  'YY?MM?DD?HHMM-?input?',
  // 同一转换作用在上面的变体（不同旧版本可能带/不带 input 占位）
  'YY?MM?DD?HHMM-?input',
  'YYYY?MM?DD?HHMM-?input?',
  // `YY-MM-DD日HHMM-{input}` 变体
  'YY-MM-DD?HHMM-?input?',
  // 纯中文模板被整段替换（例如 `第{input}问` → `???input?`）
  '?????-?input?',
]);

/**
 * 判断命名模板是否为**已知的乱码签名**。
 *
 * 只做精确匹配，不做任何比例推断 —— 见上方注释的误杀风险说明。
 */
export function isKnownGarbledTemplate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return KNOWN_GARBLED_TEMPLATES.has(value.trim());
}

/**
 * 判断兜底名称是否被乱码破坏。
 *
 * `fallback` 的破坏形态高度可预测：整串被替换成等长 `?`
 * （`无标题`(3) → `???`(3)）。这里要求**整串只由 `?` 组成且长度 ≥ 2**，
 * 这样 `none`、`无标题`、空串、用户自定义的英文 fallback 都不会被误伤。
 */
export function isGarbledFallback(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s.length >= 2 && /^\?+$/.test(s);
}

/**
 * 判断 AI 命名提示词是否被乱码破坏。
 *
 * 强约束（三条**同时**成立才判定，任一不满足就保留原值）：
 *  1. 不含任何 CJK 字符（默认提示词是纯中文，正常值必然含 CJK）；
 *  2. **长度与默认提示词完全相等**（1:1 替换不改变字符数，163 ↔ 163 实测吻合）；
 *  3. `?` 占比 ≥ 30%（实测 103/163 ≈ 63%）。
 *
 * 长度约束是关键：它让「用户自己写了一段英文提示词」这类合法配置
 * （长度几乎不可能恰好等于默认值）不会被误判。
 */
export function isGarbledAiPrompt(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (/[\u4e00-\u9fa5]/.test(value)) return false;
  if (value.length !== DEFAULT_AI_TITLE_PROMPT.length) return false;
  const q = [...value].filter((c) => c === '?').length;
  return q / value.length >= 0.3;
}

/** 乱码纠偏的结果与备份 */
export interface GarbleRepairResult {
  naming: Settings['naming'];
  /** 被修复的字段名（为空表示没动） */
  repaired: string[];
  /** 修复前的原值备份（写回 `naming.garbleBackup`，便于人工恢复） */
  backup: { template?: string; fallback?: string; aiPrompt?: string; at: number } | null;
}

/**
 * 对 `naming` 做乱码纠偏（纯函数，可单测）。
 *
 * 设计要点：
 *  - **只认已知签名**，不命中的值原样返回（绝不误重置用户自定义配置）；
 *  - 命中时把原值写进 `garbleBackup`，万一将来发现误判可以人工恢复；
 *  - 回落到**当前默认值**（`DEFAULT_NAMING_TEMPLATE` / `'无标题'` / `DEFAULT_AI_TITLE_PROMPT`）。
 */
export function repairGarbleNaming(naming: Settings['naming']): GarbleRepairResult {
  const repaired: string[] = [];
  const backup: { template?: string; fallback?: string; aiPrompt?: string; at: number } = { at: Date.now() };
  const next: Settings['naming'] = { ...naming };

  if (isKnownGarbledTemplate(naming.template)) {
    backup.template = naming.template;
    next.template = DEFAULT_NAMING_TEMPLATE;
    repaired.push('template');
  }
  if (isGarbledFallback(naming.fallback)) {
    backup.fallback = naming.fallback;
    next.fallback = '无标题';
    repaired.push('fallback');
  }
  if (isGarbledAiPrompt(naming.aiPrompt)) {
    backup.aiPrompt = String(naming.aiPrompt);
    next.aiPrompt = DEFAULT_AI_TITLE_PROMPT;
    repaired.push('aiPrompt');
  }

  if (!repaired.length) return { naming, repaired, backup: null };
  // 备份挂到 naming 上（以可选字段形式持久化，类型上通过索引访问，不改 shared 的接口定义）
  (next as Settings['naming'] & { garbleBackup?: unknown }).garbleBackup = backup;
  return { naming: next, repaired, backup };
}

/** 深度合并设置（用于云端->本地同步，保留本地密钥不被空值覆盖） */
export function mergeSettings(local: Settings, remote: Partial<Settings> | null | undefined): Settings {
  if (!remote) return local;
  const out: Settings = JSON.parse(JSON.stringify(local)) as Settings;
  if (remote.appearance) out.appearance = { ...out.appearance, ...remote.appearance };
  if (remote.naming) {
    /*
     * 1.4.0 需求9：合并后立刻做乱码纠偏。
     *
     * 为什么放在这里 —— 这是**所有设置读入的统一入口**：
     * 本地 localStorage 读、云端 `pullCloudSettings()` 拉回后的合并，都经过 mergeSettings。
     * 一处生效，覆盖两条路径，且是纯函数、可直接单测。
     * 详见 `repairGarbleNaming()` 上方关于「为什么不是 GBK / 为什么用精确签名」的说明。
     */
    out.naming = repairGarbleNaming({ ...out.naming, ...remote.naming }).naming;
  }
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
