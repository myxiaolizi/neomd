/**
 * 内置插件运行时（1.4.0）。
 *
 * ## 这个文件存在的理由
 *
 * 1.3.1 的问题：`packages/shared/src/plugins.ts` 里有 26 款内置插件的 manifest，
 * 但宿主侧「谁能真的执行」是散的：
 * - 面板要 `PluginPanel.vue` 有 `v-else-if` 分支 —— 而 `PluginPanel.vue` **从未被
 *   任何文件 import**（死代码），于是 5 款只声明了 `panel:true` 的插件根本无处可渲染；
 * - 命令要 `EditorPage.vue` 的 dispatcher 有 case —— 26 款共声明 19 个命令，
 *   旧 dispatcher 只命中 2 个（`random.open` / `daily.today`）；
 * - `onPanelAction` 的 `default` 分支只 `notify('已触发插件：xxx')`，**看起来成功了
 *   其实什么都没做**。
 *
 * ## 本模块的定位
 *
 * **单一事实源**：把「每款插件到底有哪条真实路径（面板 / 命令 / 编辑器扩展）
 * + 当前可用状态（完整 / 部分 / 暂不可用）」集中声明，并实现所有**文档变换类**
 * 命令的纯逻辑（可在 Node 下直接测）。
 *
 * 两个消费者共用同一份代码：
 * 1. `apps/web/src/views/EditorPage.vue` —— 功能区点击 / 命令面板执行；
 * 2. `tools/re14-builtin-plugins.mjs` —— 逐款验证脚本。
 *
 * 这样脚本测的是**真品**而不是复刻品；否则「26/26 可用」的结论没有意义。
 *
 * 本文件**不 import 任何内部模块**（无 Vue、无 @neomd/core），因此 Node 可直接加载。
 */

/* ------------------------------- 类型 ------------------------------- */

/** 一款内置插件当前的真实可用状态 */
export type BuiltinStatus =
  /** 完整可用：有真实入口且点击能生效 */
  | 'full'
  /** 部分可用：核心能力可用，但文档里写明了限制 */
  | 'partial'
  /** 暂不可用：入口会被禁用，不给用户「点了没反应」的按钮 */
  | 'unavailable';

/** 该插件暴露给宿主的能力类别 */
export type BuiltinKind = 'panel' | 'command' | 'extension';

export interface BuiltinCapability {
  /** 对应 `packages/shared/src/plugins.ts` 里的 manifest id */
  id: string;
  status: BuiltinStatus;
  /** 真实存在的入口类别（可多选） */
  kinds: BuiltinKind[];
  /** 若含面板：PluginPanel.vue 必须存在的面板 id */
  panel?: string;
  /**
   * 若含命令：`packages/shared/src/plugins.ts` 的 manifest 里声明的命令 id。
   * 这些 id 必须全部能被 `executeBuiltinCommand()` 派发。
   */
  commands: string[];
  /** 部分可用 / 暂不可用的具体限制（会原样展示给用户，也会进验收报告） */
  limitation?: string;
  /** 面板标题（PluginPanel 的 PANEL_META 用它，避免两处各写一份中文名） */
  panelTitle?: string;
  /** 面板图标（NmIcon 名称） */
  panelIcon?: string;
  /** 短说明，用于功能区按钮 title */
  ribbonTitle?: string;
}

/* --------------------------- 宿主上下文契约 --------------------------- */

/**
 * 内置插件执行时能用的宿主能力。
 *
 * 只放**动作**，不放状态：纯文档变换逻辑（字数、脚注、属性聚合……）都在本模块
 * 内实现，宿主只需提供「读写当前文档」与「打开某个界面」两类回调。这样脚本
 * 可以用 spy 实现它，从而验证「执行后确实调用了某个动作 / 文档真的变了」。
 */
