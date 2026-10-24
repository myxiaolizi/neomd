import type { AppSettings, NamingMode } from './types';
import { kv } from './kv';
import { deepMerge } from '../lib/util';

/** 默认快捷键：动作 → 组合键 */
export const DEFAULT_KEYMAP: Record<string, string> = {
  'format.h1': 'Mod+1',
  'format.h2': 'Mod+2',
  'format.h3': 'Mod+3',
  'format.h4': 'Mod+4',
  'format.h5': 'Mod+5',
  'format.h6': 'Mod+6',
  'format.paragraph': 'Mod+0',
  'format.bold': 'Mod+B',
  'format.italic': 'Mod+I',
  'format.strike': 'Mod+Shift+X',
  'format.code': 'Mod+E',
  'format.codeblock': 'Mod+Shift+E',
  'format.quote': 'Mod+Shift+.',
  'format.ul': 'Mod+Shift+8',
  'format.ol': 'Mod+Shift+7',
  'format.task': 'Mod+Shift+9',
  'format.link': 'Mod+K',
  'format.hr': 'Mod+Shift+-',
  'format.table': 'Mod+Shift+T',
  'edit.save': 'Mod+S',
  'edit.sync': 'Mod+Shift+S',
  'edit.new': 'Mod+N',
  'edit.rename': 'Mod+R',
  'edit.find': 'Mod+F',
  'edit.palette': 'Mod+P',
  'edit.toggleSidebar': 'Mod+\\',
  'edit.toggleHistory': 'Mod+Shift+H',
  'edit.settings': 'Mod+,',
};

/** 动作的中文名称 */
export const ACTION_LABELS: Record<string, string> = {
  'format.h1': '一级标题',
  'format.h2': '二级标题',
  'format.h3': '三级标题',
  'format.h4': '四级标题',
  'format.h5': '五级标题',
  'format.h6': '六级标题',
  'format.paragraph': '正文段落',
  'format.bold': '加粗',
  'format.italic': '斜体',
  'format.strike': '删除线',
  'format.code': '行内代码',
  'format.codeblock': '代码块',
  'format.quote': '引用',
  'format.ul': '无序列表',
  'format.ol': '有序列表',
  'format.task': '任务列表',
  'format.link': '插入链接',
  'format.hr': '分割线',
  'format.table': '插入表格',
  'edit.save': '保存文档',
  'edit.sync': '立即同步',
  'edit.new': '新建笔记',
  'edit.rename': '重命名',
  'edit.find': '查找',
  'edit.palette': '命令面板',
  'edit.toggleSidebar': '切换侧边栏',
  'edit.toggleHistory': '历史版本',
  'edit.settings': '打开设置',
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  accent: '#1677ff',
  namingMode: 'datetime',
  versionLimit: 80,
  versionIntervalSec: 90,
  editor: {
    fontSize: 15.5,
    lineHeight: 1.72,
    maxWidth: 780,
    fontFamily: '',
    spellcheck: false,
    autoPair: true,
    showLineNumbers: false,
    typewriter: false,
  },
  ai: {
    enabled: false,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    systemPrompt:
      '你是笔记标题助手。请阅读用户提供的笔记正文，输出一个简洁、准确、具体的中文标题。要求：不超过 20 个汉字；不使用标点符号结尾；不要书名号、引号或任何前后缀；只输出标题本身。',
  },
  sync: {
    enabled: false,
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: 'mdnote/',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    forcePathStyle: false,
    syncVersions: true,
    autoInterval: 300,
    concurrency: 4,
  },
  keymap: { ...DEFAULT_KEYMAP },
  sidebarCollapsed: false,
  restoreLast: true,
  autoImportExternal: true,
  locale: 'zh-CN',
};

const KEY = 'settings';

function merge(raw: Partial<AppSettings> | undefined): AppSettings {
  const r = raw ?? {};
  const merged = deepMerge(DEFAULT_SETTINGS, r);
  merged.editor = { ...DEFAULT_SETTINGS.editor, ...(r.editor ?? {}) };
  merged.ai = { ...DEFAULT_SETTINGS.ai, ...(r.ai ?? {}) };
  merged.sync = { ...DEFAULT_SETTINGS.sync, ...(r.sync ?? {}) };
  merged.keymap = { ...DEFAULT_KEYMAP, ...(r.keymap ?? {}) };
  return merged;
}

export async function loadSettings(): Promise<AppSettings> {
  return merge(await kv.get<Partial<AppSettings>>(KEY, {}));
}

export function loadSettingsSync(): AppSettings {
  return merge(kv.getSync<Partial<AppSettings>>(KEY, {}));
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await kv.set(KEY, s);
}

export function namingModeLabel(m: NamingMode): string {
  return m === 'ai' ? 'AI 生成标题' : '日期时间 + 关键词';
}
