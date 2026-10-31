/**
 * 生成「入口回归基线」附录（供 01-usability.md 引用，也供 1.4.1+ 做入口回归）。
 *
 * 输入：docs/AUDIT-140/dead-buttons.json          （229 个入口的全量探测结果）
 *       docs/AUDIT-140/dead-buttons-verdicts.json （39 个 no-change 的逐条定性）
 * 输出：docs/AUDIT-140/entrance-baseline.md        （人类可读表）
 *       docs/AUDIT-140/entrance-baseline.json      （机器可比对，供回归脚本 diff）
 *
 * ## 为什么需要「自动化初筛 + 人工覆盖」两层
 *
 * `dead-buttons.json` 是**指纹法**探测结果（比较点击前后页面状态），它对两类入口必然误判：
 *
 *  1. **页面预览**：点击后顺带触发标签操作 → `tabCount` 变化 → 指纹法判「有变化」，
 *     但实际上**没有任何预览容器出现**（定性脚本 H 段已确认）。
 *  2. **斜杠「/」命令面板**：它是键盘触发，**不在 229 个可点击入口里**，
 *     入口探测根本覆盖不到，只能在定性脚本里单独验证。
 *
 * 所以本脚本用 `MANUAL_OVERRIDES` 纠正第 1 类，用 `EXTRA_DEAD` 补录第 2 类，
 * 并在报告的「已知的测量限制」一节写清来源 —— 自动化不能替代语义判断。
 *
 * 用法：node tools/audit-生成入口基线.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'docs', 'AUDIT-140');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'dead-buttons.json'), 'utf8'));
const verdictFile = path.join(DIR, 'dead-buttons-verdicts.json');
const verdicts = fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, 'utf8')) : { all: [] };

/* ------------------------------------------------------------------ */
/* 1. 定性结论索引                                                     */
/* ------------------------------------------------------------------ */

const verdictMap = new Map();
/** 仅按 label 的索引 —— 跨 category 兜底（定性脚本 category 更细，如 `editorbar-格式`） */
const verdictByLabel = new Map();
for (const v of verdicts.all ?? []) {
  verdictMap.set(`${v.category}|${v.label}`, v);
  const prev = verdictByLabel.get(v.label);
  // 同 label 多条时优先保留 DEAD（更强的结论）
  if (!prev || (prev.verdict !== 'DEAD' && v.verdict === 'DEAD')) verdictByLabel.set(v.label, v);
}

/**
 * 三级匹配，逐级放宽：
 *  1. `kind|label` 精确
 *  2. 同 kind 下的「包含」匹配（处理组标签，如「14 个候选（大纲/…）」）
 *  3. 仅按 label 跨 category
 * 全部失败返回 null（保留 REVIEW）。
 */
