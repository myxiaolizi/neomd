#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **凭据泄露精确定位**（只读）。
 *
 * 目标（lead 的 P0 要求）：
 *  「tools/*.mjs 里有生产管理员密码 6655 且仓库公开 —— 统计**全部**出现位置，
 *    给出可执行的整改方案（具体到改哪几行、改成什么、怎么保证以后不再犯）」。
 *
 * 本脚本输出：
 *  1. 每一处 `6655` 的 文件:行号 + 该行的语义（是默认值？测试断言？文档？）
 *  2. 分类：**运行时默认值**（危险，会真的用生产密码）/ **测试硬编码**（同样泄露，但需改造）/ **文档**
 *  3. 硬编码 OSS AK/SK 位置
 *  4. JWT_SECRET 明文位置
 *  5. 生成整改方案所需的「每处应改成什么」映射
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-base21', 'dist-t117', 'dist-t117b', 'dist-artifacts', '.gradle', 'build', 'releases', '.shots', 'plugin-market']);
function walk(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const all = walk(REPO);
const textish = all.filter((p) => /\.(ts|vue|js|mjs|cjs|json|md|yml|yaml|sql|env|example|txt|ps1)$/i.test(p));
const rel = (p) => relative(REPO, p).replace(/\\/g, '/');

/** 给一行代码分类 */
function classify(line, file) {
  const t = line.trim();
  if (/^\s*(\/\/|\*|\/\*|#)/.test(t)) return 'comment';
  if (/process\.env|import\.meta\.env/.test(t)) return 'env-read';
  if (/password\s*:\s*['"]6655['"]/.test(t) || /'6655'/.test(t)) {
    if (/NODE_ENV|process\.env/.test(t)) return 'env-default';
    return 'hardcoded';
  }
  return 'other';
}

/* ------------------------------------------------------------------ */
/* 1. 管理员密码 6655                                                  */
/* ------------------------------------------------------------------ */

hr('1. 生产管理员密码 `6655` 的全部出现位置');

const passHits = [];
for (const p of textish) {
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('6655')) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes('6655')) return;
    passHits.push({
      file: rel(p),
      line: i + 1,
      kind: classify(line, p),
      code: line.trim().slice(0, 150),
    });
  });
}
// 分类统计
const kindLabel = {
  hardcoded: '① 硬编码（脚本里直接写死密码）',
  'env-default': '② 环境变量默认值（未设 env 时回落到 6655）',
  comment: '③ 注释',
  'env-read': '④ 读取 env（安全）',
  other: '⑤ 其它',
};
const byKind = {};
for (const h of passHits) {
  byKind[h.kind] = byKind[h.kind] ?? [];
  byKind[h.kind].push(h);
}
for (const [k, arr] of Object.entries(byKind)) {
  log(`\n  ${kindLabel[k] ?? k}  —— ${arr.length} 处`);
  for (const h of arr) log(`    ${h.file}:${h.line}\n        ${h.code}`);
}

const filesWithPass = new Set(passHits.map((h) => h.file));
log(`\n  合计：${passHits.length} 处，分布在 ${filesWithPass.size} 个文件`);

