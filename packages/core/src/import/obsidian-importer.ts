import type { ObsidianImportFileResult, ObsidianImportOptions, ObsidianImportReport } from '@neomd/shared';
import { normalizePath, titleFromPath, uniquePath } from '@neomd/shared';
import type { Vault } from '../vault/vault';
import { convertObsidianMarkdown, shouldSkipPath } from './obsidian';

/** 一个待导入的 Obsidian 源文件 */
export interface ObsidianSourceFile {
  /** 相对 Obsidian 仓库根的路径（POSIX 风格） */
  relPath: string;
  /** 文本内容 */
  content: string;
  /** 修改时间（毫秒）——导入后必须写回仓库，否则排序与新近度全错 */
  mtime: number;
  /** 创建时间（可选，部分平台无此信息时回落到 mtime） */
  ctime?: number;
  size: number;
}

/** 导入进度回调载荷 */
export interface ImportProgress {
  done: number;
  total: number;
  currentPath: string;
}

/** 只处理 Markdown 源文件，其余（图片/PDF 等二进制）本版本不导入 */
const MARKDOWN_EXT = /\.(md|markdown)$/i;

/**
 * 计算导入后的仓库内目标路径。
 * `targetFolder` 为空表示导入到仓库根目录。
 */
export function buildTargetPath(relPath: string, targetFolder: string): string {
  const rel = normalizePath(relPath);
  const folder = targetFolder ? normalizePath(targetFolder) : '';
  if (!folder) return rel;
  // 避免重复前缀：用户把目标目录设成源路径已有的目录名时不叠加
  if (rel === folder || rel.startsWith(`${folder}/`)) return rel;
  return normalizePath(`${folder}/${rel}`);
}

/**
 * 执行 Obsidian 仓库导入。
 *
 * 三个必须遵守的规则：
 * 1. 逐文件调用 `vault.create({ path, title, content, folder, mtime, ctime })`，
 *    把源文件的真实 mtime 写回，否则所有笔记都会显示成「刚刚创建」。
 * 2. 单个文件失败不中断整体，记 `status: 'failed'` + `error` 继续下一个。
 * 3. 非 Markdown 文件不导入，但要进 `ignoredPaths` 说明原因，让用户知道跳过了什么。
 */
export async function importObsidianVault(
  vault: Vault,
  files: ObsidianSourceFile[],
  opts: ObsidianImportOptions,
  onProgress?: (p: ImportProgress) => void,
): Promise<ObsidianImportReport> {
  const startedAt = Date.now();
  const results: ObsidianImportFileResult[] = [];
  const ignoredPaths: string[] = [];
  let imported = 0;
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  // 预筛选：跳过配置目录与二进制资源
  const candidates: ObsidianSourceFile[] = [];
  for (const f of files) {
    if (shouldSkipPath(f.relPath)) {
      ignoredPaths.push(`${f.relPath}（跳过：Obsidian 配置目录或垃圾文件）`);
      continue;
    }
    if (!MARKDOWN_EXT.test(f.relPath)) {
      ignoredPaths.push(`${f.relPath}（暂不支持二进制资源导入，请手动复制图片目录）`);
      continue;
    }
    candidates.push(f);
  }

  const total = candidates.length;
  // 已占用的仓库路径（小写比较，避免 Windows 大小写不敏感导致的重名覆盖）
  const taken = new Set(vault.list().map((d) => d.path.toLowerCase()));

  let done = 0;
  for (const file of candidates) {
    done += 1;
    onProgress?.({ done, total, currentPath: file.relPath });

    const modifiedAt = Number.isFinite(file.mtime) && file.mtime > 0 ? file.mtime : startedAt;
    const createdAt = Number.isFinite(file.ctime) && (file.ctime ?? 0) > 0 ? (file.ctime as number) : modifiedAt;
    const wantedPath = buildTargetPath(file.relPath, opts.targetFolder);

    const baseResult = {
      sourcePath: file.relPath,
      size: file.size,
      modifiedAt,
      createdAt,
    };

    try {
      // ---- 语法转换 ----
      let content = file.content;
      let conversions: string[] = [];
      if (opts.convertSyntax) {
        const r = convertObsidianMarkdown(file.content, opts);
        content = r.text;
        conversions = r.conversions;
      }

      // ---- 同名冲突处理 ----
      const existing = vault.byPath(wantedPath);
      if (existing) {
        if (opts.onConflict === 'skip') {
          skipped += 1;
          results.push({
            ...baseResult,
            targetPath: existing.path,
            status: 'skipped',
            conversions: [],
          });
          continue;
        }
        if (opts.onConflict === 'overwrite') {
          // 覆盖已知文档：直接写内容，保留文档 id 与其它元数据。
          // 关键：把源文件的真实 mtime 透传给 save()，否则这次覆盖会把
          // 用户 Obsidian 里的历史时间刷成「导入时刻」，时间线直接丢失。
          await vault.save(
            existing.docId,
            content,
            'import',
            false,
            '',
            opts.keepTimestamps ? modifiedAt : undefined,
          );
          const after = vault.get(existing.docId);
          taken.add(existing.path.toLowerCase());
          const isConverted = conversions.length > 0;
          if (isConverted) converted += 1;
          else imported += 1;
          results.push({
            ...baseResult,
            targetPath: existing.path,
            status: isConverted ? 'converted' : 'imported',
            conversions,
            // 回填实际生效的文档时间（开启 keepTimestamps 时即源文件 mtime）
            modifiedAt: after?.updatedAt ?? modifiedAt,
          });
          continue;
        }
        // rename：落到下方统一用 uniquePath 追加 (2)(3)…
      }

      // ---- 落库 ----
      let finalPath = wantedPath;
      if (existing && opts.onConflict === 'rename') {
        // taken 集合本身就是小写形态，与 uniquePath 内部的 toLowerCase 比较口径一致
        finalPath = uniquePath(wantedPath, taken);
      }

      const meta = await vault.create({
        path: finalPath,
        title: titleFromPath(finalPath),
        content,
        mtime: opts.keepTimestamps ? modifiedAt : undefined,
        ctime: opts.keepTimestamps ? createdAt : undefined,
      });

      taken.add(meta.path.toLowerCase());
      const isConverted = conversions.length > 0;
      if (isConverted) converted += 1;
      else imported += 1;

      results.push({
        ...baseResult,
        targetPath: meta.path,
        status: isConverted ? 'converted' : 'imported',
        conversions,
      });
    } catch (e) {
      failed += 1;
      results.push({
        ...baseResult,
        targetPath: wantedPath,
        status: 'failed',
        conversions: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const finishedAt = Date.now();

  // 仓库名取目标目录名，没有目标目录时用「Obsidian 仓库」
  const folderName = opts.targetFolder ? normalizePath(opts.targetFolder).split('/').filter(Boolean).pop() : '';
  return {
    vaultName: folderName || 'Obsidian 仓库',
    total,
    imported,
    converted,
    skipped,
    failed,
    ignoredPaths,
    files: results,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
  };
}
