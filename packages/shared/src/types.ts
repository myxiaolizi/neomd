/** 文档的稳定身份。重命名、移动目录都不会改变 docId。 */
export interface DocMeta {
  /** 稳定标识，创建时生成，永不变更 */
  docId: string;
  /** 仓库内相对路径，POSIX 分隔符，如 `notes/日记/2026-10-23.md` */
  path: string;
  /** 展示标题，默认取文件名去扩展名 */
  title: string;
  /** 内容版本号，每次本地保存 +1 */
  rev: number;
  /** 内容 sha256，前 16 位十六进制 */
  hash: string;
  /** 字节数 */
  size: number;
  createdAt: number;
  updatedAt: number;
  /** 最后一次同步的远端 rev，null 表示尚未同步 */
  syncedRev: number | null;
  /** 删除墓碑，非 null 表示已删除 */
  deletedAt: number | null;
}

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
  ctime: number;
  isDirectory: boolean;
}

export interface DocContent {
  meta: DocMeta;
  markdown: string;
}

export type EditorMode = 'source' | 'wysiwyg' | 'compare' | 'read';

export type PageWidth = 'narrow' | 'standard' | 'wide' | 'full';

export interface DocViewPrefs {
  mode?: EditorMode;
  pageWidth?: PageWidth;
  scrollTop?: number;
  cursor?: number;
}

/* ------------------------------------------------------------------ */
/* 仓库                                                                */
/* ------------------------------------------------------------------ */

export interface VaultRef {
  id: string;
  name: string;
  /** 宿主平台上的绝对路径或逻辑标识 */
  location: string;
  /** 适配器类型 */
  adapter: 'desktop-fs' | 'android-fs' | 'browser-idb';
  createdAt: number;
  lastOpenedAt: number;
}

/* ------------------------------------------------------------------ */
/* 对象存储                                                            */
/* ------------------------------------------------------------------ */

export type StorageProviderId =
  | 'aliyun-oss'
  | 'tencent-cos'
  | 'volcengine-tos'
  | 'baidu-bos'
  | 'jd-cloud'
  | 'kingsoft-ks3'
  | 'custom-s3';

export type UrlStyle = 'virtual-hosted' | 'path';

export interface StorageConfig {
  provider: StorageProviderId;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 自定义访问域名，如 https://mdadmin.zhengl.vip */
  publicDomain: string;
  urlStyle: UrlStyle;
  /** 默认私有桶，读文件时走预签名 */
  isPrivate: boolean;
  /** 对象键前缀，如 mdadmin/ */
  basePrefix: string;
  /** 强制使用 https */
  useTls: boolean;
}

