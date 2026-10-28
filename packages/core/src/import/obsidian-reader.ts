import type { NativeBridge } from '../platform';
import { shouldSkipPath } from './obsidian';
import type { ImportProgress, ObsidianSourceFile } from './obsidian-importer';

/** 单次扫描最多处理的文件数，防止用户误选到超大目录（如整个 C 盘）时卡死 */
const MAX_FILES = 20000;

/** 单文件大小上限（10MB）——笔记正文超过这个体积基本是误选 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 拼接绝对路径。
 * 桌面端 Windows 用 `\`，其余用 `/`，与 NativeVaultAdapter 保持一致。
 */
function joinAbs(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root}${sep}${rel.split('/').join(sep)}`;
}

/** 去掉路径末尾分隔符，避免拼出 `//` */
function trimRoot(dir: string): string {
  return dir.replace(/[\\/]+$/, '');
}

/**
 * 桌面端：经 NativeBridge 递归读取 Obsidian 仓库目录。
 *
 * 关键点：**必须用 `fs.stat` / `fs.list` 拿真实 mtime 并原样带出**，
 * 这是用户明确要求的「导入后需要明确文件的修改日期」的数据来源。
 * 目录遍历会跳过 `.obsidian/`、`.trash/`、`.git/`、`node_modules/` 等。
 */
export async function readObsidianVaultFromDir(
  bridge: NativeBridge,
  dir: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ObsidianSourceFile[]> {
  const root = trimRoot(dir);
  if (!root) throw new Error('未指定 Obsidian 仓库目录');

  interface FoundFile {
    relPath: string;
    size: number;
    mtime: number;
  }

  const found: FoundFile[] = [];
  let scanned = 0;

  // ---- 第一遍：递归收集文件（只列目录，不读内容，快） ----
  const walk = async (rel: string): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    const entries = await bridge.fs.list(rel ? joinAbs(root, rel) : root);
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldSkipPath(childRel)) continue;
      if (entry.isDirectory) {
        await walk(childRel);
        continue;
      }
      scanned += 1;
      found.push({ relPath: childRel, size: entry.size, mtime: entry.mtime });
      // 扫描阶段也回报进度，让用户看到「正在扫描 N 个文件」
      if (onProgress && scanned % 25 === 0) {
        onProgress({ done: 0, total: scanned, currentPath: childRel });
      }
    }
  };

  await walk('');

  // ---- 第二遍：逐个读内容，并把 mtime 再确认一次 ----
  const out: ObsidianSourceFile[] = [];
  const total = found.length;
  let done = 0;

  for (const item of found) {
    done += 1;
    onProgress?.({ done, total, currentPath: item.relPath });

    // 只导入 Markdown；图片等二进制由 importer 再兜一层 ignoredPaths 说明
    if (!/\.(md|markdown)$/i.test(item.relPath)) {
      out.push({
        relPath: item.relPath,
        content: '',
        mtime: item.mtime,
        size: item.size,
      });
      continue;
    }
    if (item.size > MAX_FILE_BYTES) continue;

    try {
      const content = await bridge.fs.readText(joinAbs(root, item.relPath));
      // 以 stat 的 mtime 为准（list 的 mtime 在部分平台精度较低）
      const stat = await bridge.fs.stat(joinAbs(root, item.relPath));
      out.push({
        relPath: item.relPath,
        content,
        mtime: stat?.mtime ?? item.mtime,
        size: stat?.size ?? item.size,
      });
    } catch {
      // 单个文件读失败不阻断整体，带上原始 mtime 交由 importer 记为 failed
      out.push({
        relPath: item.relPath,
        content: '',
        mtime: item.mtime,
        size: item.size,
      });
    }
  }

  return out;
}

/**
 * 网页端兜底：从 `<input type="file" webkitdirectory>` 的 FileList 读取。
 *
 * 浏览器沙箱下拿不到真实创建时间，`mtime` 用 `File.lastModified`。
 * 这不是「真实修改时间」的完美等价，但比全部变成「刚刚」要好得多。
 */
export function readObsidianVaultFromFileList(
  fileList: FileList | File[],
  onProgress?: (p: ImportProgress) => void,
): Promise<ObsidianSourceFile[]> {
  const files = Array.from(fileList as ArrayLike<File>);
  const out: ObsidianSourceFile[] = [];
  const total = files.length;

  return new Promise((resolve, reject) => {
    let index = 0;

    const next = (): void => {
      if (index >= files.length) {
        resolve(out);
        return;
      }
      const file = files[index]!;
      index += 1;

      // webkitRelativePath 形如 `MyVault/notes/a.md`，去掉第一段仓库名
      const relRaw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const relPath = relRaw.split('/').slice(1).join('/') || file.name;

      if (shouldSkipPath(relPath)) {
        onProgress?.({ done: index, total, currentPath: relPath });
        next();
        return;
      }

      if (!/\.(md|markdown)$/i.test(relPath)) {
        out.push({ relPath, content: '', mtime: file.lastModified, size: file.size });
        onProgress?.({ done: index, total, currentPath: relPath });
        next();
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        out.push({
          relPath,
          content: String(reader.result ?? ''),
          mtime: file.lastModified,
          size: file.size,
        });
        onProgress?.({ done: index, total, currentPath: relPath });
        next();
      };
      reader.onerror = () => {
        out.push({ relPath, content: '', mtime: file.lastModified, size: file.size });
        onProgress?.({ done: index, total, currentPath: relPath });
        next();
      };
      reader.readAsText(file, 'utf-8');
    };

    try {
      next();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
