import MiniSearch, { type SearchResult } from 'minisearch';
import type { SearchHit, SearchOptions } from './types';

/**
 * 全库检索：MiniSearch 前缀 + 模糊匹配，中文按二元切分以支持子串检索。
 * 索引可序列化后随仓库同步，避免每台设备重建。
 */

export interface SearchDoc {
  id: string;
  path: string;
  title: string;
  body: string;
  tags: string;
}

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 把中文串切成 2 字 gram，英文按空白切 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const latin = text.match(/[A-Za-z0-9_@#./+-]+/g) ?? [];
  for (const w of latin) tokens.push(w.toLowerCase());
  const cjkChunks = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const chunk of cjkChunks) {
    if (chunk.length === 1) {
      tokens.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) {
      tokens.push(chunk.slice(i, i + 2));
    }
  }
  return tokens;
}

export class SearchEngine {
  private index: MiniSearch<SearchDoc>;
  private bodies = new Map<string, string>();

  constructor() {
    this.index = new MiniSearch<SearchDoc>({
      idField: 'id',
      fields: ['title', 'body', 'tags', 'path'],
      storeFields: ['path', 'title'],
      tokenize,
      searchOptions: {
        boost: { title: 4, tags: 2, path: 1.5 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    });
  }

  get size(): number {
    return this.index.documentCount;
  }

  add(doc: SearchDoc): void {
    this.bodies.set(doc.id, doc.body);
    if (this.index.has(doc.id)) this.index.replace(doc);
    else this.index.add(doc);
  }

  remove(id: string): void {
    this.bodies.delete(id);
    if (this.index.has(id)) this.index.discard(id);
  }

  clear(): void {
    this.bodies.clear();
    this.index.removeAll();
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const limit = options.limit ?? 50;

    if (options.regex) {
      return this.regexSearch(q, options, limit);
    }

    let results: SearchResult[];
    try {
      results = this.index.search(q, {
        prefix: true,
        fuzzy: q.length > 4 ? 0.2 : 0,
        combineWith: q.includes(' ') ? 'AND' : 'OR',
        boost: { title: 4, tags: 2, path: 1.5 },
      });
    } catch {
      return [];
    }

    const out: SearchHit[] = [];
    for (const r of results) {
      const path = String(r.path ?? '');
      if (options.pathPrefix && !path.startsWith(options.pathPrefix)) continue;
      const title = String(r.title ?? '');
      const body = this.bodies.get(String(r.id)) ?? '';
      if (options.scope === 'title' && !containsCI(title, q)) continue;
      const snippet = makeSnippet(body, q, options.caseSensitive ?? false);
      out.push({
        docId: String(r.id),
        path,
        title,
        score: r.score,
        snippet: snippet.text,
        matches: snippet.positions,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private regexSearch(pattern: string, options: SearchOptions, limit: number): SearchHit[] {
    let re: RegExp;
    try {
      re = new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
    } catch {
      return [];
    }
    const out: SearchHit[] = [];
    for (const [id, body] of this.bodies) {
      re.lastIndex = 0;
      const m = re.exec(body);
      if (!m) continue;
      const positions: number[] = [];
      let count = 0;
      re.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(body)) && count < 200) {
        positions.push(mm.index);
        count += 1;
        if (mm.index === re.lastIndex) re.lastIndex += 1;
      }
      out.push({
        docId: id,
        path: '',
        title: '',
        score: positions.length,
        snippet: makeSnippet(body, m[0]).text,
        matches: positions.slice(0, 20),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 序列化为可持久化 JSON（随仓库同步到对象存储） */
  serialize(): string {
    return JSON.stringify({
      index: this.index.toJSON(),
      bodies: [...this.bodies.entries()],
    });
  }

  static deserialize(raw: string): SearchEngine {
    const engine = new SearchEngine();
    const data = JSON.parse(raw) as { index: unknown; bodies: Array<[string, string]> };
    engine.index = MiniSearch.loadJSON<SearchDoc>(JSON.stringify(data.index), {
      idField: 'id',
      fields: ['title', 'body', 'tags', 'path'],
      storeFields: ['path', 'title'],
      tokenize,
    });
    engine.bodies = new Map(data.bodies);
    return engine;
  }
}

function containsCI(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function makeSnippet(body: string, needle: string, caseSensitive = false): { text: string; positions: number[] } {
  const hay = caseSensitive ? body : body.toLowerCase();
  const nee = caseSensitive ? needle : needle.toLowerCase();
  const idx = hay.indexOf(nee);
  if (idx < 0) {
    const text = body.slice(0, 160).replace(/\s+/g, ' ').trim();
    return { text, positions: [] };
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + nee.length + 100);
  const text = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`;
  return { text, positions: [idx] };
}

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}