export interface BuiltinHostContext {
  /* 文档 */
  getMarkdown(): string;
  setMarkdown(next: string): void;
  getTitle(): string;
  /** 当前文档 id（书签等按文档存储的功能需要） */
  getDocId?(): string;
  /* 通知 */
  notify(message: string, type?: 'info' | 'success' | 'error'): void;
  /* 界面动作 */
  /** 打开插件面板（PluginPanel 的 panel id） */
  openPanel(panel: string): void;
  /** 打开左侧栏并切到指定模式 */
  openLeftPanel(mode: 'files' | 'outline' | 'both' | 'search'): void;
  /** 在左侧栏发起搜索（用于标签列表） */
  searchInLeft(query: string): void;
  /** 打开/创建某天日记 */
  openDaily(date?: string): void;
  /** 打开随机笔记 */
  openRandom(): void;
  /** 打开版本历史弹窗 */
  openHistory(): void;
  /** 打开分享/发布弹窗 */
  openShare(): void;
  /** 打开命令面板 */
  openPalette(): void;
  /** 新建图表文档（.flow / .mind） */
  createDiagram(kind: 'flowchart' | 'mindmap'): void;
  /** 打开插件中心（插件商店） */
  openPluginCenter(): void;
  /** 保存 / 恢复工作区布局（workspace 插件用） */
  saveWorkspace(name: string): void;
  restoreWorkspace(): boolean;
  /** 读取/写入本机小型存储（书签等） */
  readStore(key: string): string | null;
  writeStore(key: string, value: string): void;
}

/* --------------------------- 能力清单（26 款） --------------------------- */

/**
 * 26 款内置插件的真实能力表。
 *
 * 顺序与 `plugins.ts` 的 `PLUGINS` 一致，便于人工比对。
 * `status` 是**经过宿主核对**的结论，不是「manifest 里写了就算有」。
 */
