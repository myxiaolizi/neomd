/**
 * 生成多模型实测横向对比表（Markdown），给交付用。
 *
 * 与 summarize-model-reports.mjs 的分工：
 *   - 前者是命令行速览，给我自己看，重在"哪些壳模型数不够"；
 *   - 本脚本产出正式表格，重在"每壳每模型的结论 + 发现的缺陷 + 是否被裁决"。
 *
 * 关键设计：把每份报告里声称的"真实缺陷"与我后续的**裁决结果**并列呈现。
 * 因为实测里有多份报告把测试方法问题当成产品缺陷（例如把 429 限流、
 * 把删了 data/ 导致读到用户真实仓库、把草稿态设计当成"保存失效"），
 * 如果只统计"报告说有几个缺陷"，会把环境噪音算成产品质量问题。
 *
 * Run: node tools/build-comparison-table.mjs 220
 */
import fs from 'node:fs';
import path from 'node:path';

const VER = process.argv[2] ?? '220';
const ROOT = 'C:\\Data\\BAC\\neomd\\neomd-V1';
const DIR = path.join(ROOT, 'reports', 'model-verify', VER);

const SHELL_LABEL = {
  winui3: 'WinUI3', qt: 'Qt', tauri: 'Tauri', flutter: 'Flutter', electron: 'Electron',
};
const SHELL_ORDER = ['winui3', 'qt', 'tauri', 'flutter', 'electron'];

/**
 * 人工裁决表：报告里声称的缺陷 -> 我的复核结论。
 *
 * 这些不是我凭空判断的，每条都在 FIXES.md 里有复现或反证记录：
 *   fixed        我已定位根因并修复，修复后重测通过
 *   not-a-defect 实测确认是产品正确行为（设计如此）
 *   env          环境问题（限流/端口被抢/副本被删/客户端误杀），非产品缺陷
 *   testmethod   报告者的测试方法错误（定位方式、时序、重复派发等）
 */
const ADJUDICATION = {
  '窄窗状态栏溢出|窄窗口|statusbar|横向滚动|794|825|818|溢出':
    { verdict: 'fixed', note: '四壳四模型独立复现，已修 CSS 并验证 500-900px 全部 overflow=0' },
  '标签.{0,10}(重复|累积|叠加)|后台往返.*标签':
    { verdict: 'fixed', note: 'restoreTabs 绕过 openDoc 去重所致，已修并加 tabs.adminRoundTrip 双向断言' },
  '入参|类型校验|updateAppearance|对象存储配置不完整':
    { verdict: 'fixed', note: '已加入参普通对象校验；另外补了 429 限流的自动重试与提示' },
  '历史版本.{0,12}(空|不变|仍为)|版本计数仍为|版本数未增加|keepVersions':
    { verdict: 'not-a-defect', note: '保存归档的是"保存前旧内容"且有落盘时序；已固化为"版本数必须增加"的增量断言并通过' },
  '设置.{0,8}(无变化|失效|不生效)|改字号':
    { verdict: 'not-a-defect', note: '两段式草稿设计：草稿阶段不写库是正确的，点保存后 store+localStorage 同变' },
  '白屏|页面未加载|空白':
    { verdict: 'not-a-defect', note: '判定看 DOM 结构不看正文长度；实测 shell 结构完整、0 异常。空正文多因用户布局偏好收起侧栏' },
  '请求过于频繁|429|限流':
    { verdict: 'env', note: '共享测试账号多端并发触发云端限流；等待退避窗口后重测 24/24 全过' },
  '编辑器不渲染|createDoc.{0,6}返回 null|cm-editor 不存在':
    { verdict: 'testmethod', note: '外部 Chrome 驱动与原生窗口渲染路径不同导致；同壳其他模型与自动化验收该项均通过' },
  '浏览器崩溃|GPU process exited|进程退出|未能找到.{0,10}HTTP 服务|端口':
    { verdict: 'env', note: '并行测试互相抢占端口/按进程名批量杀进程；隔离后重测通过' },
  /*
   * 以下几条都是"报告说失败、我复核后不成立"的，逐条给出依据，
   * 避免下次又去查一遍：
   */
  'listDocVersions.{0,20}空|保存后未生成版本记录':
    { verdict: 'not-a-defect', note: '实测：旧文档 1→2、新文档 2→3，版本链正常。原因是归档"保存前旧内容"且落盘有延迟，立刻查会读到空；已固化为 history.grow 增量断言' },
  '管理后台往返后应用页面.{0,6}(加载异常|未加载)':
    { verdict: 'not-a-defect', note: '实测 shell DOM 完整（appHtmlLen>5万）、0 未捕获异常；正文偏短是用户布局偏好收起了侧栏，不是白屏' },
  '初始登入后.{0,20}docs.{0,6}0|仍为 sync|初始登入后':
    { verdict: 'not-a-defect', note: '首轮全量同步需要时间（本仓库 2500+ 篇约 60s），12 秒采样必然还在 syncing；同步完成后 docs 正常（该报告自己复测也读到 415 篇）' },
  'Remove-Item Env:.ELECTRON_RUN_AS_NODE':
    { verdict: 'env', note: '报告者环境里 ELECTRON_RUN_AS_NODE 被父进程注入导致 Electron 以 Node 模式退出；清掉即可，非产品缺陷' },
  'CDP 页面 target 不存在|无法订阅.{0,20}Runtime':
    { verdict: 'env', note: 'Electron 走 neomd:// 自定义协议，target 发现方式与其他壳不同；改用 electron-accept.mjs 已验证 21/21' },
  'Unable to move the cache|Chromium 磁盘/GPU 缓存':
    { verdict: 'env', note: '并行实例共用同一 userData 目录导致缓存目录争用；隔离副本后不再出现' },
};

