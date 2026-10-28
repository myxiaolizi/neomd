import type { DocMeta, VersionRecord, FileStat } from '@neomd/shared';

export interface KVRow {
  key: string;
  value: string;
}

export interface DbFileRow {
  doc_id: string;
  path: string;
  title: string;
  rev: number;
  hash: string;
  size: number;
  created_at: number;
  updated_at: number;
  synced_rev: number | null;
  deleted_at: number | null;
}

export interface DbLinkRow {
  src_doc_id: string;
  dst_name: string;
  dst_doc_id: string | null;
  anchor: string;
  alias: string;
  /** 'wikilink' | 'markdown' | 'embed' */
  kind: string;
}

export interface DbTagRow {
  doc_id: string;
  tag: string;
  count: number;
}

export interface DbPropRow {
  doc_id: string;
  key: string;
  value: string;
  kind: string;
}

export interface SearchHit {
  docId: string;
  path: string;
  title: string;
  score: number;
  snippet: string;
  matches: number[];
}

export interface SearchOptions {
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  pathPrefix?: string;
  /** 搜索范围：标题 / 正文 / 全部 */
  scope?: 'title' | 'body' | 'all';
}

export interface IndexStats {
  files: number;
  bytes: number;
  tags: number;
  links: number;
  lastIndexedAt: number;
}

export type { DocMeta, VersionRecord, FileStat };
