export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  /** 侧边栏图标（内联 svg path） */
  icon: string;
  category: 'core' | 'navigation' | 'writing' | 'data' | 'visual' | 'collab';
  /** 默认是否启用 */
  defaultEnabled: boolean;
  /** 该插件注册的贡献点 */
  contributes: {
    panel?: boolean;
    commands?: string[];
    shortcuts?: string[];
    editorExtension?: boolean;
    settings?: boolean;
  };
  /** 开启后才会加载的异步模块 */
  chunk: string;
}

function icon(d: string): string {
  return d;
}

export const PLUGINS: PluginManifest[] = [
  {
    id: 'whiteboard',
    name: '白板',
    description: '在仓库内创建 .board 无限画布，支持手绘、图形、文本与图片。',
    icon: icon('M3 3h18v14H3z'),
    category: 'visual',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['whiteboard.create'], editorExtension: false },
    chunk: 'whiteboard',
  },
  {
    id: 'note-reorganize',
    name: '笔记重组',
    description: '批量移动、重命名笔记，并自动重写全库 Wikilink。',
    icon: icon('M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z'),
    category: 'data',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['reorganize.batch'] },
    chunk: 'note-reorganize',
  },
  {
    id: 'tag-list',
    name: '标签列表',
    description: '聚合全库 #标签 与 frontmatter tags，支持筛选与跳转。',
    icon: icon('M3 7h18v4H3z M3 15h12v4H3z'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { panel: true, commands: ['tags.panel'] },
    chunk: 'tag-list',
  },
  {
    id: 'outgoing-links',
    name: '出链',
    description: '列出当前文档指向的其他笔记与外部链接。',
    icon: icon('M10 14 21 3 M14 3h7v7'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'outgoing-links',
  },
  {
    id: 'outline',
    name: '大纲',
    description: '标题树与正文滚动同步，点击定位。',
    icon: icon('M4 6h10 M4 12h16 M4 18h7'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'outline',
  },
  {
    id: 'publish',
    name: '发布',
    description: '把文档发布为静态 HTML，生成可分享的公开链接。',
    icon: icon('M12 3v12 M7 8l5-5 5 5 M5 21h14'),
    category: 'collab',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['publish.current'] },
    chunk: 'publish',
  },
  {
    id: 'backlinks',
    name: '反向链接',
    description: '列出引用当前文档的笔记，并呈现未链接提及。',
    icon: icon('M14 10 3 21 M10 21H3v-7'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'backlinks',
  },
  {
    id: 'workspace',
    name: '工作区',
    description: '保存并快速切换多套布局（分栏、打开的页签、侧边栏状态）。',
    icon: icon('M3 5h18v14H3z M9 5v14'),
    category: 'core',
    defaultEnabled: true,
    contributes: { commands: ['workspace.save', 'workspace.restore'] },
    chunk: 'workspace',
  },
  {
    id: 'graph',
    name: '关系图谱',
    description: '力导向关系图，支持全局与局部视图、按标签着色。',
    icon: icon('M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M5 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'),
    category: 'visual',
    defaultEnabled: true,
    contributes: { panel: true, commands: ['graph.open'] },
    chunk: 'graph',
  },
  {
    id: 'slides',
    name: '幻灯片',
    description: '按 --- 分页，把笔记直接演示为幻灯片。',
    icon: icon('M3 4h18v11H3z M8 20h8 M12 15v5'),
    category: 'visual',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['slides.present'] },
    chunk: 'slides',
  },
  {
    id: 'footnote-view',
    name: '脚注视图',
    description: '收集全文脚注，支持跳转与内联编辑。',
    icon: icon('M4 5h16 M4 12h10 M4 19h16'),
    category: 'writing',
    defaultEnabled: false,
    contributes: { panel: true },
    chunk: 'footnote-view',
  },
  {
    id: 'quick-switcher',
    name: '快速切换',
    description: 'Ctrl+O 模糊跳转到任意笔记。',
    icon: icon('M4 6h16 M4 12h16 M4 18h10'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { commands: ['quick.open'], shortcuts: ['Ctrl+O'] },
    chunk: 'quick-switcher',
  },
  {
    id: 'recorder',
    name: '录音机',
    description: '录制语音并上传到对象存储，自动在笔记中插入链接。',
    icon: icon('M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 12a7 7 0 0 0 14 0 M12 19v3'),
    category: 'writing',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['recorder.toggle'] },
    chunk: 'recorder',
  },
  {
    id: 'random-note',
    name: '漫游笔记',
    description: '随机打开一篇笔记，帮助重新发现旧内容。',
    icon: icon('M4 4h6v6H4z M14 14h6v6h-6z M10 7h4v10h-4'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { commands: ['random.open'] },
    chunk: 'random-note',
  },
  {
    id: 'daily-notes',
    name: '日记',
    description: '按模板创建每日笔记，提供日历视图。',
    icon: icon('M3 5h18v16H3z M8 3v4 M16 3v4 M3 10h18'),
    category: 'writing',
    defaultEnabled: true,
    contributes: { panel: true, commands: ['daily.open', 'daily.today'] },
    chunk: 'daily-notes',
  },
  {
    id: 'bookmarks',
    name: '书签',
    description: '收藏常用笔记与搜索结果，分组管理。',
    icon: icon('M6 3h12v18l-6-4-6 4z'),
    category: 'navigation',
    defaultEnabled: true,
    contributes: { panel: true, commands: ['bookmark.toggle'] },
    chunk: 'bookmarks',
  },
  {
    id: 'properties',
    name: '属性列表',
    description: '以表格形式查看并批量编辑全库 frontmatter 属性。',
    icon: icon('M4 5h16v4H4z M4 11h16v4H4z M4 17h16v3H4z'),
    category: 'data',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'properties',
  },
  {
    id: 'database',
    name: '数据库',
    description: '把 frontmatter 属性聚合为表格 / 看板视图，保存为 .base 文件。',
    icon: icon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6'),
    category: 'data',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['database.create'] },
    chunk: 'database',
  },
  {
    id: 'web-browser',
    name: '网页浏览器',
    description: '内嵌浏览器打开链接，可把正文提取为 Markdown。',
    icon: icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3.5 3 14 0 18'),
    category: 'visual',
    defaultEnabled: false,
    contributes: { panel: true, commands: ['browser.open'] },
    chunk: 'web-browser',
  },
  {
    id: 'file-recovery',
    name: '文件恢复',
    description: '从快照与版本历史恢复误删或损坏的文件。',
    icon: icon('M4 12a8 8 0 1 0 3-6.2 M4 4v5h5'),
    category: 'data',
    defaultEnabled: true,
    contributes: { panel: true, commands: ['recovery.open'] },
    chunk: 'file-recovery',
  },
  {
    id: 'file-list',
    name: '文件列表',
    description: '仓库文件树，支持虚拟滚动、拖拽与右键菜单。',
    icon: icon('M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
    category: 'core',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'file-list',
  },
  {
    id: 'slash-commands',
    name: '斜杠命令',
    description: '输入 / 唤出插入菜单，快速插入标题、表格、代码块等。',
    icon: icon('M16 3 8 21'),
    category: 'writing',
    defaultEnabled: true,
    /**
     * 1.4.0：补上 `commands` 贡献点。
     *
     * 原来这里只有 `editorExtension: true`，而宿主 `WysiwygEditor.vue` 从未按
     * manifest 注册过任何编辑器扩展 —— 于是「斜杠命令」在 1.3.1 里没有任何可点
     * 入口，只是一条清单项（插件中心能开能关，但开关本身不起作用）。
     *
     * 现在改为「命令入口 + 编辑器扩展」双贡献点：命令 `slash.insertMenu` 已接进
     * `builtin-plugin-runtime.ts` 的派发表，命令面板与功能区都能唤出插入菜单；
     * 行内键入 `/` 就地弹菜单仍需编辑器扩展层，未在 1.4.0 落地，已在验收报告中
     * 如实标注为「部分可用」。
     */
    contributes: { editorExtension: true, commands: ['slash.insertMenu'] },
    chunk: 'slash-commands',
  },
  {
    id: 'page-preview',
    name: '页面预览',
    description: '预览当前文档 Wikilink 目标笔记的首段内容。',
    icon: icon('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'),
    category: 'navigation',
    defaultEnabled: true,
    /**
     * 1.4.0：补上 `panel: true`。
     *
     * 原来只有 `editorExtension: true`，而宿主从未按 manifest 注册过编辑器扩展 ——
     * 这款插件在 1.3.1 里既没有面板也没有入口，完全是清单项。
     * 现在有了真实的「页面预览」面板（列出当前文档所有 Wikilink 目标 + 首段摘要，
     * 并标出目标是否存在于仓库），因此清单必须如实声明 `panel: true`。
     *
     * 正文里悬停链接直接浮出的就地预览仍依赖编辑器扩展层，未在 1.4.0 落地，
     * 已在验收报告中标注为「部分可用」。
     */
    contributes: { panel: true, editorExtension: true },
    chunk: 'page-preview',
  },
  {
    id: 'word-count',
    name: '字数统计',
    description: '实时统计字数、词数、字符数与预计阅读时长。',
    icon: icon('M4 7V5h16v2 M12 5v14 M9 19h6'),
    category: 'writing',
    defaultEnabled: true,
    contributes: { panel: true },
    chunk: 'word-count',
  },
  /**
   * 流程图 / 思维导图（1.1.7 补注册）。
   *
   * 这两个编辑器 1.1.0 就已交付（`.flow` / `.mind` 文件由专用编辑器打开），
   * 但当时只加了功能区入口，**从未注册进插件清单** —— 于是用户在「插件中心」里
   * 找不到它们，也无法启停，主观感受就是「这两个插件无法使用」。
   *
   * 此处补上两条定义使其可被插件中心识别与管理。
   * 名称严格只用「流程图」「思维导图」，**不带任何括号备注**（用户明确要求）。
   * `defaultEnabled: true` 与既有行为一致（入口本来就一直可用），
   * 避免升级后用户突然找不到入口。
   */
  {
    id: 'diagram-flowchart',
    name: '流程图',
    description: '新建 .flow 图文档，从左侧图形库拖拽作图，支持连线、对齐与导出。',
    icon: icon('M3 4h7v6H3z M14 4h7v4h-7z M14 12h7v8h-7z M3 14h7v6H3z'),
    category: 'visual',
    defaultEnabled: true,
    contributes: { panel: false, commands: ['diagram.createFlowchart'] },
    chunk: 'diagram',
  },
  {
    id: 'diagram-mindmap',
    name: '思维导图',
    description: '新建 .mind 思维导图，支持四种布局方向、主题配色与大纲互转。',
    icon: icon('M4 12h5 M9 12V6h6 M9 12v6h6 M15 6h5 M15 18h5'),
    category: 'visual',
    defaultEnabled: true,
    contributes: { panel: false, commands: ['diagram.createMindmap'] },
    chunk: 'diagram',
  },
];

export const PLUGIN_IDS = PLUGINS.map((p) => p.id);

export function getPlugin(id: string): PluginManifest | undefined {
  return PLUGINS.find((p) => p.id === id);
}