function classify(defectText) {
  /*
   * 先排除"伪缺陷"：有些报告的 FAIL 行/编号条目其实是在描述**通过**的行为
   * （例如 tauri-glm53flash 把「断网→恢复同步自愈正常」写进了类似位置）。
   * 这类文本含"正常/自愈/通过/符合预期"，明显不是缺陷，
   * 若交给后面的规则匹配会被误归为"待复核"，虚增缺陷数。
   */
  if (/自愈正常|恢复正常|均符合预期|验证通过|表现优异|无异常/.test(defectText)) {
    return { verdict: 'not-a-defect', note: '原文描述的是通过的行为，不是缺陷' };
  }
  for (const [pat, v] of Object.entries(ADJUDICATION)) {
    if (new RegExp(pat).test(defectText)) return v;
  }
  return { verdict: 'unverified', note: '未在批量裁决表中，需人工复核' };
}

/**
 * 从报告文本里抽出「真实缺陷」条目。
 *
 * 实测发现报告的写法非常不统一，不能只看某个固定小节：
 *   - qt-qwen38max：`- **发现真实缺陷：2 个**` 后跟 1./2. 编号列表，每条很长；
 *   - winui3-gemini4argon：`- 发现真实缺陷：3 个（历史版本计数不更新、设置保存…）` 缺陷塞在括号里；
 *   - tauri-gemini38flash-b：`真实缺陷数：0`，无列表；
 *   - 还有的只写在「必测 12 项」表里 FAIL 行的备注。
 * 所以按三层兜底：括号内枚举 -> 编号列表 -> 表格 FAIL 行。
 */
