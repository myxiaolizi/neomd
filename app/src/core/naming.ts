import type { NamingMode } from './types';
import { buildDefaultName, extractTitleFromMarkdown, sanitizeTitle } from '../lib/util';

export interface NameInput {
  mode: NamingMode;
  /** 用户新建时输入的关键词 */
  userInput?: string;
  /** 正文内容（AI 模式用） */
  content?: string;
  /** AI 生成的标题（已生成时传入） */
  aiTitle?: string;
  /** 已存在的路径集合，用于去重 */
  existing: Set<string>;
  /** 目标目录前缀 */
  dir?: string;
}

/** 拼接最终文件名（不含 .md），自动加序号去重 */
export function buildDocName(input: NameInput): string {
  const { mode, userInput, content, aiTitle, existing, dir = '' } = input;

  let base: string;

  if (mode === 'ai') {
    const candidate = aiTitle ? sanitizeTitle(aiTitle) : extractTitleFromMarkdown(content ?? '');
    base = candidate || (userInput ? sanitizeTitle(userInput) : '') || '未命名笔记';
  } else {
    base = buildDefaultName(userInput ?? '', Date.now());
  }

  if (!base) base = '未命名笔记';

  // 去重
  const prefix = dir ? (dir.endsWith('/') ? dir : dir + '/') : '';
  let name = base;
  let n = 2;
  while (existing.has(`${prefix}${name}.md`)) {
    name = `${base} ${n}`;
    n++;
    if (n > 999) {
      name = `${base} ${Date.now()}`;
      break;
    }
  }
  return name;
}

/** 完整相对路径 */
export function buildDocPath(name: string, dir?: string): string {
  const clean = name.replace(/\.md$/i, '');
  return dir ? `${dir.replace(/\/+$/, '')}/${clean}.md` : `${clean}.md`;
}