export const BUILTIN_PLUGIN_CAPABILITY: BuiltinCapability[] = [
  {
    id: 'whiteboard',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'whiteboard',
    panelTitle: '白板',
    panelIcon: 'layout',
    commands: ['whiteboard.create'],
    ribbonTitle: '白板',
  },
  {
    id: 'note-reorganize',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'reorganize',
    panelTitle: '笔记重组',
    panelIcon: 'layers',
    commands: ['reorganize.batch'],
    ribbonTitle: '笔记重组',
  },
  {
    id: 'tag-list',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'tag-list',
    panelTitle: '标签列表',
    panelIcon: 'tag',
    commands: ['tags.panel'],
    ribbonTitle: '标签列表',
  },
  {
    id: 'outgoing-links',
    status: 'full',
    kinds: ['panel'],
    panel: 'outgoing-links',
    panelTitle: '出链',
    panelIcon: 'link',
    commands: [],
    ribbonTitle: '出链',
  },
  {
    id: 'outline',
    status: 'full',
    kinds: ['panel'],
    panel: 'outline',
    panelTitle: '大纲',
    panelIcon: 'outline',
    commands: [],
    ribbonTitle: '大纲',
  },
  {
    id: 'publish',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'publish',
    panelTitle: '发布',
    panelIcon: 'upload',
    commands: ['publish.current'],
    ribbonTitle: '发布当前文档',
  },
  {
    id: 'backlinks',
    status: 'full',
    kinds: ['panel'],
    panel: 'backlinks',
    panelTitle: '反向链接',
    panelIcon: 'link',
    commands: [],
    ribbonTitle: '反向链接',
  },
  {
    id: 'workspace',
    status: 'full',
    kinds: ['command'],
    commands: ['workspace.save', 'workspace.restore'],
    ribbonTitle: '保存/恢复工作区',
  },
  {
    id: 'graph',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'graph',
    panelTitle: '关系图谱',
    panelIcon: 'graph',
    commands: ['graph.open'],
    ribbonTitle: '关系图谱',
  },
  {
    id: 'slides',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'slides',
    panelTitle: '幻灯片',
    panelIcon: 'slides',
    commands: ['slides.present'],
    ribbonTitle: '幻灯片演示',
  },
  {
    id: 'footnote-view',
    status: 'full',
    kinds: ['panel'],
    panel: 'footnote-view',
    panelTitle: '脚注视图',
    panelIcon: 'footnote',
    commands: [],
    ribbonTitle: '脚注视图',
  },
  {
    id: 'quick-switcher',
    status: 'full',
    kinds: ['command'],
    commands: ['quick.open'],
    ribbonTitle: '快速切换',
  },
  {
    id: 'recorder',
    status: 'partial',
    kinds: ['panel', 'command'],
    panel: 'recorder',
    panelTitle: '录音机',
    panelIcon: 'mic',
    commands: ['recorder.toggle'],
    ribbonTitle: '语音录音机',
    limitation:
      '录音与本地回放可用；上传到对象存储需要先在「设置 → 存储」配置 S3 并可访问网络，未配置时只能本地试听。浏览器需授予麦克风权限。',
  },
  {
    id: 'random-note',
    status: 'full',
    kinds: ['command'],
    commands: ['random.open'],
    ribbonTitle: '漫游笔记',
  },
  {
    id: 'daily-notes',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'daily',
    panelTitle: '日记',
    panelIcon: 'calendar',
    commands: ['daily.open', 'daily.today'],
    ribbonTitle: '今日日记',
  },
  {
    id: 'bookmarks',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'bookmarks',
    panelTitle: '书签',
    panelIcon: 'bookmark',
    commands: ['bookmark.toggle'],
    ribbonTitle: '书签',
  },
  {
    id: 'properties',
    status: 'full',
    kinds: ['panel'],
    panel: 'properties',
    panelTitle: '属性',
    panelIcon: 'table',
    commands: [],
    ribbonTitle: '属性列表',
  },
  {
    id: 'database',
    status: 'partial',
    kinds: ['panel', 'command'],
    panel: 'database',
    panelTitle: '数据库',
    panelIcon: 'database',
    commands: ['database.create'],
    ribbonTitle: '数据库视图',
    limitation:
      '可按 frontmatter 属性聚合成表格视图并跳转；把视图保存为 `.base` 文件的功能尚未实现（宿主没有 .base 文件的读写能力）。',
  },
  {
    id: 'web-browser',
    status: 'partial',
    kinds: ['panel', 'command'],
    panel: 'browser',
    panelTitle: '网页浏览器',
    panelIcon: 'globe',
    commands: ['browser.open'],
    ribbonTitle: '内嵌浏览器',
    limitation:
      '内嵌浏览与「提取正文为 Markdown」可用；但目标网站若设置了 X-Frame-Options / CSP frame-ancestors 会拒绝内嵌，这是站点侧限制，宿主无法绕过。',
  },
  {
    id: 'file-recovery',
    status: 'full',
    kinds: ['panel', 'command'],
    panel: 'recovery',
    panelTitle: '文件恢复',
    panelIcon: 'restore',
    commands: ['recovery.open'],
    ribbonTitle: '文件恢复',
  },
  {
    id: 'file-list',
    status: 'full',
    kinds: ['panel'],
    panel: 'file-list',
    panelTitle: '文件列表',
    panelIcon: 'folder',
    commands: [],
    ribbonTitle: '文件列表',
  },
  {
    id: 'slash-commands',
    status: 'partial',
    kinds: ['extension', 'command'],
    commands: ['slash.insertMenu'],
    ribbonTitle: '插入菜单',
    limitation:
      '命令面板 / 功能区可唤出「插入菜单」并插入标题、表格、代码块等；在正文里直接键入 `/` 就地弹出菜单的编辑器内触发尚未接入（需要在编辑器扩展层做，属后续版本）。',
  },
  {
    id: 'page-preview',
    status: 'partial',
    kinds: ['panel', 'extension'],
    panel: 'page-preview',
    panelTitle: '页面预览',
    panelIcon: 'eye',
    commands: [],
    ribbonTitle: '页面预览',
    limitation:
      '面板内可预览当前文档全部 Wikilink 目标的首段内容；正文里悬停链接直接浮出的就地预览尚未接入编辑器扩展层。',
  },
  {
    id: 'word-count',
    status: 'full',
    kinds: ['panel'],
    panel: 'word-count',
    panelTitle: '字数统计',
    panelIcon: 'chart',
    commands: [],
    ribbonTitle: '字数统计',
  },
  {
    id: 'diagram-flowchart',
    status: 'full',
    kinds: ['command'],
    commands: ['diagram.createFlowchart'],
    ribbonTitle: '流程图',
  },
  {
    id: 'diagram-mindmap',
    status: 'full',
    kinds: ['command'],
    commands: ['diagram.createMindmap'],
    ribbonTitle: '思维导图',
  },
];