function lookupVerdict(row) {
  const key = `${row.kind}|${row.label}`;
  if (verdictMap.has(key)) return verdictMap.get(key);

  for (const [k, v] of verdictMap) {
    const idx = k.indexOf('|');
    const cat = k.slice(0, idx);
    const lbl = k.slice(idx + 1);
    if (cat !== row.kind) continue;
    if (lbl.includes(row.label) || row.label.includes(lbl)) return v;
  }

  const byLabel = verdictByLabel.get(row.label);
  if (byLabel) return byLabel;
  for (const [lbl, v] of verdictByLabel) {
    if (lbl.includes(row.label) || row.label.includes(lbl)) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. 指纹法的已知误判修正（人工覆盖，优先级最高）                      */
/* ------------------------------------------------------------------ */

const MANUAL_OVERRIDES = [
  {
    test: (r) => /^页面预览/.test(r.label),
    baseline: 'DEAD',
    dead: true,
    why: '1.4.0 已知遗留：点击后无预览容器（指纹法因 tabCount 变化误判为 PASS，已按定性脚本 H 段纠正）',
  },
];

/** 不在 229 个按钮入口内的「键盘触发型」死入口（单独记录，不混入 229 统计） */
const EXTRA_DEAD = [
  {
    kind: 'keyboard',
    label: '斜杠「/」唤起命令面板',
    why: '输入 / 后弹层数=0，/ 原样留在正文 —— 1.4.0 已知遗留，仍未修',
  },
];

/** 状态 → 基线语义 */
const SEMANTICS = {
  ok: { baseline: 'PASS' },
  'ok-dialog': { baseline: 'PASS' },
  'ok-confirm': { baseline: 'PASS' },
  'no-change': { baseline: 'REVIEW' },
  disabled: { baseline: 'N/A' },
  'skipped-danger': { baseline: 'SKIP' },
  error: { baseline: 'FAIL' },
};

/** baseline → 显示标记（键必须加引号：'N/A' 不是合法标识符） */
const BASELINE_MARK = {
  PASS: '\u2713',
  DEAD: '\u2717',
  REVIEW: '\u00b7',
  'N/A': '\u2298',
  SKIP: '\u26d4',
  FAIL: '!',
};
const markOf = (b) => BASELINE_MARK[b] ?? '\u00b7';

/** 已定性的真死按钮（精确 label，来自定性脚本结论） */
const KNOWN_DEAD_LABELS = new Set(['重做', '插入链接']);

/* ------------------------------------------------------------------ */
/* 3. 逐行判定                                                         */
/* ------------------------------------------------------------------ */

const rows = raw.rows.map((r, i) => {
  const sem = SEMANTICS[r.verdict] ?? { baseline: 'UNKNOWN' };
  let baseline = sem.baseline;
  let dead = false;
  let note = r.note || '';

  if (r.verdict === 'no-change') {
    if (KNOWN_DEAD_LABELS.has(r.label)) {
      baseline = 'DEAD';
      dead = true;
      note = note || '已定性：真死按钮';
    } else {
      const v = lookupVerdict(r);
      if (v && v.verdict === 'DEAD') {
        baseline = 'DEAD';
        dead = true;
        note = v.evidence;
      } else if (v && v.verdict === 'FALSE-POSITIVE') {
        baseline = 'PASS';
        note = `假阳性：${v.evidence}`;
      } else {
        baseline = 'REVIEW';
        note = note || '未定性，需人工复核';
      }
    }
  }

  // 人工覆盖（纠正指纹法误判）—— 放在最后，优先级最高
  for (const o of MANUAL_OVERRIDES) {
    if (o.test(r)) {
      baseline = o.baseline;
      dead = o.dead;
      note = o.why;
    }
  }

  return { no: i + 1, kind: r.kind, label: r.label, probe: r.verdict, baseline, dead, note, extra: false };
});

/** 补录键盘触发型死入口（extra=true，不计入 229） */
for (const [i, e] of EXTRA_DEAD.entries()) {
  rows.push({
    no: `额外${i + 1}`,
    kind: e.kind,
    label: e.label,
    probe: 'manual',
    baseline: 'DEAD',
    dead: true,
    note: e.why,
    extra: true,
  });
}

/* ------------------------------------------------------------------ */
/* 4. 统计                                                             */
/* ------------------------------------------------------------------ */

const probeRows = rows.filter((r) => !r.extra);
const stat = probeRows.reduce((acc, r) => {
  acc[r.baseline] = (acc[r.baseline] ?? 0) + 1;
  return acc;
}, {});
const deadRows = rows.filter((r) => r.dead);

/* ------------------------------------------------------------------ */
/* 5. 写 Markdown                                                      */
/* ------------------------------------------------------------------ */

const KIND_TITLE = {
  ribbon: '功能区（ribbon）',
  editorbar: '正文编辑工具栏（editorbar）',
  bar: '标签栏 / 状态栏',
  'settings-tab': '设置页签',
  'settings-pane': '设置页内控件（按页签）',
  right: '右侧栏',
  keyboard: '键盘触发型入口（不在 229 按钮内）',
};

const kindGroups = new Map();
for (const r of rows) {
  const g = r.kind.startsWith('settings:') ? 'settings-pane' : r.kind;
  if (!kindGroups.has(g)) kindGroups.set(g, []);
  kindGroups.get(g).push(r);
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

let md = `# 入口回归基线（1.4.0 实测）

> 本文件由 \`tools/audit-生成入口基线.mjs\` 从 \`dead-buttons.json\` + \`dead-buttons-verdicts.json\` 生成，**请勿手改**。
>
> **用途**：作为入口级回归基线。产品迭代后重跑 \`node tools/audit-死按钮专项.mjs\`，
> 再用 \`entrance-baseline.json\` 与本文件对比，即可发现「新出现的死按钮」或「曾经能用的按钮失效了」。
>
> 生成时间：${new Date().toISOString()}

## 基线语义

| 标记 | baseline | 含义 |
|---|---|---|
| \u2713 | PASS | 点击后有可观测效果 / 打开弹窗 |
| \u2717 | **DEAD** | **真死按钮（点了没反应）** |
| \u00b7 | REVIEW | 点击无变化，尚未定性（需人工复核） |
| \u2298 | N/A | 当前禁用，依赖前置条件 |
| \u26d4 | SKIP | 破坏性操作，审计按纪律未点击 |
| ! | FAIL | 点击抛错 |

## 统计

- 按钮入口总数：**${probeRows.length}**
${Object.entries(stat)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- ${k}：**${v}**`)
  .join('\n')}
- 另有键盘触发型入口 **${rows.filter((r) => r.extra).length}** 个（不在 229 内）
- **真死按钮合计：${deadRows.length} 个**

## 真死按钮清单（${deadRows.length} 个）

| # | 位置 | 入口 | 实测证据 |
|---|---|---|---|
${deadRows.map((r) => `| ${r.no} | ${esc(r.kind)} | **${esc(r.label)}** | ${esc(r.note) || '—'} |`).join('\n')}

---

## 全量入口清单

`;

const renderTable = (list) => {
  let t = `| # | 入口 | 结果 | baseline | 证据/备注 |\n|---|---|---|---|---|\n`;
  for (const r of list) {
    t += `| ${r.no} | ${esc(r.label)} | ${markOf(r.baseline)} | ${r.baseline} | ${esc(r.note).slice(0, 96)} |\n`;
  }
  return t;
};

