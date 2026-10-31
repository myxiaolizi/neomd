#!/usr/bin/env node
/**
 * 1.4 需求9 辅助分析：**从落库值反推原值** + **全仓搜索产生 `?` 的可疑代码**。
 *
 * 为什么需要「反推」：
 *   落库值 `YY?MM?DD?HHMM-?input?` 与默认模板 `YYMMDD日HHMM-{input}` 长度**不等**
 *   （21 vs 17），说明替换不是简单 1:1 —— 必须逐字符对齐才能确定原值形态，
 *   否则「按默认值覆盖」可能掩盖真实历史（用户可能自定义过模板）。
 *
 * 用法：node tools/re14-analyze-garble.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO, 'docs/shots-140');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n=== ${t} ===`);

/* ------------------------------------------------------------------ */
/* 1. 落库值逐字符分析                                                  */
/* ------------------------------------------------------------------ */

/** 本次实测拿到的落库值（来自 DB / 云端 / localStorage 三方一致） */
const STORED = {
  template: 'YY?MM?DD?HHMM-?input?',
  fallback: '???',
  aiPrompt:
    '????????????????? Markdown ??,???????????????\n??:\n1. ???????,????????????????;\n2. ?? 6-24 ???(?????????);\n3. ????????,????????;\n4. ???? / \\ : * ? " < > | ?????????',
};

/** 默认值（packages/core/src/settings/settings.ts + packages/shared/src/naming.ts） */
const DEFAULTS = {
  template: 'YYMMDD日HHMM-{input}',
  fallback: '无标题',
  aiPrompt:
    '你是笔记标题生成器。阅读用户给出的 Markdown 正文，生成一个准确、简洁的中文标题。\n要求：\n1. 只输出标题本身，不要引号、不要标点结尾、不要解释；\n2. 长度 6-24 个汉字（英文概念可保留原词）；\n3. 若正文含一级标题，可参考但需更精炼；\n4. 不得包含 / \\ : * ? " < > | 等文件名非法字符。',
};