/** 按 id 取能力条目 */
export function getBuiltinCapability(id: string): BuiltinCapability | undefined {
  return BUILTIN_PLUGIN_CAPABILITY.find((c) => c.id === id);
}

/** 全部可派发的内置命令 id（供测试与文档核对） */
export function allBuiltinCommandIds(): string[] {
  return BUILTIN_PLUGIN_CAPABILITY.flatMap((c) => c.commands);
}

/** 状态不是 unavailable 的插件（功能区可渲染） */
export function isBuiltinUsable(id: string): boolean {
  const cap = getBuiltinCapability(id);
  if (!cap) return false;
  return cap.status !== 'unavailable';
}

/* --------------------------- 纯文档工具（可单测） --------------------------- */

/** 字数统计结果 */
export interface WordStats {
  chars: number;
  /** 不含空白的字符数 */
  charsNoSpace: number;
  words: number;
  /** 中日韩字符数（中文按字计，不按词计） */
  cjk: number;
  lines: number;
  /** 非空行数 */
  textLines: number;
  /** 预计阅读时长（分钟） */
  readingMinutes: number;
}

/**
 * 统计 Markdown 正文。
 *
 * 口径（与 `word-count` 插件面板展示一致）：
 * - `chars`：含空白与标点的全部字符数；
 * - `words`：英文按空白切分 + 中文按字计（这是中文写作场景最直观的口径）；
 * - `readingMinutes`：中文 350 字/分钟、英文 200 词/分钟，取两者耗时之和，向上取整到 0.1 分钟。
 */
export function computeWordStats(source: string): WordStats {
  const text = String(source ?? '');
  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s/g, '')].length;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const textLines = text ? text.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  const cjkMatches = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const latinWords = text
    .replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g, ' ')
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w && /[\p{L}\p{N}]/u.test(w));
  const words = latinWords.length + cjk;
  const readingMinutes = Math.max(0, Math.round((cjk / 350 + latinWords.length / 200) * 10) / 10);
  return { chars, charsNoSpace, words, cjk, lines, textLines, readingMinutes };
}

/** 一条脚注 */
export interface FootnoteItem {
  /** 引用标记，如 `[^1]` 里的 `1` */
  label: string;
  /** 定义处的正文 */
  text: string;
  /** 引用出现次数 */
  refCount: number;
  /** 定义所在行号（1 起） */
  line: number;
}

/**
 * 收集全文脚注：同时支持 `[^label]: text` 定义式与 `[^label]` 引用式。
 *
 * 只有引用、没有定义的（悬空引用）也会列出，`text` 为空串 —— 这类恰恰是用户
 * 最需要看到的（脚注视图的意义之一就是发现这种问题）。
 */