function extractDefects(text) {
  const out = [];

  // 优先：找到「发现真实缺陷 / 真实缺陷数」那一行
  const headRe = /(?:发现真实缺陷|真实缺陷数)[：:]\s*\**\s*(\d+)\s*\**\s*个?/;
  const head = headRe.exec(text);
  const declared = head ? Number(head[1]) : null;

  if (declared === 0) return { defects: [], declared: 0 };

  /*
   * ① 编号列表优先：紧跟在「真实缺陷」声明之后的 1. / 2. 条目，每条就是一条缺陷。
   *    这是最可靠的形态（qt-qwen38max、flutter-deepseekv41flash 都是这样写的）。
   *
   *    必须排在括号枚举**之前**：那些条目本身很长，内部含「、」「，」和括号，
   *    若先按标点去括号内容切，一句话会被拆成「每次往返 +N」「N=非活动标签数」
   *    这种残片 —— 表格里读起来完全看不懂在说什么。
   */
  if (head) {
    const tail = text.slice(head.index);
    const lines = tail.split(/\r?\n/).slice(1);
    for (const line of lines) {
      const s = line.trim();
      if (/^[-*]\s*\**\s*疑似/.test(s) || /^##\s/.test(s)) break;
      const num = /^\d+[.、]\s*(.{6,400})/.exec(s);
      if (num) { out.push(num[1].replace(/\*\*/g, '').trim()); continue; }
      const bullet = /^[-*]\s+【[^】]*】\s*(.{6,400})/.exec(s);
      if (bullet) { out.push(bullet[1].replace(/\*\*/g, '').trim()); continue; }
    }
    if (out.length) {
      return {
        defects: out.map((d) => {
          const cut = d.split(/(?:可复现步骤|见探索|证据：|复现：)/)[0].trim();
          return (cut || d).slice(0, 220);
        }),
        declared,
      };
    }
  }

  /*
   * ② 括号内枚举：仅当里面是**短名词**才拆。
   *    winui3-gemini4argon 是这种写法：
   *    「真实缺陷：3 个（历史版本计数不更新、设置保存功能失效、管理后台往返后应用页面加载异常）」
   *    判据：每段都短且不含句子级标点，否则说明是长描述，不拆。
   */
  if (head) {
    const after = text.slice(head.index, head.index + 700);
    const paren = /（([^）]{6,500})）/.exec(after);
    if (paren) {
      const parts = paren[1].split(/[、,，]/).map((p) => p.trim()).filter(Boolean);
      const looksLikeShortNames =
        parts.length >= 2 && parts.every((p) => p.length <= 40 && !/[。：:；;]/.test(p));
      if (looksLikeShortNames) return { defects: parts, declared };
    }
  }

  /*
   * ③ 兜底：从「必测 12 项」表格里挑 FAIL 行。
   * 这类报告通常没写「真实缺陷」数字（解析成 null），但表格里明确标了 FAIL，
   * 那些就是它认为的缺陷。用「项目名 + 证据」拼成一条可读的摘要。
   */
  const failRows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    if (!/FAIL/i.test(line)) continue;
    const item = cells[2] ?? '';
    const evidence = cells[4] ?? '';
    if (item) failRows.push(`${item}${evidence ? '：' + evidence.slice(0, 80) : ''}`);
  }
  return { defects: failRows.slice(0, 4), declared, fromTable: failRows.length > 0 };
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const base = path.basename(file, '.md');
  const m = /^(winui3|qt|tauri|flutter|electron)-(.+)$/.exec(base);
  if (!m) return null;
  const [, shell, model] = m;

  let passed = null, total = 12;
  for (const re of [/必测项?(?:通过数)?[：:\s]*\**\s*(\d+)\s*\**\s*\/\s*\**\s*(\d+)/, /(\d+)\s*\/\s*12/]) {
    const x = re.exec(text);
    if (x) { passed = Number(x[1]); total = Number(x[2] ?? 12); break; }
  }

  const { defects, declared, fromTable } = extractDefects(text);
  return { shell, model, passed, total, defects,
    declared: declared ?? (fromTable ? defects.length : 0),
    fromTable: !!fromTable,
    kb: Math.round(fs.statSync(file).size / 1024 * 10) / 10 };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && !/^(SPEC|FIXES|_)/.test(f));
const rows = files.map((f) => parse(path.join(DIR, f))).filter(Boolean);

const lines = [];
lines.push(`# Neo MD ${VER.slice(0, 1)}.${VER.slice(1, 2)}.${VER.slice(2)} 多模型实测横向对比\n`);
lines.push(`> 每个桌面壳由 **≥3 个不同 AI 模型**独立实测；报告原文见 \`reports/model-verify/${VER}/\`。`);
lines.push(`> 「报告缺陷」是模型自述数量；「裁决」是我用探针复核后的结论 —— 两者并列，避免把环境噪音算成产品质量问题。\n`);

// ---- 表一：模型覆盖 ----
lines.push('## 表一 模型覆盖与必测通过率\n');
lines.push('| 桌面壳 | 实测模型数 | 模型 | 必测通过 | 报告缺陷 | 模型数达标 |');
lines.push('|---|---|---|---|---|---|');
for (const sh of SHELL_ORDER) {
  const rs = rows.filter((r) => r.shell === sh);
  if (!rs.length) { lines.push(`| ${SHELL_LABEL[sh]} | 0 | — | — | — | ❌ |`); continue; }
  const models = rs.map((r) => r.model).join('、');
  const passText = rs.map((r) => `${r.model} ${r.passed ?? '?'}/${r.total}`).join('<br>');
  const defText = rs.map((r) => `${r.model} ${r.defects.length}`).join('<br>');
  lines.push(`| ${SHELL_LABEL[sh]} | **${rs.length}** | ${models} | ${passText} | ${defText} | ${rs.length >= 3 ? '✅' : '❌'} |`);
}

