#!/usr/bin/env node
/**
 * 1.4 需求9 **决定性对照实验**：定位 `?` 替换发生在哪一层。
 *
 * ## 为什么必须做这个实验
 *
 * 已知事实：云端与 DB 里 `naming.template` = `YY?MM?DD?HHMM-?input?`。
 * 逐字符对齐后可以读出「哪些字符活了下来」：
 *   原值  `YYMMDD日HHMM-{input}`
 *   落库  `YY?MM?DD?HHMM-?input?`
 *   → 存活：Y M D H i n p u t **-**
 *   → 变 ?：日 **{ }**
 *
 * `{` 和 `}` 是纯 ASCII（0x7B/0x7D），utf8mb4 完全能存，字符集转换**不会**动它们；
 * 而短横线 `-` 活了下来。这强烈指向一个**白名单清洗器** `/[^A-Za-z0-9._-]/ → '?'`
 * 之类的逻辑（保留字母数字与 `._-`，其余一律替换）。
 *
 * ## 实验设计
 *
 * 用**纯 fetch**（不经浏览器、不经前端 store）逐个 PUT 候选值再 GET 读回，
 * 每个值单独一轮，互不影响。对照维度：
 *   1. 纯字母数字          `ABC123`            → 基线，应该永远完好
 *   2. 含 ASCII 特殊符号   `AB{CD}EF`          → 若变 `AB?CD?EF` ⇒ **是清洗器**
 *   3. 含中文              `AB日CD`            → 若变 `AB?CD`  ⇒ 同属清洗器（或字符集）
 *   4. 常见文件名符号      `AB-CD_EF.G`        → 若完好 ⇒ 白名单含 `-_.`
 *   5. 真实模板            `YYMMDD日HHMM-{input}`
 *
 * ## 安全
 *
 * 只改 `naming.template` 一个字段，实验结束后在 finally 里把备份的原值写回。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const USER = process.env.NEOMD_USER || 'admin';
const PASS = process.env.NEOMD_PASS || '6655';
const OUT_DIR = join(REPO, 'docs/shots-140');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n=== ${t} ===`);

let token = '';
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  token = body?.data?.accessToken ?? '';
  if (!token) throw new Error(`登录失败 ${JSON.stringify(body).slice(0, 200)}`);
}

async function getNaming() {
  const res = await fetch(`${API}/api/settings?platform=web`, { headers: { authorization: `Bearer ${token}` } });
  const d = (await res.json())?.data;
  return { version: d?.version ?? 0, naming: d?.payload?.naming ?? null };
}

async function putTemplate(template) {
  const cur = await getNaming();
  const naming = { ...(cur.naming ?? {}), template };
  const res = await fetch(`${API}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      payload: { global: { naming } },
      version: cur.version,
      deviceId: 're14-charset-probe',
      platform: 'web',
    }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 逐字符对齐：把 expected 与 actual 并排，标出每个位置是否被替换 */
function align(expected, actual) {
  const e = [...expected];
  const a = [...actual];
  const cells = [];
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i += 1) {
    const ec = e[i] ?? '';
    const ac = a[i] ?? '';
    cells.push({ i, expected: ec, expectedCp: ec ? ec.codePointAt(0) : null, actual: ac, same: ec === ac });
  }
  return cells;
}

/** 把对齐结果压成「存活 / 被替换」两组字符 */
function classify(cells) {
  const survived = new Set();
  const replaced = new Set();
  for (const c of cells) {
    if (!c.expected) continue;
    if (c.same) survived.add(c.expected);
    else replaced.add(c.expected);
  }
  return { survived: [...survived], replaced: [...replaced] };
}