export interface StorageProbeResult {
  ok: boolean;
  canList: boolean;
  canPut: boolean;
  canGet: boolean;
  canDelete: boolean;
  latencyMs: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export type AIProviderId =
  | 'platform'
  | 'deepseek'
  | 'xiaomi-mimo'
  | 'qwen'
  | 'tencent-hunyuan'
  | 'zhipu'
  | 'volcengine-ark'
  | 'baidu-qianfan'
  | 'custom-openai';

export interface AIConfig {
  provider: AIProviderId;
  baseUrl: string;
  apiKey: string;
  /** 默认模型（用于 AI 自动命名等后台任务） */
  model: string;
  /** 用户勾选的可用模型列表；为空时使用服务商预设 */
  models: string[];
  temperature: number;
  maxTokens: number;
  /** 走服务端代理而非直连 */
  viaProxy: boolean;
  /** 使用平台统一接口（由后台配置，按 tokens 扣积分） */
  usePlatform: boolean;
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export type AITaskKind = 'chat' | 'title' | 'generate' | 'polish' | 'format' | 'tags' | 'summary';

export interface AITaskRequest {
  kind: AITaskKind;
  /** 用户指令或上下文说明 */
  instruction: string;
  /** 需要处理的正文 */
  content: string;
  /** 附加元信息，如标题、现有标签 */
  context?: Record<string, string>;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AIStreamEvent {
  type: 'delta' | 'done' | 'error';
  text?: string;
  usage?: AIUsage;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

export type SyncState =
  | 'idle'
  | 'scanning'
  | 'pulling'
  | 'pushing'
  | 'conflict'
  | 'offline'
  | 'error';

export interface SyncEntryConfig {
  /** 远端根前缀，实际对象键 = `${rootPrefix}${docId}/${rev}-${hash}.md` */
  rootPrefix: string;
  deviceId: string;
  deviceName: string;
  /** 自动同步间隔（毫秒），0 关闭 */
  autoSyncIntervalMs: number;
  /** 版本保留天数 */
  versionRetentionDays: number;
  /** 每篇文档最多保留版本数 */
  versionRetentionCount: number;
  /**
   * 当前仓库 id（1.1.5 新增）。
   *
   * 多仓库场景下，服务端需要它来做两件事：
   * 1. 把对象键拼到 `users/<user>/vaults/<vaultId>/` 下，实现仓库间隔离；
   * 2. 校验该仓库属于当前用户且未被停用。
   *
   * 自建 S3 直连模式不需要它（前缀已在 `rootPrefix` 里体现），因此可选。
   */
  vaultId?: string;
}

export interface SyncLogEntry {
  id: string;
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
}

export interface SyncConflict {
  docId: string;
  path: string;
  localRev: number;
  remoteRev: number;
  localHash: string;
  remoteHash: string;
  localMarkdown: string;
  remoteMarkdown: string;
  baseMarkdown: string | null;
  /** 三方合并结果，null 表示无法自动合并 */
  mergedMarkdown: string | null;
}

/* ------------------------------------------------------------------ */
/* 版本历史                                                            */
/* ------------------------------------------------------------------ */

export interface VersionRecord {
  id: string;
  docId: string;
  rev: number;
  hash: string;
  size: number;
  createdAt: number;
  /** 'save' | 'manual' | 'restore' | 'ai' | 'import' */
  origin: string;
  /** 本地缓存路径或远端对象键 */
  storageKey: string;
  /** 已上传到对象存储 */
  synced: boolean;
  label: string;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export interface ShortcutBinding {
  /** 命令 id，如 editor.h1 */
  command: string;
  /** 组合键，如 Ctrl+1、Ctrl+Shift+K */
  keys: string[];
}

export type EditorColorScheme = 'white' | 'gray' | 'black' | 'green' | 'lightblue' | 'custom';

/**
 * 正文与编辑器融合的主题预设。
 *
 * 产品约定（1.0.2）：正文配色不再是「编辑器设置里的一个独立下拉」，
 * 而是与整体外观（侧栏、工具栏、状态栏）成套切换的主题；
 * 因此这里描述的是「一整套主题」，而非单纯的正文底色。
 */
export interface ThemePreset {
  id: string;
  name: string;
  /** 界面整体明暗基调，用于决定是否叠加 dark 变量 */
  mode: 'light' | 'dark';
  /** 正文（纸张）背景 */
  contentBg: string;
  /** 正文文字 */
  contentFg: string;
  /** 侧栏 / 工具栏底色 */
  chromeBg: string;
  /** 边框与分隔线 */
  border: string;
  /** 强调色（链接、选中、按钮） */
  accent: string;
  /** 是否为内置主题（内置不可删除） */
  builtin?: boolean;
}

export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** 编辑器最大列宽（字符数），full 模式下忽略 */
  pageWidth: PageWidth;
  showLineNumbers: boolean;
  /**
   * 浏览器原生拼写检查（`.ProseMirror` 的 spellcheck 属性）。
   * 1.1.9 起在设置页「编辑器 → 拼写检查」可切换，实时生效。
   */
  spellcheck: boolean;
  /**
   * 打字机模式（光标行垂直居中）。
   *
   * **1.1.9 未实现**：全仓没有消费点，设置页也不暴露入口。
   * 保留字段**仅为云端设置的向后兼容** —— 老用户的 payload 里可能带着这个键，
   * 删掉会导致 `mergeSettings()` 的浅合并把它当未知字段处理、并在推回云端时丢失；
   * 更重要的是，若未来实现该功能，老数据可以直接复用。
   *
   * 产品决定：**不要**在 UI 上暴露它。一个改了没有任何效果的开关，
   * 比没有这个开关更糟（用户会反复尝试并认为产品坏了）。
   */
  typewriterMode: boolean;
  /** 正文编辑器配色方案 */
  editorColorScheme?: EditorColorScheme;
  /** 自定义正文背景色（editorColorScheme === 'custom' 时生效） */
  customEditorBg?: string;
  /** 自定义正文文字色（editorColorScheme === 'custom' 时生效） */
  customEditorFg?: string;
  /**
   * 正文缩放百分比（50-300）。
   * Ctrl + 滚轮每格 5%；状态栏可选择 50/75/100/125/150/200/300 或手动输入。
   */
  zoom?: number;
  /** 当前选中的主题预设 id（与正文配色融合，见 ThemePreset） */
  themePresetId?: string;
  /** 用户自定义主题预设列表（内置主题不在此列表内） */
  customThemes?: ThemePreset[];
}

export interface NamingSettings {
  mode: 'ai-after-save' | 'datetime-input';
  /** 方式二的模板，默认 YYMMDD日HHMM- */
  template: string;
  /** 方式二无人输入时的兜底名称 */
  fallback: string;
  /** 方式一完成后是否弹窗确认 */
  confirmBeforeRename: boolean;
  /** AI 自动命名的自定义提示词 */
  aiPrompt?: string;
  /** 新建文件时是否追加 AI 内容缩写（4-10 字）；AI 不可用时留空 */
  appendAiSummary?: boolean;
}

export interface AutosaveSettings {
  /** 是否启用自动保存 */
  enabled: boolean;
  /** 在有修改的情况下间隔多少分钟记录为一个历史版本（0 表示不按时间触发） */
  versionMinutes: number;
  /** 在有修改的情况下累积修改多少字符记录为一个历史版本（0 表示不按字数触发） */
  versionChars: number;
}

/**
 * 本地仓库落盘策略（桌面端）。
 *
 * 产品约定：PC 端**所有**仓库都必须有真实的本地文件夹路径，笔记以明文 `.md` 落盘；
 * 默认只保留最新版本，历史版本交给云端对象存储，避免本地 `.neomd/versions/` 无限膨胀。
 */
export interface LocalVaultSettings {
  /** 本地仓库根目录（绝对路径）。空字符串表示使用系统默认（文档/Neo MD） */
  root: string;
  /** 是否在本地保留历史版本；false（默认）时本地只存最新版本 */
  keepVersions: boolean;
}

export interface ShareStyleSettings {
  /** 分享页顶部展示的自定义标题/站点名称（为空则显示作者昵称） */
  brandTitle: string;
  /** 分享页副标题或签名 */
  brandSubtitle: string;
  /** 分享页主题色 */
  accentColor: string;
  /** 分享页背景风格 */
  paperStyle: 'white' | 'warm' | 'green' | 'dark';
  /** 是否隐藏底部产品标识 */
  hideProductBrand: boolean;
}

export type RibbonPosition = 'left' | 'right' | 'statusbar-left' | 'statusbar-right';

/* ------------------------------------------------------------------ */
/* AI 知识库（1.1.0）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 知识库切片颗粒度。
 *
 * 用户需要「多颗粒度的精细化设置」，因此按语义单位分级：
 * - `heading`：按标题切（H1-H6 每个标题一段），保留完整章节上下文，适合长文；
 * - `paragraph`：按段落切（空行分隔），最常用，检索精度与上下文兼顾；
 * - `sentence`：按句切（。！？；\n），最细，适合问答与定位；
 * - `block`：按固定字符数滑动窗口切（chunkSize + overlap），适合无结构长文；
 * - `doc`：整篇文档作为一个切片（粒度最粗），适合摘要类问答。
 */
export type KnowledgeGranularity = 'doc' | 'heading' | 'paragraph' | 'sentence' | 'block';

/** 知识库检索模式 */
export type KnowledgeSearchMode = 'keyword' | 'hybrid' | 'vector';

/** 知识库能力设置（用户可在界面上精细调整） */
export interface KnowledgeSettings {
  /** 是否启用知识库（关闭后检索与 API 全部返回空） */
  enabled: boolean;
  /** 切片颗粒度 */
  granularity: KnowledgeGranularity;
  /** block 粒度下的切片字符数（200-4000） */
  chunkSize: number;
  /** block 粒度下的重叠字符数（0-500），避免句子被腰斩 */
  chunkOverlap: number;
  /** 单次检索返回的片段数（1-30） */
  topK: number;
  /** 相关性阈值（0-1），低于此分数的片段被丢弃 */
  minScore: number;
  /** 检索模式：关键词 / 混合 / 向量 */
  searchMode: KnowledgeSearchMode;
  /** 是否在片段中保留 Markdown 原样（关闭则转纯文本） */
  keepMarkdown: boolean;
  /** 是否包含 frontmatter 元数据 */
  includeFrontmatter: boolean;
  /** 需要排除的目录前缀（如 `日记/`、`归档/`） */
  excludeFolders: string[];
  /** 需要排除的标签（如 `private`），命中则不进入知识库 */
  excludeTags: string[];
  /** 单文档最大纳入字符数，超出则截断（防止超大文件拖垮索引） */
  maxDocChars: number;
  /** 是否自动增量索引（文件变动后重建该文档的切片） */
  autoIndex: boolean;
  /** 注入 AI 上下文时最多带多少片段 */
  maxContextChunks: number;
}

/** 知识库切片 */
export interface KnowledgeChunk {
  /** 切片唯一 id：`<docId>#<序号>` */
  id: string;
  docId: string;
  /** 文档标题 */
  title: string;
  /** 文档仓库内路径 */
  path: string;
  /** 切片在原文中的字符区间 */
  start: number;
  end: number;
  /** 所属标题（若按 heading 切分或能定位） */
  heading?: string;
  /** 标题层级 1-6 */
  level?: number;
  /** 切片正文 */
  text: string;
  /** 该文档的标签 */
  tags: string[];
  /** 文档最后修改时间 */
  updatedAt: number;
}

/** 检索命中结果 */
export interface KnowledgeHit extends KnowledgeChunk {
  /** 相关性分数 0-1 */
  score: number;
  /** 命中的关键词（用于高亮） */
  matched: string[];
}

/* ------------------------------------------------------------------ */
/* Obsidian 导入（1.1.0）                                              */
/* ------------------------------------------------------------------ */

/**
 * Obsidian 仓库导入选项。
 *
 * 背景：Obsidian 的 Markdown 有多处与 CommonMark 不完全一致，
 * 直接导入会出现换行、嵌入、标注块显示异常，必须做格式转换。
 */
export interface ObsidianImportOptions {
  /** 导入到仓库的目标文件夹（空 = 仓库根目录） */
  targetFolder: string;
  /** 是否保留源文件的修改/创建时间（强烈建议开启） */
  keepTimestamps: boolean;
  /** 转换 Obsidian 专用语法为 Neo MD 可渲染的等价写法 */
  convertSyntax: boolean;
  /** 转换 `![[image.png]]` 这类嵌入资源为相对路径图片 */
  convertEmbeds: boolean;
  /** 把 `%%注释%%` 转为 HTML 注释（否则会被当成正文显示） */
  convertComments: boolean;
  /** 把 `> [!note]` 这类 callout 转为引用块 + 粗体标题 */
  convertCallouts: boolean;
  /** 把 `==高亮==` 转为 `<mark>` */
  convertHighlights: boolean;
  /** 把 Obsidian 的 `- [ ]` 任务列表保持为标准 GFM 任务列表 */
  normalizeTasks: boolean;
  /** 把硬换行（行尾空格 / 单个换行）规范为 CommonMark 两空格换行 */
  normalizeHardBreaks: boolean;
  /** 跳过 `.obsidian/`、`.trash/` 等配置目录（始终跳过，仅为显式说明） */
  skipConfigDirs: boolean;
  /** 遇到同名文件时的策略 */
  onConflict: 'rename' | 'overwrite' | 'skip';
}

/** 单个文件的导入结果 */
export interface ObsidianImportFileResult {
  /** 源文件在 Obsidian 仓库内的相对路径 */
  sourcePath: string;
  /** 导入后的仓库内路径 */
  targetPath: string;
  /** 字节数 */
  size: number;
  /** 源文件修改时间 */
  modifiedAt: number;
  /** 源文件创建时间（部分平台无此信息，等于 modifiedAt） */
  createdAt: number;
  /** 状态 */
  status: 'imported' | 'converted' | 'skipped' | 'conflict' | 'failed';
  /** 应用了哪些转换（用于报告） */
  conversions: string[];
  /** 失败原因 */
  error?: string;
}

/** 导入汇总报告 */
export interface ObsidianImportReport {
  /** 仓库名称 */
  vaultName: string;
  /** 总文件数 */
  total: number;
  imported: number;
  converted: number;
  skipped: number;
  failed: number;
  /** 跳过的配置目录/文件说明 */
  ignoredPaths: string[];
  /** 逐文件明细 */
  files: ObsidianImportFileResult[];
  /** 耗时（毫秒） */
  durationMs: number;
  /** 开始/结束时间 */
  startedAt: number;
  finishedAt: number;
}

/* ------------------------------------------------------------------ */
/* 思维导图 / 流程图（1.1.0）                                          */
/* ------------------------------------------------------------------ */

/** 图类型：思维导图 / 流程图 */
export type DiagramKind = 'mindmap' | 'flowchart';

/** 节点形状（对齐 ProcessOn 的常用图形集） */
export type DiagramNodeShape =
  | 'rect'
  | 'roundRect'
  | 'ellipse'
  | 'diamond'
  | 'parallelogram'
  | 'hexagon'
  | 'cylinder'
  | 'document'
  | 'circle'
  | 'text';

/** 连接线端点形状 */
export type DiagramArrow = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';

/** 连线样式 */
export type DiagramLineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * 图节点。
 *
 * 坐标系统一用「画布世界坐标」，缩放/平移只影响视图矩阵，
 * 因此导出、拖拽、对齐都以这里的 x/y/w/h 为准。
 */
export interface DiagramNode {
  id: string;
  shape: DiagramNodeShape;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 填充色（空则用主题默认） */
  fill?: string;
  /** 描边色 */
  stroke?: string;
  /** 文字色 */
  color?: string;
  /** 字号 */
  fontSize?: number;
  /** 字重 */
  bold?: boolean;
  /** 斜体 */
  italic?: boolean;
  /** 圆角半径（roundRect 使用） */
  radius?: number;
  /** 层级（思维导图用，0 为根） */
  level?: number;
  /** 折叠状态（思维导图） */
  collapsed?: boolean;
  /** 图标 emoji */
  icon?: string;
  /** 备注（不显示在节点里，仅悬停/导出时可用） */
  note?: string;
  /** 锁定，禁止拖动 */
  locked?: boolean;
}

/** 连线锚点：节点四边 + 中心 */
export type DiagramPort = 'top' | 'right' | 'bottom' | 'left' | 'center' | 'auto';

/** 图连线 */
export interface DiagramEdge {
  id: string;
  /** 起点节点 id；为空时用起点绝对坐标 */
  from?: string;
  to?: string;
  /** 起点/终点锚点 */
  fromPort?: DiagramPort;
  toPort?: DiagramPort;
  /** 无节点时的自由端点坐标 */
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
  /** 连线标签 */
  label?: string;
  /** 起点/终点箭头 */
  startArrow?: DiagramArrow;
  endArrow?: DiagramArrow;
  /** 线型 */
  lineStyle?: DiagramLineStyle;
  /** 线宽 */
  lineWidth?: number;
  /** 颜色 */
  stroke?: string;
  /** 折线拐点（正交连线用） */
  waypoints?: Array<{ x: number; y: number }>;
  /** 是否使用曲线 */
  curved?: boolean;
}

/** 画布背景网格样式 */
export type DiagramGrid = 'none' | 'dot' | 'line';

/** 图文档（保存为 .mind / .flow JSON） */
export interface DiagramDoc {
  /** 格式版本，便于后续迁移 */
  schema: number;
  kind: DiagramKind;
  /** 标题 */
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** 画布设置 */
  canvas: {
    /** 背景色 */
    background: string;
    grid: DiagramGrid;
    /** 网格大小 */
    gridSize: number;
    /** 是否显示网格 */
    showGrid: boolean;
    /** 是否吸附网格 */
    snapToGrid: boolean;
  };
  /** 视口（缩放与平移） */
  viewport?: { zoom: number; offsetX: number; offsetY: number };
  /** 思维导图布局方向 */
  mindmapLayout?: 'right' | 'left' | 'both' | 'down';
  /** 创建/更新时间 */
  createdAt: number;
  updatedAt: number;
}

/** 图编辑器默认设置 */
export interface DiagramSettings {
  /** 新建思维导图的默认布局方向 */
  mindmapLayout: 'right' | 'left' | 'both' | 'down';
  /** 新建图的默认网格 */
  grid: DiagramGrid;
  /** 是否默认吸附网格 */
  snapToGrid: boolean;
  /** 网格大小 */
  gridSize: number;
  /** 默认节点填充色 */
  nodeFill: string;
  /** 默认节点描边色 */
  nodeStroke: string;
  /** 默认连线色 */
  edgeStroke: string;
  /** 自动保存 */
  autoSave: boolean;
  /** 是否显示小地图 */
  showMinimap: boolean;
}
export type LeftPanelMode = 'files' | 'outline' | 'both' | 'search';
/** 右侧栏可显示的功能区块（1.0.2 起不再只有 AI 与文件操作） */
export type RightPanelSection =
  | 'ai'
  | 'file'
  | 'outline'
  | 'backlinks'
  | 'tags'
  | 'history'
  | 'stats'
  | 'calendar';

export interface LayoutSettings {
  /** 是否开启功能区 */
  ribbonEnabled: boolean;
  /** 功能区位置 */
  ribbonPosition: RibbonPosition;
  /** 功能区显示的按钮 id，按顺序排列 */
  ribbonItems: string[];
  /** 左侧面板内容 */
  leftPanelMode: LeftPanelMode;
  leftPanelOpen: boolean;
  leftPanelWidth: number;
  /** 右侧面板（可显示 AI、文件操作、大纲、反链、标签、历史、统计、日历等） */
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelSections: RightPanelSection[];
  /** 左侧「最近打开」分组 */
  showRecent: boolean;
  recentCount: number;
  /** 正文上方格式化工具栏 */
  editorToolbar: boolean;
  /** 正文工具栏显示的按钮 id 及顺序 */
  toolbarItems?: string[];
  /**
   * 「大纲 + 文件列表」模式下大纲区块的高度（px）。
   * 用户可拖动两者之间的分隔条调整，属于本地布局偏好。
   */
  outlineHeight?: number;
  /** 右侧栏文件操作卡片每排数量（2-8，自适应），未设置时按宽度自动计算 */
  rightCardsPerRow?: number;
}

/**
 * 服务端连接配置（仅桌面端生效）。
 *
 * 产品约定（1.0.2）：
 * - 默认连接官方服务端 `https://md.zhengl.vip`；
 * - 允许用户改为**自己部署的服务端**（自建 API 地址）；
 * - **应用商店（插件市场）始终使用官方统一服务**，不支持私有化部署。
 */
export interface ServerSettings {
  /** 服务端模式：official 官方 / custom 自建 */
  mode: 'official' | 'custom';
  /** 自建服务端根地址，如 https://neomd.example.com（不含 /api） */
  customBaseUrl: string;
  /** 数据私有化：开启后 PC 端编辑器完全不连服务器，只走 S3 同步 */
  privacyMode: boolean;
}

export interface Settings {
  version: number;
  appearance: AppearanceSettings;
  naming: NamingSettings;
  autosave?: AutosaveSettings;
  shareStyle?: ShareStyleSettings;
  /** 桌面端本地仓库落盘策略 */
  localVault?: LocalVaultSettings;
  /** 服务端连接与数据私有化策略（仅桌面端） */
  server?: ServerSettings;
  /** AI 知识库设置（1.1.0） */
  knowledge?: KnowledgeSettings;
  /** 思维导图/流程图默认设置（1.1.0） */
  diagram?: DiagramSettings;
  layout: LayoutSettings;
  shortcuts: ShortcutBinding[];
  enabledPlugins: Record<string, boolean>;
  storage: StorageConfig;
  ai: AIConfig;
  sync: SyncEntryConfig;
  /** 登录用户的设置云端版本，用于合并 */
  cloudVersion: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 账号与分享（服务端模型在客户端侧的精简投影）                          */
/* ------------------------------------------------------------------ */

export interface UserProfile {
  id: number;
  email: string;
  username: string;
  role: 'user' | 'admin';
  quotaBytes: number;
  createdAt: string;
}

export interface ShareInfo {
  token: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
  allowComment: boolean;
  viewCount: number;
}

export interface ShareComment {
  id: number;
  shareId: number;
  authorName: string;
  body: string;
  createdAt: string;
  status: 'visible' | 'hidden';
  annotation?: ShareAnnotation;
}

export interface ShareAnnotation {
  id: number;
  quote: string;
  /** 序列化后的选区定位信息 */
  selector: TextSelector;
  createdAt: string;
}

export interface TextSelector {
  startPath: string;
  endPath: string;
  startOffset: number;
  endOffset: number;
  /** 用于容错的文本片段 */
  prefix: string;
  suffix: string;
}