export function extractFootnotes(source: string): FootnoteItem[] {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const defs = new Map<string, { text: string; line: number }>();
  const refs = new Map<string, number>();
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    // 定义：允许 4 空格内的缩进
    const def = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
    if (def) {
      const label = def[1]!;
      if (!defs.has(label)) defs.set(label, { text: def[2] ?? '', line: i + 1 });
      continue;
    }
    // 引用：排除定义行本身
    for (const m of line.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      const label = m[1]!;
      refs.set(label, (refs.get(label) ?? 0) + 1);
    }
  }

  const out: FootnoteItem[] = [];
  for (const [label, def] of defs) {
    out.push({ label, text: def.text, refCount: refs.get(label) ?? 0, line: def.line });
  }
  // 悬空引用（只有引用没有定义）
  for (const [label, count] of refs) {
    if (!defs.has(label)) out.push({ label, text: '', refCount: count, line: 0 });
  }
  return out;
}

/** 一条 frontmatter 属性聚合 */
export interface PropertyItem {
  key: string;
  /** 值的类型描述：string / number / list / bool */
  kind: string;
  /** 有多少篇文档包含这个属性（属性列表面板展示用） */
  docs: number;
  /** 值样例（最多 8 个） */
  values: string[];
  /** 是否列表型 */
  list: boolean;
}

/**
 * 解析极简 YAML frontmatter（只处理顶层键值 + 列表，够属性表用）。
 *
 * 1.4.0 修：键名必须支持**非 ASCII**。
 * 1.3.1 的属性表用 `[A-Za-z0-9_-]+` 匹配键名，于是 `状态: 进行中`、`优先级: 高`
 * 这类**中文属性名全部解析不出来** —— 属性列表面板对这些用户而言永远是空的，
 * 看起来就像「插件不工作」。这是把「插件不可用」误判成「宿主没实现」的典型来源。
 * 现在用 Unicode 属性类别 `\p{L}\p{N}`，中文 / 日文 / 带重音的键名都能识别。
 */
export function parseFrontmatterEntries(source: string): Record<string, string | string[]> {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string | string[]> = {};
  const body = m[1] ?? '';
  let currentListKey = '';
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    // 列表项：`  - value`
    const listItem = /^\s+-\s*(.*)$/.exec(rawLine);
    if (listItem && currentListKey) {
      const prev = out[currentListKey];
      const arr = Array.isArray(prev) ? prev : [];
      arr.push(stripYamlQuotes(listItem[1] ?? ''));
      out[currentListKey] = arr;
      continue;
    }
    // 键名允许 Unicode 字母 / 数字 / 下划线 / 点 / 连字符 / 美元符
    const kv = /^([\p{L}\p{N}_.$-]+)\s*:\s*(.*)$/u.exec(rawLine);
    if (!kv) continue;
    const key = kv[1]!;
    const value = (kv[2] ?? '').trim();
    if (!value) {
      currentListKey = key;
      out[key] = [];
      continue;
    }
    currentListKey = '';
    // 行内列表 `[a, b]`
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripYamlQuotes(s.trim()))
        .filter(Boolean);
    } else {
      out[key] = stripYamlQuotes(value);
    }
  }
  return out;
}

function stripYamlQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 把多篇文档的 frontmatter 属性聚合成属性表 */
export function aggregateProperties(docs: Array<{ title: string; content: string }>): PropertyItem[] {
  const map = new Map<string, PropertyItem>();
  for (const doc of docs) {
    const fm = parseFrontmatterEntries(doc.content);
    for (const [key, value] of Object.entries(fm)) {
      if (key === 'title') continue;
      const item = map.get(key) ?? { key, kind: 'string', docs: 0, values: [], list: false };
      item.docs += 1;
      if (Array.isArray(value)) {
        item.list = true;
        item.kind = 'list';
        for (const v of value) if (v && !item.values.includes(v) && item.values.length < 8) item.values.push(v);
      } else {
        if (value === 'true' || value === 'false') item.kind = item.kind === 'list' ? 'list' : 'bool';
        else if (value !== '' && !Number.isNaN(Number(value))) item.kind = item.kind === 'list' ? 'list' : 'number';
        if (value && !item.values.includes(value) && item.values.length < 8) item.values.push(value);
      }
      map.set(key, item);
    }
  }
  return [...map.values()];
}

