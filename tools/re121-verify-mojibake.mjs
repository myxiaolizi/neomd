/**
 * 只读校验：settings.ts 是否还有「GBK 误解码」残留。
 *
 * 判据取「二字组合」而不是单字：单个字可能同时是正常用字（例如「覆」在「覆盖」里），
 * 而「涓婁」「鍚﹀」「鏂囨」这类组合是 GBK 误解码的固定产物，正常简体注释绝不会出现。
 * 这样既能抓全，又不会把我自己写正确的中文误报成乱码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(path.resolve(here, '..'), 'apps', 'web', 'src', 'stores', 'settings.ts');
const lines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);

/** GBK 误解码的典型二字组合（正常简体技术注释里不可能出现） */
const PAIRS = [
  '涓婁', '鍚﹀', '鏂囨', '缁?', '琛ラ', '鏈嶅', '绔厤', '缃粯', '璁笺', '锛?', '鑰屽',
  '涓嶈', '鏄?', '鐨?', '鏂板', '绾儶', '鏈湴', '閰嶇', '鍥犳', '姝ゅ', '鍙兘',
  '鈥?', '銆?', '銆學', '鍖猴', '姘镐', '浜戠', '鏈嶅姟', '璁剧疆', '鍝嶅簲', '鎷夊彇',
  '鎺ㄩ€', '鍚屾', '鍒嗗尯', '璺ㄧ', '寮轰', '涓€', '鍚勫', '缂撳', '瀛樺', '鍏佽',
  '瀹氫', '鏃х', '鑰佹', '鏁版', '鎹㈣', '璁惧', '澶囧', '鑼冨', '鍒囨', '鍐呰仈',
  '鍙橀噺', '鏁翠', '浠呮', '鐣岄潰', '榛樿', '璁や', '涓氬', '鏄剧', '闅忕', '鑷姩',
  '鎷︽', '鍙傛', '鐩存', '杩欐', '鏃犳', '淇濇', '鐣欏', '钀界', '鐩橈', '閬垮',
  '鍚﹀垯', '鎵€', '浼氶', '閲嶆', '鏂拌', '瑙﹀', '鍙戠', '鏃у', '€煎', '洖閫',
  '閫€锛', '鎶婁', '涓婚', '棰?', '瑕嗙', '鐩栨', '鎺夈', '娉ㄦ', '閲婏', '鍐?',
];

const hits = [];
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  if (PAIRS.some((p) => l.includes(p))) hits.push(i + 1);
}

console.log(`settings.ts 总行数：${lines.length}`);
console.log(`含 U+FFFD 的行：${lines.filter((l) => l.includes('\uFFFD')).length}`);
console.log(`GBK 误解码残留行数：${hits.length}`);
if (hits.length) console.log(hits.join(', '));
process.exit(hits.length ? 1 : 0);
