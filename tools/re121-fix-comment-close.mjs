/**
 * 修补：为上一次按行号重写注释时被吞掉的块注释结束符补回来。
 *
 * 原因：原始乱码行的末尾常是「乱码 + 空格 + 星号斜杠」（结束符与乱码黏在同一行），
 * 按行号整体替换时若新文本没带结束符，块注释就会失去闭合 → 后续代码被当注释吞掉。
 * 这里用「块注释扫描」精确定位未闭合处，只在该块的最后一行补结束符。
 *
 * 用法：node tools/re121-fix-comment-close.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(path.resolve(here, '..'), 'apps', 'web', 'src', 'stores', 'settings.ts');
const DRY = process.argv.includes('--dry');

const lines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);

const fixAt = [];
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  // 已在本行闭合的块注释跳过
  if (/\/\*/.test(l) && /\*\//.test(l.slice(l.indexOf('/*') + 2))) continue;
  if (!/^\s*\/\*/.test(l)) continue;
  // 从下一行开始找闭合
  let closed = /\*\//.test(l.slice(2));
  let lastBody = i;
  let j = i + 1;
  for (; j < lines.length; j += 1) {
    if (/\*\//.test(lines[j])) {
      closed = true;
      break;
    }
    if (lines[j].trim() !== '' && !/^\s*\*/.test(lines[j]) && !/^\s*\/\*/.test(lines[j])) {
      // 遇到非注释体（说明没闭合就进了代码）
      break;
    }
    lastBody = j;
  }
  if (!closed) fixAt.push(lastBody + 1); // 1-based
}

console.log(`未闭合块注释 ${fixAt.length} 处，将在这几行末尾补 " */"：`);
for (const n of fixAt) console.log(`  L${n}: ${lines[n - 1].trim().slice(0, 90)}`);

if (!DRY) {
  for (const n of fixAt) {
    const idx = n - 1;
    if (!lines[idx].includes('*/')) lines[idx] = `${lines[idx].replace(/\s+$/, '')} */`;
  }
  fs.writeFileSync(TARGET, lines.join('\n'), 'utf8');
  console.log(`已写回（UTF-8 无 BOM）`);
} else {
  console.log('（--dry，未写盘）');
}