/* 按目录聚合（判断泄露面） */
const byDir = {};
for (const h of passHits) {
  const d = h.file.split('/').slice(0, 2).join('/');
  byDir[d] = (byDir[d] ?? 0) + 1;
}
log('\n  按目录分布：');
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(3)} 处  ${d}`);

/* ------------------------------------------------------------------ */
/* 2. AK / SK                                                          */
/* ------------------------------------------------------------------ */

hr('2. 硬编码 AccessKey / Secret');
const akPatterns = [
  { id: 'aliyun-ak', re: /LTAI[0-9A-Za-z]{10,}/g, label: '阿里云 AccessKeyId (LTAI…)' },
  { id: 'generic-ak', re: /accessKeyId\s*[:=]\s*['"][^'"]{8,}['"]/g, label: 'accessKeyId 明文' },
  { id: 'generic-sk', re: /accessKeySecret\s*[:=]\s*['"][^'"]{8,}['"]/g, label: 'accessKeySecret 明文' },
];
const akHits = [];
for (const pat of akPatterns) {
  for (const p of textish) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      pat.re.lastIndex = 0;
      if (pat.re.test(line)) {
        akHits.push({ kind: pat.id, label: pat.label, file: rel(p), line: i + 1, code: line.trim().slice(0, 140) });
      }
    });
  }
}
for (const h of akHits) log(`  [${h.label}] ${h.file}:${h.line}\n      ${h.code}`);
if (!akHits.length) log('  未发现');

/* ------------------------------------------------------------------ */
/* 3. JWT_SECRET / DB 密码                                             */
/* ------------------------------------------------------------------ */

hr('3. JWT_SECRET / DB 口令明文');
const secretPatterns = [
  { id: 'jwt', re: /JWT_SECRET\s*=\s*\S+/g, label: 'JWT_SECRET=…' },
  { id: 'dbpass', re: /DB_PASSWORD\s*=\s*\S+/g, label: 'DB_PASSWORD=…' },
  { id: 'secretskey', re: /SECRETS_KEY\s*=\s*\S+/g, label: 'SECRETS_KEY=…' },
];
const secretHits = [];
for (const pat of secretPatterns) {
  for (const p of textish) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      pat.re.lastIndex = 0;
      if (pat.re.test(line)) {
        const masked = line.replace(/(=\s*)(\S{4})\S+/, '$1$2****');
        secretHits.push({ kind: pat.id, file: rel(p), line: i + 1, code: masked.trim().slice(0, 120) });
      }
    });
  }
}
for (const h of secretHits) log(`  [${h.kind}] ${h.file}:${h.line}  ${h.code}`);
if (!secretHits.length) log('  未发现');

/* ------------------------------------------------------------------ */
/* 4. .env 是否被 git 跟踪                                             */
/* ------------------------------------------------------------------ */

hr('4. `.env` 文件是否会被提交进仓库');
const envFiles = all.filter((p) => /[\\/]\.env(\..*)?$/.test(p)).map(rel);
log(`  仓库内 .env* 文件：${envFiles.length ? envFiles.join(', ') : '（无）'}`);

let gitignore = '';
try {
  gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
} catch {
  /* ignore */
}
const envIgnored = /^\s*\.env/m.test(gitignore);
log(`  .gitignore 是否忽略 .env：${envIgnored ? '✓ 是' : '✗ 否（**高危**）'}`);
const gitignoreLines = gitignore.split(/\r?\n/).filter((l) => /env|secret|key|credential/i.test(l));
log(`  .gitignore 相关规则：${gitignoreLines.length ? gitignoreLines.join(' | ') : '（无）'}`);

/* ------------------------------------------------------------------ */
/* 5. 输出                                                             */
/* ------------------------------------------------------------------ */

mkdirSync(OUT, { recursive: true });
const report = {
  at: new Date().toISOString(),
  adminPassword: { total: passHits.length, files: filesWithPass.size, byKind, hits: passHits, byDir },
  accessKeys: akHits,
  secrets: secretHits,
  envFiles,
  envIgnored,
  gitignoreEnvRules: gitignoreLines,
};
writeFileSync(join(OUT, 'credentials-leak.json'), JSON.stringify(report, null, 2), 'utf8');

hr('汇总');
log(`  管理员密码 6655：${passHits.length} 处 / ${filesWithPass.size} 文件`);
log(`  其中「硬编码」${byKind.hardcoded?.length ?? 0} 处、「env 默认值」${byKind['env-default']?.length ?? 0} 处`);
log(`  AK/SK 明文：${akHits.length} 处`);
log(`  密钥明文：${secretHits.length} 处`);
log(`  .env 被 gitignore：${envIgnored ? '是' : '否'}`);
log(`\n  证据 → ${join(OUT, 'credentials-leak.json')}`);