const CASES = [
  { id: 'ascii-alnum', value: 'ABC123', expectIntact: true, note: '基线：纯字母数字' },
  { id: 'ascii-braces', value: 'AB{CD}EF', expectIntact: true, note: '花括号是 ASCII，字符集不会动它' },
  { id: 'cjk', value: 'AB日CD', expectIntact: true, note: '中文' },
  { id: 'filename-symbols', value: 'AB-CD_EF.G', expectIntact: true, note: '常见文件名符号 - _ .' },
  { id: 'real-template', value: 'YYMMDD日HHMM-{input}', expectIntact: true, note: '真实默认模板' },
  { id: 'ascii-punct', value: 'AB CD:E*F?G', expectIntact: null, note: '空格与更多标点（对照组）' },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await login();

  const origin = await getNaming();
  const backup = { version: origin.version, naming: origin.naming, at: new Date().toISOString() };
  writeFileSync(join(OUT_DIR, 're14-charset-probe-backup.json'), JSON.stringify(backup, null, 2), 'utf8');
  log(`备份原始 naming → docs/shots-140/re14-charset-probe-backup.json`);
  log(`  原始 template = ${JSON.stringify(origin.naming?.template)}`);

  const results = [];
  try {
    for (const c of CASES) {
      const put = await putTemplate(c.value);
      const after = await getNaming();
      const actual = after.naming?.template ?? '';
      const cells = align(c.value, actual);
      const cls = classify(cells);
      const intact = actual === c.value;
      results.push({ ...c, actual, intact, cells, ...cls, putStatus: put.status });

      const mark = intact ? '✓ 完好' : '✗ 被改';
      log(`\n  [${c.id}] ${mark}   ${c.note}`);
      log(`    写入 = ${JSON.stringify(c.value)}`);
      log(`    读回 = ${JSON.stringify(actual)}`);
      if (!intact) {
        log(`    存活字符 = ${JSON.stringify(cls.survived)}`);
        log(`    被替换字符 = ${JSON.stringify(cls.replaced)}`);
        const detail = cells
          .filter((x) => x.expected)
          .map((x) => `${x.expected}(U+${x.expectedCp?.toString(16).toUpperCase().padStart(4, '0')})${x.same ? '=' : '→' + JSON.stringify(x.actual)}`)
          .join('  ');
        log(`    逐字符 = ${detail}`);
      }
    }
  } finally {
    hr('回滚');
    const put = await putTemplate(backup.naming?.template ?? 'YYMMDD日HHMM-{input}');
    log(`  回滚 template 写入状态 ${put.status}`);
    const back = await getNaming();
    log(`  回滚后 template = ${JSON.stringify(back.naming?.template)}`);
  }

  hr('结论');
  const braces = results.find((r) => r.id === 'ascii-braces');
  const alnum = results.find((r) => r.id === 'ascii-alnum');
  const cjk = results.find((r) => r.id === 'cjk');
  const sym = results.find((r) => r.id === 'filename-symbols');

  let diagnosis = 'unknown';
  if (alnum?.intact && !braces?.intact) {
    diagnosis = 'sanitizer';
    log('  ✓ 假设2 命中：纯字母数字完好，但含 { } 的值被替换');
    log('    → 写入链路上存在**白名单清洗器**（保留字母数字，其余 → ?）');
    log(`    被替换字符集：${JSON.stringify(braces.replaced)}`);
    if (cjk && !cjk.intact) log(`    中文同样被替换：${JSON.stringify(cjk.replaced)}`);
    if (sym?.intact) log(`    且 - _ . 被保留 → 白名单形如 [A-Za-z0-9._-]`);
  } else if (alnum?.intact && braces?.intact && cjk && !cjk.intact) {
    diagnosis = 'charset';
    log('  ✓ 假设1 命中：只有中文被替换，ASCII 全部完好 → 字符集问题');
  } else if (results.every((r) => r.intact)) {
    diagnosis = 'writepath-healthy';
    log('  ✓ 写入链路完全正常：所有候选值原样往返');
    log('    → 现有乱码是**历史脏数据**（某次旧版本/旧脚本写入时产生），');
    log('      当前代码不会再产生；修复策略 = 一次性数据纠偏 + 读时防御');
  } else {
    log('  ? 结果不符合任一预设假设，请看上面的逐字符明细');
  }

  const outJson = join(OUT_DIR, 're14-charset-probe.json');
  writeFileSync(outJson, JSON.stringify({ at: new Date().toISOString(), diagnosis, backup, results }, null, 2), 'utf8');
  log(`\n  证据 JSON → ${outJson}`);
}

await main();