const cp = (ch) => (ch ? `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : '');

function analyzeField(name) {
  const stored = STORED[name];
  const def = DEFAULTS[name];
  const s = [...stored];
  const d = [...def];
  const asciiKept = s.filter((c) => c.charCodeAt(0) < 128 && c !== '?');
  const qCount = s.filter((c) => c === '?').length;

  // 尝试：把默认值按「保留 [A-Za-z0-9-_] 其余→?」规则转换，看能否复现落库值
  const rule = (ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : '?');
  const defToRule = d.map(rule).join('');

  return {
    field: name,
    storedLen: s.length,
    defaultLen: d.length,
    stored,
    default: def,
    questionMarks: qCount,
    asciiSurvivedChars: [...new Set(asciiKept)].join(''),
    defaultViaWhitelistRule: defToRule,
    ruleReproduces: defToRule === stored,
    lengthEqual: s.length === d.length,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 全仓搜索可疑「变 ?」代码                                          */
/* ------------------------------------------------------------------ */

const SUSPICIOUS = [
  { id: 'ascii-decode', re: /toString\(\s*['"](ascii|latin1|binary)['"]\s*\)/, why: '把 Buffer 按 ascii/latin1 解码（非 ASCII → ?）' },
  { id: 'buffer-from-enc', re: /Buffer\.from\([^)]*,\s*['"](ascii|latin1|binary)['"]\s*\)/, why: 'Buffer.from 用 ascii/latin1 编码（非 ASCII → ?）' },
  { id: 'textdecoder-legacy', re: /TextDecoder\(\s*['"](ascii|iso-8859|windows-1252|latin1)/i, why: 'TextDecoder 用非 UTF-8 编码' },
  { id: 'whitelist-replace', re: /replace\(\s*\/\[\^A-Za-z0-9/, why: '白名单清洗器：非字母数字一律替换' },
  { id: 'charCode-narrow', re: /charCodeAt\([^)]*\)\s*>\s*1(27|28)\s*\?\s*['"]\?['"]/, why: '非 ASCII 字符显式替换成 ?' },
  { id: 'encodeURIComponent-miss', re: /decodeURIComponent\(\s*['"]?%/, why: '编码链路可疑' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-base21', 'dist-t117', 'dist-t117b', '.git', '.gradle', 'build', 'releases']);

function scanRepo() {
  const hits = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|vue|js|mjs|cjs|ps1)$/.test(e.name)) continue;
      let text;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, i) => {
        for (const s of SUSPICIOUS) {
          if (s.re.test(line)) {
            hits.push({ file: p.slice(REPO.length + 1), line: i + 1, kind: s.id, why: s.why, code: line.trim().slice(0, 160) });
            break;
          }
        }
      });
    }
  };
  walk(REPO);
  return hits;
}

/* ------------------------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

hr('A. 落库值逐字符分析（反推原值形态）');
const fields = ['template', 'fallback', 'aiPrompt'].map(analyzeField);
for (const f of fields) {
  log(`\n[${f.field}]`);
  log(`  落库（${f.storedLen} 字符）: ${JSON.stringify(f.stored)}`);
  log(`  默认（${f.defaultLen} 字符）: ${JSON.stringify(f.default)}`);
  log(`  '?' 个数: ${f.questionMarks}`);
  log(`  存活的 ASCII 字符集: ${JSON.stringify(f.asciiSurvivedChars)}`);
  log(`  用「保留 [A-Za-z0-9_-] 其余→?」规则转换默认值: ${JSON.stringify(f.defaultViaWhitelistRule)}`);
  log(`  → 规则能否复现落库值: ${f.ruleReproduces ? '✓ 能' : `✗ 不能（落库 ${f.storedLen} vs 规则 ${[...f.defaultViaWhitelistRule].length} 字符）`}`);
  log(`  → 长度是否相等（是否 1:1 替换）: ${f.lengthEqual ? '✓ 是' : '✗ 否'}`);
}

hr('B. 结论：原值形态判定');
const tpl = fields[0];
if (tpl.ruleReproduces) {
  log('  ✓ 落库值 = 默认模板经「白名单清洗」的结果 → 原值就是默认模板 `YYMMDD日HHMM-{input}`');
} else {
  log('  ✗ 落库值与默认模板经白名单清洗的结果**不一致**');
  log('    → 说明历史原值**不是**当前默认模板（可能是某个更早版本的默认值，或用户自定义过）');
  log(`    → 落库 ${tpl.storedLen} 字符 vs 默认 ${tpl.defaultLen} 字符，差 ${tpl.storedLen - tpl.defaultLen}`);
  // 逐位置推测：把落库值里连续的 ? 还原成「一个中文字」或「一个 {xxx} 占位」
  log('    → 位置级推测（? 可能是 1 个中文字，也可能是 {placeholder} 整体替换）:');
  log(`      落库 = ${JSON.stringify(tpl.stored)}`);
  log('      已知旧版候选：');
  for (const cand of ['YYMMDD日HHMM-{input}', 'YY-MM-DD日HHMM-{input}', 'YYYYMMDD日HHMM-{input}', 'YYMMDD-HHMM-{input}']) {
    const viaRule = [...cand].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : '?')).join('');
    log(`        ${JSON.stringify(cand).padEnd(28)} → ${JSON.stringify(viaRule).padEnd(26)} ${viaRule === tpl.stored ? '✓ 匹配' : ''}`);
  }
}

hr('C. 全仓搜索「能产生 ?」的代码');
const hits = scanRepo();
if (!hits.length) {
  log('  ✓ 未发现任何 ascii/latin1 解码、白名单清洗器或显式 ? 替换');
  log('    → 当前代码库**不存在**产生该乱码的代码路径（与对照实验结论一致）');
} else {
  for (const h of hits) log(`  ${h.file}:${h.line}  [${h.kind}] ${h.why}\n      ${h.code}`);
}

const out = join(OUT_DIR, 're14-garble-analysis.json');
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stored: STORED, defaults: DEFAULTS, fields, codeHits: hits }, null, 2), 'utf8');
hr('输出');
log(`  ${out}`);