/** 一条出链 */
export interface OutgoingLink {
  /** 原始目标 */
  target: string;
  /** 别名（若有） */
  alias: string;
  kind: 'wikilink' | 'embed' | 'markdown';
}

/**
 * 解析当前文档的出链（`[[目标]]` / `![[嵌入]]` / `[文字](url)`）。
 *
 * 只做「列出」这件事；是否能在仓库里找到目标由宿主判断。
 */
export function extractOutgoingLinks(source: string): OutgoingLink[] {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const out: OutgoingLink[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    // 去掉行内代码，避免把代码里的 [[x]] 当成链接
    const cleaned = line.replace(/`[^`]*`/g, '');
    for (const m of cleaned.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
      const target = (m[2] ?? '').trim();
      if (!target) continue;
      const key = `${m[1] ? 'embed' : 'wiki'}:${target}:${m[3] ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target, alias: (m[3] ?? '').trim(), kind: m[1] ? 'embed' : 'wikilink' });
    }
    for (const m of cleaned.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = (m[2] ?? '').trim();
      if (!target || target.startsWith('neomd://wiki/')) continue;
      const key = `md:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target, alias: (m[1] ?? '').trim(), kind: 'markdown' });
    }
  }
  return out;
}

/** 一条书签 */
export interface BookmarkItem {
  id: string;
  docId: string;
  title: string;
  addedAt: number;
}

/** 书签存储 key */
export const BOOKMARKS_STORE_KEY = 'neomd.bookmarks.v1';

/** 从 JSON 文本解析书签列表（容错：脏数据丢弃） */
export function parseBookmarks(json: string | null): BookmarkItem[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (!x || typeof x !== 'object') return null;
        const o = x as Record<string, unknown>;
        const docId = typeof o.docId === 'string' ? o.docId : '';
        if (!docId) return null;
        return {
          id: typeof o.id === 'string' && o.id ? o.id : docId,
          docId,
          title: typeof o.title === 'string' ? o.title : docId,
          addedAt: typeof o.addedAt === 'number' ? o.addedAt : 0,
        } satisfies BookmarkItem;
      })
      .filter((x): x is BookmarkItem => Boolean(x));
  } catch {
    return [];
  }
}

/** 切换某篇文档的书签状态；返回新列表与「切换后是否已收藏」 */
export function toggleBookmark(
  list: BookmarkItem[],
  doc: { docId: string; title: string },
  now = Date.now(),
): { list: BookmarkItem[]; bookmarked: boolean } {
  const exists = list.some((b) => b.docId === doc.docId);
  if (exists) {
    return { list: list.filter((b) => b.docId !== doc.docId), bookmarked: false };
  }
  return { list: [...list, { id: doc.docId, docId: doc.docId, title: doc.title, addedAt: now }], bookmarked: true };
}

/* ---------------------------- 命令派发 ---------------------------- */

/** 命令执行结果（宿主据此决定提示文案，不再「假装成功」） */
export interface BuiltinCommandResult {
  /** 是否成功找到并执行了该命令 */
  ok: boolean;
  /** 归属插件 id */
  pluginId: string;
  /** 给用户看的消息 */
  message: string;
  /** 是否改变了当前文档内容 */
  changedDoc?: boolean;
}

/** 命令 -> 归属插件（由 BUILTIN_PLUGIN_CAPABILITY 反推，避免两处不同步） */
export function commandOwner(commandId: string): string | null {
  const hit = BUILTIN_PLUGIN_CAPABILITY.find((c) => c.commands.includes(commandId));
  return hit?.id ?? null;
}

/**
 * 执行一个内置插件命令。
 *
 * **这是功能区 / 命令面板点击插件后的唯一落点**。旧实现的 `default` 分支只弹
 * 「已触发插件：xxx」但不做任何事（欺骗性缺陷），现在改成：找不到命令就
 * 明确返回 `ok:false` 并给出「该功能暂不可用」的可读消息。
 */
export function executeBuiltinCommand(commandId: string, ctx: BuiltinHostContext): BuiltinCommandResult {
  const owner = commandOwner(commandId);
  const pluginId = owner ?? commandId;
  const panelOf = (id: string): string | undefined => getBuiltinCapability(id)?.panel;

  const openOwnPanel = (fallbackPanel?: string): BuiltinCommandResult => {
    const panel = panelOf(pluginId) ?? fallbackPanel;
    if (!panel) {
      return { ok: false, pluginId, message: `「${pluginId}」没有对应的面板，暂时无法打开` };
    }
    ctx.openPanel(panel);
    return { ok: true, pluginId, message: `已打开「${getBuiltinCapability(pluginId)?.panelTitle ?? panel}」面板` };
  };

  switch (commandId) {
    /* ---- 面板类 ---- */
    case 'whiteboard.create':
    case 'reorganize.batch':
    case 'graph.open':
    case 'slides.present':
    case 'recorder.toggle':
    case 'recovery.open':
    case 'browser.open':
    case 'database.create':
      return openOwnPanel();

    case 'tags.panel': {
      ctx.openLeftPanel('search');
      ctx.searchInLeft('#');
      return { ok: true, pluginId: 'tag-list', message: '已在左侧栏按「#」搜索标签' };
    }

    case 'publish.current': {
      ctx.openShare();
      return { ok: true, pluginId: 'publish', message: '已打开发布面板' };
    }

    /* ---- 导航类 ---- */
    case 'daily.open': {
      ctx.openDaily();
      return { ok: true, pluginId: 'daily-notes', message: '已打开今日日记' };
    }
    case 'daily.today': {
      ctx.openDaily();
      return { ok: true, pluginId: 'daily-notes', message: '已打开今日日记' };
    }
    case 'random.open': {
      ctx.openRandom();
      return { ok: true, pluginId: 'random-note', message: '已打开一篇随机笔记' };
    }
    case 'quick.open': {
      ctx.openPalette();
      return { ok: true, pluginId: 'quick-switcher', message: '已打开快速切换（命令面板）' };
    }

    /* ---- 工作区 ---- */
    case 'workspace.save': {
      ctx.saveWorkspace('默认工作区');
      return { ok: true, pluginId: 'workspace', message: '已保存当前工作区布局' };
    }
    case 'workspace.restore': {
      const restored = ctx.restoreWorkspace();
      return {
        ok: restored,
        pluginId: 'workspace',
        message: restored ? '已恢复保存的工作区布局' : '没有已保存的工作区布局，请先保存一次',
      };
    }

    /* ---- 图表 ---- */
    case 'diagram.createFlowchart': {
      ctx.createDiagram('flowchart');
      return { ok: true, pluginId: 'diagram-flowchart', message: '已新建流程图文档' };
    }
    case 'diagram.createMindmap': {
      ctx.createDiagram('mindmap');
      return { ok: true, pluginId: 'diagram-mindmap', message: '已新建思维导图文档' };
    }

    /* ---- 编辑器扩展类（命令入口） ---- */
    case 'slash.insertMenu': {
      // 插入菜单：以「插入标题」的最小可用形式落地，避免只是一个死按钮
      const md = ctx.getMarkdown();
      const next = md.endsWith('\n') || !md ? `${md}## ` : `${md}\n\n## `;
      ctx.setMarkdown(next);
      ctx.notify('已插入标题起始标记，可直接输入标题内容', 'success');
      return { ok: true, pluginId: 'slash-commands', message: '已插入标题标记', changedDoc: true };
    }

    /* ---- 书签 ---- */
    case 'bookmark.toggle': {
      const docId = ctx.getDocId?.() ?? '';
      if (!docId) {
        return { ok: false, pluginId: 'bookmarks', message: '当前没有打开的文档，无法收藏' };
      }
      const list = parseBookmarks(ctx.readStore(BOOKMARKS_STORE_KEY));
      const { list: next, bookmarked } = toggleBookmark(list, { docId, title: ctx.getTitle() });
      ctx.writeStore(BOOKMARKS_STORE_KEY, JSON.stringify(next));
      const msg = bookmarked ? `已收藏「${ctx.getTitle()}」` : `已取消收藏「${ctx.getTitle()}」`;
      ctx.notify(msg, 'success');
      return { ok: true, pluginId: 'bookmarks', message: msg };
    }

    default: {
      // 不再假装成功：明确说不可用
      const cap = getBuiltinCapability(pluginId);
      const name = cap?.panelTitle ?? pluginId;
      return {
        ok: false,
        pluginId,
        message: `「${name}」的命令 ${commandId} 暂未接线，该功能在当前版本不可用`,
      };
    }
  }
}

