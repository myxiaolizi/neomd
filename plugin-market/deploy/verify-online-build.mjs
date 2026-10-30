/** 验证线上生产包的插件执行逻辑已包含修复（读取本地下载的 chunk 文件） */
import { readFileSync, existsSync } from 'node:fs';

const path = process.argv[2] || 'ep-chunk.js';
if (!existsSync(path)) {
  console.error(`找不到 ${path}，请先 curl 下载线上 EditorPage chunk`);
  process.exit(1);
}
const c = readFileSync(path, 'utf8');

const MULTILINE = 'export\\s+default\\s+/m';
const FALLBACK = 'export\\s+default\\s+/,"return "';
const OLD_BROKEN = 'replace(/^\\s*export\\s+default\\s+/,"return ")';

const hasMultiline = c.includes(MULTILINE);
const hasFallback = c.includes(FALLBACK);
// 旧写法必须「不再单独出现」：修复版会把旧串包含在 fallback 里，因此用精确前缀判断
const hasOldOnly = c.includes(OLD_BROKEN) && !hasMultiline;

console.log(`文件：${path}（${c.length} 字符）`);
console.log(`${hasMultiline ? '✓' : '✗'} 多行标志 /m 修复已上线`);
console.log(`${hasFallback ? '✓' : '✗'} 兜底替换已上线`);
console.log(`${hasOldOnly ? '✗' : '✓'} 旧的单行正则已不再单独生效`);
console.log(`${c.includes('normalizePluginSource') || c.includes('\uFEFF') ? '✓' : '·'} 含 BOM 剥离逻辑`);

process.exit(hasMultiline && hasFallback && !hasOldOnly ? 0 : 1);
