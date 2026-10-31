// 宽口径 GBK 误解码扫描：使用更大范围的乱码特征字集。
// 只读，不修改任何文件。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Data\\BAC\\neomd\\neomd-V1';
const SCAN_DIRS = ['apps', 'packages', 'services', 'tools'];
const EXT_RE = /\.(ts|vue|js|mjs|cjs)$/i;
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.gradle', 'android-sdk',
  'jdk21', 'shots', 'shots-101', 'shots-102', 'shots-110', 'shots-111',
  'shots-115', 'shots-117', 'shots-118', 'shots-119', 'shots-119-admin',
  'shots-120', 'shots-121-settings', 'shots-v2', '.shots',
]);
const BUILD_DIR_NAMES = new Set([
  'build', 'app', 'release', 'debug', 'intermediates', 'generated',
  '.gradle', '.idea', '.cxx', '.externalNativeBuild', 'flavors',
]);

// GBK 字节流被 UTF-8 误解码时常出现的特征字（大量收集，覆盖常见词根）
// 这些字几乎不会在正常简体中文源码中出现（除非刻意书写冷僻字）。
const MOJIBAKE_CHARS = (
  '閿銆鏂鐨鈥锛鍚瀛涓鏄浣琚鐢缂缂冦伀銇屻仹' +
  '镄勭殑鏄敮浠樺钩鍙版帹鎺缁濋噾鑹叉兌' +
  '鐢ㄦ埛鍚嶅瘑鐮佺櫥褰曠姸鎬佷俊鎭潰鏂' +
  '浼氳瀛楃鍥惧舰缃戠粶鑾峰彇鎻忚堪鍣ㄧ畻' +
  '鍙橀噺娴佺▼鍣ㄥ悜涓嬪彇鍊兼枃浠跺す澶栭儴' +
  '閰嶇疆鍐呭寤虹珛鍒涘缓鐩綍鍒嗕韩杩炴帴' +
  '閿欒棰勮绠楁硶鍣ㄦ暟鎹簱琛ㄨЂаҮ' +
  '鏈嶅姟绔紑濮嬬粨鏉熸垨鑰呴€€鍥炲洖閫€' +
  '娉ㄥ唽閿佸畾璐﹀彿鏉冮檺璋冩暣澶勭悊' +
  '婕忔礊淇鏀瑰彉鏇挎崲鍙戝竷涓嬭浇瀹夎' +
  '绯荤粺缂撳瓨鍒犻櫎闄愬埗鏌ヨ绠＄悊' +
  '鍏抽棴寮€鍚疆杈撳叆杈撳嚭榛樿澶辫触' +
  '鎻愮ず鏍囬璇濋鍚嶇О鏃堕棿鏃ユ湡鏁伴噺' +
  '鍒嗙被鏍囩鏌ヨ澶у皬寮€濮嬫渶鍚庨厤缃珯' +
  '鏉冮檺鐢ㄦ埛鍚嶇О鐨勪俊鎭姸鎬佸垱寤' +
  '璇绘彁鍙栨彃鍏ユ洿鏂颁繚瀛樺垹闄ゅ彉鏇' +
  '鏈夋晥澶辨晥绫诲瀷鏍煎紡鍖哄煙鏉冮檺鍣ㄧ' +
  '绠€鍗曞鏉傚畬鎴愭垚鍔熷け璐ョ粨鏋滈敭锛' +
  '鎵撳紑鍏抽棴鍒ゆ柇鏉′欢閫夋嫨鎸夐挳澶勭悊`'
).split('');

const SET = new Set(MOJIBAKE_CHARS);

function walk(dir, depth = 0) {
  if (depth > 12) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
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
  for (const f of walk(path.join(ROOT, d))) {
    totalFiles++;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const ls = text.split('\n');
    const matched = [];
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];
      const found = [];
      for (const ch of line) {
        if (SET.has(ch)) { if (!found.includes(ch)) found.push(ch); }
      }
      if (found.length) matched.push({ lineNo: i + 1, snippet: line.slice(0, 160) });
    }
    if (matched.length) {
      hits.push({ file: f.replace(ROOT + '\\', ''), count: matched.length, lines: matched });
    }
  }
}

console.log(`扫描源码文件总数: ${totalFiles}`);
console.log(`乱码文件数: ${hits.length}`);
for (const h of hits) {
  console.log(`${h.file}  (${h.count} 行)`);
  for (const l of h.lines.slice(0, 40)) console.log(`   #${l.lineNo} ${l.snippet}`);
  if (h.lines.length > 40) console.log(`   ... 共 ${h.lines.length} 行`);
}

fs.writeFileSync(
  path.join(ROOT, 'tools', 're140-probe-D', 'encoding-audit-wide.json'),
  JSON.stringify({ totalFiles, hits }, null, 2)
);
console.log('\n已写出 encoding-audit-wide.json');