for (const [g, list] of kindGroups) {
  if (g === 'settings-pane') continue;
  md += `### ${KIND_TITLE[g] ?? g}（${list.length}）\n\n${renderTable(list)}\n`;
}

const paneRows = kindGroups.get('settings-pane') ?? [];
const byPane = new Map();
for (const r of paneRows) {
  const pane = r.kind.replace(/^settings:/, '');
  if (!byPane.has(pane)) byPane.set(pane, []);
  byPane.get(pane).push(r);
}
md += `### ${KIND_TITLE['settings-pane']}（共 ${paneRows.length}）\n\n`;
for (const [pane, list] of byPane) {
  md += `#### ${pane}（${list.length}）\n\n${renderTable(list)}\n`;
}

md += `---

## 已知的测量限制（重跑时请注意）

1. **格式按钮（加粗/斜体/下划线/删除线/高亮/行内代码）必须先选中文字再点**
   —— 无选区时 TipTap 只 toggle stored mark、不改 DOM，会被误判「无变化」。
   本基线里这 6 个已由定性脚本复现为**假阳性（PASS）**：\`<strong>/<em>/<u>/<s>/<mark>/<code>\` 各 \`0→1\`。
2. **seg 单选项点击「已选中项」必然无变化** —— 设计如此，不是缺陷。
3. **仓库页签的 12 个操作按钮依赖真实云端往返** —— 在假云端（\`settingsMode:'fake'\`）下不发请求，
   基线里记为 REVIEW，需真实云端环境复核。
4. **破坏性操作（${probeRows.filter((r) => r.baseline === 'SKIP').length} 个）按审计纪律未点击**
   —— 记为 SKIP；其「是否有二次确认」需单独专项验证。
5. **页面预览** 被指纹法误判为 PASS（因顺带触发 \`tabCount\` 变化），已人工纠正为 DEAD。
6. **斜杠「/」命令面板** 是键盘触发，不在 229 按钮内，以「额外」行单独记录。
7. **最有价值的回归点**：斜杠命令面板 / 页面预览 / 重做 / 插入链接 四项。
   若 1.4.1 修复，重跑后应全部转为 PASS。
`;

fs.writeFileSync(path.join(DIR, 'entrance-baseline.md'), md, 'utf8');
fs.writeFileSync(
  path.join(DIR, 'entrance-baseline.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totalProbes: probeRows.length,
      totalRows: rows.length,
      stat,
      deadCount: deadRows.length,
      rows,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('入口基线已生成：');
console.log(`  docs/AUDIT-140/entrance-baseline.md   （${md.split('\n').length} 行）`);
console.log(`  docs/AUDIT-140/entrance-baseline.json （${rows.length} 条，可机器比对）`);
console.log(`\n统计（${probeRows.length} 个按钮入口）：`, JSON.stringify(stat));
console.log(`\n真死按钮 ${deadRows.length} 个：`);
for (const r of deadRows) console.log(`  \u2717 [${r.kind}] ${r.label}`);
const review = rows.filter((r) => r.baseline === 'REVIEW');
console.log(`\n待人工复核 ${review.length} 个（主要是设置页 seg 选项与仓库操作）：`);
for (const r of review.slice(0, 8)) console.log(`  \u00b7 [${r.kind}] ${r.label}`);
if (review.length > 8) console.log(`  … 及另外 ${review.length - 8} 个`);
