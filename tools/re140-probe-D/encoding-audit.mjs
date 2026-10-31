// 全仓编码审计：用 Node fs.readFileSync(path,'utf8') 扫描源码，
// 搜典型 GBK 误解码字符，统计命中行数。
// 只读，不修改任何文件。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Data\\BAC\\neomd\\neomd-V1';
const SCAN_DIRS = ['apps', 'packages', 'services', 'tools'];
const EXT_RE = /\.(ts|vue|js|mjs)$/i;
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.gradle', 'android-sdk',
  'jdk21', 'shots', 'shots-101', 'shots-102', 'shots-110', 'shots-111',
  'shots-115', 'shots-117', 'shots-118', 'shots-119', 'shots-119-admin',
  'shots-120', 'shots-121-settings', 'shots-v2', '.shots',
]);
// 「android」构建产物目录整体排除（任务明确要求排除 android 构建产物）
// 但我们仍保留 apps/android 里的 .ts 源文件（若有）；这里只排除产物目录。
const BUILD_DIR_NAMES = new Set([
  'build', 'app', 'release', 'debug', 'intermediates', 'generated',
  '.gradle', '.idea', '.cxx', '.externalNativeBuild', 'flavors',
]);

// 典型 GBK 误解码字符（UTF-8 读 GBK 字节流时的乱码）
const GBK_MOJIBAKE = ['閿', '銆', '鏂', '鐨', '鈥', '锛', '鍚', '瀛', '涓', '鏄', '浣'];
const MOJI_RE = new RegExp(`[${GBK_MOJIBAKE.join('')}]`);

function walk(dir, depth = 0) {
  if (depth > 12) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) || BUILD_DIR_NAMES.has(e.name)) continue;
      files.push(...walk(full, depth + 1));
    } else if (e.isFile() && EXT_RE.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

const hits = [];
let totalFiles = 0;
for (const d of SCAN_DIRS) {
  const dir = path.join(ROOT, d);
  const files = walk(dir);
  totalFiles += files.length;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (err) {
      hits.push({ file: f.replace(ROOT + '\\', ''), lines: [], error: String(err.message) });
      continue;
    }
    const ls = text.split('\n');
    const matched = [];
    let hasMoji = false;
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];
      let m;
      MOJI_RE.lastIndex = 0;
      // 记录每行命中的乱码字符种类
      const found = [];
      for (const ch of GBK_MOJIBAKE) {
        if (line.includes(ch)) found.push(ch);
      }
      if (found.length) {
        hasMoji = true;
        matched.push({ lineNo: i + 1, chars: [...new Set(found)].join(''), snippet: line.slice(0, 160) });
      }
      void m;
    }
    if (hasMoji) {
      hits.push({ file: f.replace(ROOT + '\\', ''), lines: matched, count: matched.length });
    }
  }
}

console.log(`扫描源码文件总数: ${totalFiles}`);
console.log(`乱码文件数: ${hits.filter(h => h.lines && h.lines.length).length}`);
console.log('=== 乱码清单 ===');
for (const h of hits) {
  if (h.error) { console.log(`[读取错误] ${h.file}: ${h.error}`); continue; }
  console.log(`${h.file}  (${h.count} 行)`);
  for (const l of h.lines.slice(0, 50)) {
    console.log(`   #${l.lineNo} [${l.chars}] ${l.snippet}`);
  }
  if (h.lines.length > 50) console.log(`   ... 共 ${h.lines.length} 行`);
}

fs.writeFileSync(
  path.join(ROOT, 'tools', 're140-probe-D', 'encoding-audit.json'),
  JSON.stringify({ totalFiles, hits }, null, 2)
);
console.log('\n已写出 encoding-audit.json');