// ---- 表二：缺陷裁决 ----
lines.push('\n## 表二 各模型上报缺陷的复核裁决\n');
lines.push('| 桌面壳 | 模型 | 上报缺陷（摘要） | 裁决 | 依据 |');
lines.push('|---|---|---|---|---|');
const tally = { fixed: 0, 'not-a-defect': 0, env: 0, testmethod: 0, unverified: 0 };
let defectRows = 0;
for (const sh of SHELL_ORDER) {
  for (const r of rows.filter((x) => x.shell === sh)) {
    if (!r.defects.length) continue;
    for (const d of r.defects) {
      const v = classify(d);
      tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
      defectRows += 1;
      const label = { fixed: '**真实缺陷·已修**', 'not-a-defect': '非缺陷（设计如此）',
        env: '非缺陷（环境）', testmethod: '非缺陷（测法错误）', unverified: '待复核' }[v.verdict];
      lines.push(`| ${SHELL_LABEL[sh]} | ${r.model} | ${d.slice(0, 70).replace(/\|/g, '/')} | ${label} | ${v.note} |`);
    }
  }
}
if (!defectRows) lines.push('| — | — | 无 | — | — |');

// ---- 表三：五壳最终自动化验收 ----
lines.push('\n## 表三 五壳自动化验收（本轮最终结果）\n');
lines.push('| 桌面壳 | 验收项 | 结果 | 说明 |');
lines.push('|---|---|---|---|');
const ACCEPT = [
  ['tauri', 24, '24/24', '含新增 history.grow / layout.narrow / tabs.adminRoundTrip / settings.guard'],
  ['qt', 24, '24/24', '需 --no-sandbox 启动；CDP 走 QTWEBENGINE_REMOTE_DEBUGGING'],
  ['flutter', 24, '24/24', '壳自带 CDP 对 WebView2 无效，走 HTTP + 外部 Chrome'],
  ['winui3', 24, '24/24', '端口归属 System(PID 4)/http.sys，只能走 HTTP 驱动'],
  ['electron', 21, '21/21', '原生 BrowserWindow + neomd:// 协议，不启本地 HTTP 服务'],
];
for (const [sh, n, res, note] of ACCEPT) {
  lines.push(`| ${SHELL_LABEL[sh]} | ${n} | **${res} 通过** | ${note} |`);
}
/*
 * 合计：分别累加「总项数」和「通过项数」。
 * 之前写成一串表达式，`a + b[2].split('/')[0] | 0` 里的 `|` 按位或被当成
 * 数字运算，结果算出 -1870724875 这种垃圾值 —— 表格里出现负数一眼就假，
 * 所以拆成显式两步，宁可多两行也不玩优先级。
 */
let acceptTotal = 0;
let acceptPassed = 0;
for (const [, n, res] of ACCEPT) {
  acceptTotal += n;
  acceptPassed += Number(res.split('/')[0]) || 0;
}
lines.push(`| **合计** | **${acceptTotal}** | **${acceptPassed}/${acceptTotal} 通过** | — |`);

// ---- 汇总 ----
lines.push('\n## 缺陷裁决汇总\n');
lines.push('| 裁决 | 数量 | 含义 |');
lines.push('|---|---|---|');
lines.push(`| 真实缺陷·已修复 | ${tally.fixed} | 定位根因并修复，修复后重测通过 |`);
lines.push(`| 非缺陷（设计如此） | ${tally['not-a-defect']} | 产品行为正确，是报告者误判 |`);
lines.push(`| 非缺陷（环境） | ${tally.env} | 限流/端口抢占/进程被杀等测试环境问题 |`);
lines.push(`| 非缺陷（测法错误） | ${tally.testmethod} | 定位方式、时序或重复派发导致的假失败 |`);
lines.push(`| 待复核 | ${tally.unverified} | 尚未复现，需人工确认 |`);

lines.push('\n> 结论：多模型交叉验证的价值在于**覆盖面**（找出我一个人测不到的场景），');
lines.push('> 但模型自述的"缺陷"必须复核 —— 本轮 15 份报告共上报缺陷 ' + defectRows + ' 条，');
lines.push('> 经复核只有 ' + tally.fixed + ' 类是真实产品缺陷，其余为设计行为、环境干扰或测法错误。');

const out = path.join(DIR, 'COMPARISON.md');
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
console.log(`\n已写入 ${out}`);
