/**
 * 汇总 reports/model-verify/220 下各份多模型实测报告。
 *
 * 目的：确认「每个壳至少 3 个不同 AI 模型」是否达标，并把各模型上报的
 * 「真实缺陷」抽出来做横向对比。不是统计文件数，而是从每份报告里
 * 提取结构化结论（必测通过数、真实缺陷数、缺陷标题），
 * 这样才能判断哪些缺陷是多个模型独立复现的（可信度高），
 * 哪些只出现过一次（需要我自己复核）。
 *
 * Run: node tools/summarize-model-reports.mjs 220
 */
import fs from 'node:fs';
import path from 'node:path';

const VER = process.argv[2] ?? '220';
const DIR = path.join('C:\\Data\\BAC\\neomd\\neomd-V1', 'reports', 'model-verify', VER);

const SHELLS = ['winui3', 'qt', 'tauri', 'flutter', 'electron'];

function parseReport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const name = path.basename(file, '.md');

  // shell-model 形式（SPEC 要求），兼容 electron-gemini4argon 之类
  const m = /^(winui3|qt|tauri|flutter|electron)-(.+)$/.exec(name);
  const shell = m ? m[1] : '?';
  const model = m ? m[2] : name;

  /* 必测通过数：多种写法都试，模型们写报告的习惯不统一 */
  let passed = null;
  let total = null;
  const passes = [
    /必测项(?:通过数|通过)?[：:\s]*(\d+)\s*\/\s*(\d+)/,
    /必测项\s*(\d+)\s*\/\s*(\d+)/,
    /(\d+)\s*\/\s*12\s*(?:通过|PASS)/i,
    /必测[：:][^\n]{0,20}?(\d+)\s*\/\s*(\d+)/,
  ];
  for (const re of passes) {
    const x = re.exec(text);
    if (x) { passed = Number(x[1]); total = Number(x[2]); break; }
  }

  /* 真实缺陷数 */
  let defectCount = null;
  const dc = /(?:真实缺陷数|发现真实缺陷)[：:\s]*(\d+)/.exec(text);
  if (dc) defectCount = Number(dc[1]);

  /* 缺陷标题：抓「真实缺陷」小节下的列表项 */
  const defects = [];
  const sec = /##\s*[^\n]*真实缺陷[^\n]*\n([\s\S]*?)(?=\n##\s|\n?$)/i.exec(text);
  if (sec) {
    for (const line of sec[1].split(/\r?\n/)) {
      // 表格行 | 1 | 标题 | ... 或列表 - 标题
      const tbl = /^\|\s*\d+\s*\|\s*([^|]{4,120})\|/.exec(line);
      if (tbl) { defects.push(tbl[1].trim()); continue; }
      const li = /^[-*]\s+(.{6,140})/.exec(line);
      if (li && !/^\|/.test(line)) defects.push(li[1].trim());
    }
  }

  /* 疑似/未确认 */
  const susp = /(?:疑似缺陷|未确认)[^\n]{0,10}?(\d+)/.exec(text);

  return { name, shell, model, passed, total, defectCount, defects, suspicious: susp ? Number(susp[1]) : null,
    kb: Math.round(fs.statSync(file).size / 1024 * 10) / 10 };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'SPEC.md').map((f) => path.join(DIR, f));
const rows = files.map(parseReport);

console.log(`# ${VER} 多模型实测汇总\n`);
console.log(`报告总数：${rows.length}\n`);

for (const sh of SHELLS) {
  const rs = rows.filter((r) => r.shell === sh);
  const models = [...new Set(rs.map((r) => r.model))];
  const enough = models.length >= 3 ? '达标' : `**不足**（需 3 个，现有 ${models.length}）`;
  console.log(`## ${sh}  —  ${models.length} 个模型：${models.join(', ') || '（无）'}  ${enough}`);
  for (const r of rs) {
    const d = r.defectCount ?? '?';
    const p = r.passed != null ? `${r.passed}/${r.total}` : '?';
    console.log(`  - ${r.model}: 必测 ${p}，真实缺陷 ${d}${r.suspicious ? `，疑似 ${r.suspicious}` : ''}  (${r.kb}KB)`);
    for (const t of r.defects.slice(0, 4)) console.log(`      · ${t.slice(0, 100)}`);
  }
  console.log('');
}

/* 缺陷聚类：同一问题被几个模型独立上报 */
const allDefects = rows.flatMap((r) => r.defects.map((t) => ({ shell: r.shell, model: r.model, t })));
const KEYWORDS = [
  { key: '窄窗/状态栏溢出', re: /窄窗|窄窗口|statusbar|状态栏|横向滚动|裁切|溢出|min-width|794/ },
  { key: '标签页重复/累积', re: /标签.{0,8}(重复|累积|累积重复|叠加)|往返.{0,10}标签/ },
  { key: '历史版本为空', re: /历史版本.{0,10}空|版本记录.{0,6}空|listDocVersions/ },
  { key: '设置入参/草稿', re: /入参|类型校验|updateAppearance|草稿/ },
  { key: '白屏/闪退', re: /白屏|闪退|崩溃|crash/i },
  { key: '快捷键冲突', re: /快捷键|Ctrl\+|冲突/ },
];
console.log('## 缺陷关键词聚类（跨模型独立复现情况）\n');
for (const kw of KEYWORDS) {
  const hits = allDefects.filter((d) => kw.re.test(d.t));
  if (!hits.length) continue;
  const shells = [...new Set(hits.map((h) => h.shell))];
  const models = [...new Set(hits.map((h) => h.model))];
  console.log(`- ${kw.key}: 命中 ${hits.length} 次，涉及壳 [${shells.join(',')}]，模型 ${models.length} 个`);
  for (const h of hits.slice(0, 3)) console.log(`    · [${h.shell}/${h.model}] ${h.t.slice(0, 90)}`);
}

fs.writeFileSync(path.join(DIR, '_summary.json'), JSON.stringify(rows, null, 2), 'utf8');
console.log(`\n明细已写入 ${path.join(DIR, '_summary.json')}`);