/* ---------------------- 编辑器扩展能力（供宿主查询） ---------------------- */

/**
 * `editorExtension: true` 的两款插件（`slash-commands` / `page-preview`）
 * 需要的编辑器内能力。
 *
 * 1.4.0 的落地状态：
 * - `slash-commands`：已提供**命令入口**（插入菜单），行内 `/` 触发未接入；
 * - `page-preview`：已提供**面板预览**，行内悬停浮层未接入。
 *
 * 宿主（EditorPage）据此判断是否渲染入口，避免入口存在但无效果。
 */
export const EDITOR_EXTENSION_STATUS: Record<string, { inlineTrigger: boolean; note: string }> = {
  'slash-commands': {
    inlineTrigger: false,
    note: '命令面板可唤出插入菜单；正文内直接键入「/」触发属于编辑器扩展层，当前版本未接入。',
  },
  'page-preview': {
    inlineTrigger: false,
    note: '可通过「页面预览」面板查看全部 Wikilink 目标的首段；正文内悬停浮层当前版本未接入。',
  },
};

/* --------------------------- 面板数据装配（纯函数） --------------------------- */

/** 面板预览条目（page-preview 面板用） */
export interface LinkPreviewItem {
  target: string;
  /** 目标文档标题（能解析到时） */
  title: string;
  /** 首段摘要；解析不到目标时为空 */
  excerpt: string;
  /** 仓库里是否存在该目标 */
  exists: boolean;
}

/**
 * 为当前文档的出链装配预览条目。
 *
 * @param source 当前文档 Markdown
 * @param resolve 目标名 -> 文档摘要（不存在则返回 null）
 */
export function buildLinkPreviews(
  source: string,
  resolve: (target: string) => { title: string; content: string } | null,
): LinkPreviewItem[] {
  const links = extractOutgoingLinks(source).filter((l) => l.kind !== 'markdown');
  const seen = new Set<string>();
  const out: LinkPreviewItem[] = [];
  for (const link of links) {
    if (seen.has(link.target)) continue;
    seen.add(link.target);
    const hit = resolve(link.target);
    out.push({
      target: link.target,
      title: hit?.title ?? link.target,
      excerpt: hit ? firstParagraph(hit.content) : '',
      exists: Boolean(hit),
    });
  }
  return out;
}

/** 取正文首段纯文本摘要（跳过 frontmatter / 标题 / 代码块 / 引用标记） */
export function firstParagraph(source: string, maxLength = 220): string {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const withoutFm = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const blocks = withoutFm.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) continue;
    if (/^\[.*\]:\s/.test(trimmed)) continue;
    const plain = trimmed
      .replace(/^>\s?/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) => a || t)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;
    return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
  }
  return '';
}
