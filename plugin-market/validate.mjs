/**
 * Neo MD 社区插件校验器
 *
 *   node plugin-market/validate.mjs                # 校验全部 50 款
 *   node plugin-market/validate.mjs --group 2      # 只校验第 2 组
 *   node plugin-market/validate.mjs --only 05      # 只校验序号 05
 *   node plugin-market/validate.mjs --json         # 额外输出机读报告路径
 *
 * 校验维度（任一失败即 FAIL）：
 *   A 文件   命名 / 大小 / 末尾换行 / 文件头注释
 *   B 静态   单一默认导出 / 单一 registerCommand / 禁用标识符 / api 白名单 / 无 import
 *   C 契约   源码内 id·name·version·commandId·commandTitle 与 PLAN.json 逐字一致
 *   D 运行   四类样本文档均不抛异常、notify 恰好一次、输出不损坏正文
 *   E 幂等   section / inplace 连续两次执行结果完全一致
 *   F 结构   section 模式标记成对且唯一
 */
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(here, 'plugins');
const reportsDir = join(here, 'reports');
const plan = JSON.parse(readFileSync(join(here, 'PLAN.json'), 'utf8'));

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const onlyGroup = argOf('--group') ? Number(argOf('--group')) : null;
const onlyNN = argOf('--only') || null;
const wantJson = argv.includes('--json');

const MAX_BYTES = 12 * 1024;
const MAX_TITLE = 28;

/* ------------------------------- 样本文档 ------------------------------- */

const DOC_RICH = [
  '---',
  'title: 项目周会纪要',
  'tags: [协作, 会议]',
  '---',
  '',
  '# 项目周会纪要',
  '',
  '本周完成登录重构与同步修复，遗留 3 项待跟进。',
  '',
  '## 一、进展',
  '',
  '- [x] 完成登录模块重构 @张三 2026-10-28',
  '- [ ] 补齐同步冲突用例 @李四 2026-11-02 P1',
  '- [ ] 评审插件市场文案 P0',
  '- [x] 修复移动端滚动抖动',
  '',
  '### 1.1 细节',
  '',
  '1. 首项说明',
  '1. 第二项说明',
  '7. 序号错乱项',
  '',
  '> 决策：本周五前完成插件市场上架。',
  '> 结论：沿用现有部署流程。',
  '',
  '| 事项 | 负责人 | 截止 |',
  '| --- | --- | --- |',
  '| 上架插件 | 张三 | 2026-11-01 |',
  '| 回归测试 | 李四 | 2026-11-03 |',
  '',
  '### 1.1.1 深层标题',
  '',
  '```js',
  '# 这不是标题',
  '- [ ] 这不是待办 P0',
  '> 这不是引用',
  '---',
  '```',
  '',
  '~~~',
  '## 代码里的二级标题',
  '1. 代码里的列表',
  '~~~',
  '',
  '风险：第三方依赖升级可能影响构建。',
  '',
  '***',
  '',
  '**加粗** 与 *斜体* 混用（中文括号)混用,逗号.',
  '',
  '## 二、会后行动',
  '',
  '- [ ] 输出测试报告 @王五 2026-10-31',
  ''
].join('\r\n');

const DOC_EMPTY = '';
const DOC_MIN = '# 标题\n';
const DOC_CODEONLY = [
  '```md',
  '# 假标题',
  '- [ ] 假待办',
  '| a | b |',
  '| --- | --- |',
  '---',
  '```',
  ''
].join('\n');
const DOC_BIG = (() => {
  const rows = [];
  for (let i = 1; i <= 220; i++) {
    rows.push(`- [${i % 3 === 0 ? 'x' : ' '}] 任务 ${i} @成员${i % 5} 2026-11-${String((i % 28) + 1).padStart(2, '0')} P${i % 3}`);
  }
  return ['# 大文档', '', ...rows, ''].join('\n');
})();

const FIXTURES = [
  { name: 'rich', doc: DOC_RICH, expectChange: true },
  { name: 'empty', doc: DOC_EMPTY, expectChange: false },
  { name: 'minimal', doc: DOC_MIN, expectChange: false },
  { name: 'codeonly', doc: DOC_CODEONLY, expectChange: false },
  { name: 'big', doc: DOC_BIG, expectChange: true }
];

/* ------------------------------ 静态规则表 ------------------------------ */

const FORBIDDEN = [
  [/\bdocument\b/, 'DOM document'],
  [/\bwindow\b/, 'DOM window'],
  [/\bnavigator\b/, 'navigator'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\balert\s*\(/, 'alert()'],
  [/\bconfirm\s*\(/, 'confirm()'],
  [/\bprompt\s*\(/, 'prompt()'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/WebSocket/, 'WebSocket'],
  [/\baxios\b/, 'axios'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bindexedDB\b/, 'indexedDB'],
  [/\bFileReader\b/, 'FileReader'],
  [/\bWorker\b/, 'Worker'],
  [/\bBlob\b/, 'Blob'],
  [/\bURL\.createObjectURL\b/, 'URL.createObjectURL'],
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function/, 'new Function'],
  [/\brequire\s*\(/, 'require()'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/^\s*import\s+[\w{*]/m, 'ES import 语句'],
  [/\bsetTimeout\b/, 'setTimeout'],
  [/\bsetInterval\b/, 'setInterval'],
  [/requestAnimationFrame/, 'requestAnimationFrame'],
  [/\bPromise\b/, 'Promise'],
  [/\basync\b/, 'async'],
  [/\bawait\b/, 'await'],
  [/\bmodule\.exports\b/, 'module.exports'],
  [/\bexports\./, 'exports.']
];

const API_WHITELIST = new Set(['getMarkdown', 'setMarkdown', 'insertMarkdown', 'getTitle', 'notify', 'registerCommand']);

/* ------------------------------- 运行环境 ------------------------------- */

function makeHost(initial) {
  const state = { doc: initial, notices: [], commands: [] };
  const api = {
    getMarkdown: () => state.doc,
    setMarkdown: (next) => {
      state.doc = String(next ?? '');
    },
    insertMarkdown: (snippet) => {
      state.doc = `${state.doc}${snippet ?? ''}`;
    },
    getTitle: () => '项目周会纪要',
    notify: (msg, type = 'info') => {
      state.notices.push({ msg: String(msg ?? ''), type });
    },
    registerCommand: (cmd) => {
      state.commands.push(cmd);
      // 与真实宿主一致：注册即执行
      if (cmd && typeof cmd.run === 'function') cmd.run();
    }
  };
  return { api, state };
}

/** 执行一次命令，返回 { doc, notices, command } */
function execute(mod, initial) {
  const { api, state } = makeHost(initial);
  mod.setup(api);
  return {
    doc: state.doc,
    notices: state.notices,
    commands: state.commands
  };
}

/* -------------------------------- 单款校验 -------------------------------- */

function checkPlugin(entry) {
  const r = { id: entry.id, nn: entry.nn, name: entry.name, group: entry.group, checks: [], errors: [], warnings: [] };
  const fail = (stage, msg) => r.errors.push(`[${stage}] ${msg}`);
  const pass = (stage) => r.checks.push(stage);

  const path = join(pluginsDir, entry.file);
  if (!existsSync(path)) {
    fail('A', `缺少文件 plugins/${entry.file}`);
    return r;
  }

  // A 文件
  const raw = readFileSync(path);
  if (raw.length > MAX_BYTES) fail('A', `文件 ${raw.length} 字节，超过 ${MAX_BYTES} 上限`);
  const src = raw.toString('utf8');
  if (!src.endsWith('\n')) fail('A', '文件末尾缺少换行');
  if (src.includes('\r\n')) fail('A', '文件包含 CRLF，应为 LF');
  if (!/^\/\*\*[\s\S]*?\*\//.test(src)) fail('A', '缺少文件头注释块');
  if (!src.includes(`编号：${entry.nn}`)) fail('A', `文件头注释缺少「编号：${entry.nn}」`);
  if (!src.includes(`id: ${entry.id} `) && !src.includes(`id: ${entry.id} |`) && !src.includes(`id: ${entry.id}\n`)) {
    fail('A', `文件头注释缺少「id: ${entry.id}」`);
  }
  pass('A');

  // B 静态
  // 去掉注释与字符串字面量后再扫禁用标识符，避免注释里出现关键词造成误报
  const srcNoComment = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const [re, label] of FORBIDDEN) {
    if (re.test(srcNoComment)) fail('B', `出现禁用标识符：${label}`);
  }
  // 检查所有对宿主对象的调用（兼容 api.x / api?.x / api['x'] 三种写法）
  const apiCalls = [
    ...[...srcNoComment.matchAll(/\bapi\s*\??\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...srcNoComment.matchAll(/\bapi\s*\??\.\s*\[\s*['"`]([A-Za-z_$][\w$]*)['"`]\s*\]/g)].map((m) => m[1])
  ];
  for (const name of new Set(apiCalls)) {
    if (!API_WHITELIST.has(name)) fail('B', `调用了宿主未提供的 api.${name}`);
  }
  if (/\bapi\s*\[(?!\s*['"`])/.test(srcNoComment)) fail('B', '使用动态下标访问 api，无法静态校验');
  const cmdCount = (srcNoComment.match(/registerCommand\s*\(/g) || []).length;
  if (cmdCount !== 1) fail('B', `registerCommand 出现 ${cmdCount} 次，必须恰好 1 次`);
  const defaultCount = (srcNoComment.match(/export\s+default/g) || []).length;
  if (defaultCount !== 1) fail('B', `export default 出现 ${defaultCount} 次，必须恰好 1 次`);
  if (!/\bfunction\s+setup\s*\(|\bsetup\s*\(api\)|setup\s*:\s*function/.test(srcNoComment)) fail('B', '缺少 setup 函数');
  pass('B');

  // C 契约（源码逐字一致）
  const expectPair = [
    [`id: '${entry.id}'`, `id: '${entry.id}'`],
    [`id: "${entry.id}"`, `id: "${entry.id}"`]
  ];
  if (!expectPair.some(([a, b]) => src.includes(a) || src.includes(b))) fail('C', `源码 id 与契约不一致（应为 ${entry.id}）`);
  if (!src.includes(entry.name)) fail('C', `源码 name 与契约不一致（应为 ${entry.name}）`);
  if (!src.includes(entry.commandId)) fail('C', `源码 commandId 与契约不一致（应为 ${entry.commandId}）`);
  if (!src.includes(entry.commandTitle)) fail('C', `源码 commandTitle 与契约不一致（应为 ${entry.commandTitle}）`);
  if (!/version:\s*'1\.0\.0'/.test(src)) fail('C', "version 必须为 '1.0.0'");
  if (entry.commandTitle.length > MAX_TITLE) fail('C', `命令标题 ${entry.commandTitle.length} 字，超过 ${MAX_TITLE}`);
  if (!/[，。；：、！？（）“”《》]|[\u4e00-\u9fff]/.test(entry.commandTitle)) r.warnings.push('命令标题不含中文');
  pass('C');

  // D/E/F 运行
  return { ...r, path, entry };
}

async function runBehavior(r) {
  const { entry, path } = r;
  const fail = (stage, msg) => r.errors.push(`[${stage}] ${msg}`);
  const pass = (stage) => r.checks.push(stage);
  let mod;
  try {
    mod = (await import(`${pathToFileURL(path).href}?v=${Date.now()}`)).default;
  } catch (e) {
    fail('D', `模块加载失败：${e.message}`);
    return r;
  }
  if (!mod || typeof mod !== 'object') {
    fail('D', '默认导出不是对象');
    return r;
  }
  if (mod.id !== entry.id) fail('D', `导出 id=${mod.id} 与契约 ${entry.id} 不一致`);
  if (mod.name !== entry.name) fail('D', `导出 name=${mod.name} 与契约 ${entry.name} 不一致`);
  if (mod.version !== '1.0.0') fail('D', `导出 version=${mod.version}，应为 1.0.0`);
  if (typeof mod.setup !== 'function') {
    fail('D', 'setup 不是函数');
    return r;
  }

  for (const fx of FIXTURES) {
    let out;
    try {
      out = execute(mod, fx.doc);
    } catch (e) {
      fail('D', `样本文档 ${fx.name} 执行抛异常：${e.message}`);
      continue;
    }
    if (out.commands.length !== 1) fail('D', `样本文档 ${fx.name} 注册了 ${out.commands.length} 个命令`);
    const cmd = out.commands[0];
    if (cmd && cmd.id !== entry.commandId) fail('D', `命令 id=${cmd?.id} 与契约 ${entry.commandId} 不一致`);
    if (cmd && cmd.title !== entry.commandTitle) fail('D', `命令标题与契约不一致`);
    if (out.notices.length !== 1) fail('D', `样本文档 ${fx.name} notify 调用 ${out.notices.length} 次，应为 1 次`);
    const notice = out.notices[0];
    if (notice && !['info', 'success', 'error'].includes(notice.type)) fail('D', `notify 类型非法：${notice.type}`);
    if (notice && String(notice.msg).trim().length < 2) fail('D', `notify 文案过短`);
    if (typeof out.doc !== 'string') fail('D', `样本文档 ${fx.name} 输出不是字符串`);

    if (fx.name === 'empty' && out.doc.trim() !== '') {
      // 空文档只允许产生带标记的空区块，或干脆不写
      const body = out.doc.replace(/<!--[\s\S]*?-->/g, '').trim();
      if (body.length > 0 && entry.mode !== 'append') fail('D', '空文档被写入正文内容（应仅提示或仅写标记）');
    }

    // E 幂等（rich / big）
    if ((fx.name === 'rich' || fx.name === 'big') && entry.mode !== 'append') {
      let again;
      try {
        again = execute(mod, out.doc);
      } catch (e) {
        fail('E', `样本文档 ${fx.name} 二次执行抛异常：${e.message}`);
        continue;
      }
      if (again.doc !== out.doc) fail('E', `样本文档 ${fx.name} 不幂等（连续两次执行结果不同）`);
    }

    // append 模式必须真的追加内容
    if (entry.mode === 'append' && fx.name === 'rich') {
      if (!out.doc.startsWith(fx.doc)) fail('D', 'append 模式改动了原有正文（应仅在末尾追加）');
      if (out.doc.length <= fx.doc.length) fail('D', 'append 模式未追加任何内容');
      let again;
      try {
        again = execute(mod, out.doc);
      } catch (e) {
        fail('D', `append 二次执行抛异常：${e.message}`);
      }
      if (again && again.doc.length <= out.doc.length) fail('D', 'append 模式二次执行未追加内容');
    }

    // F 区块结构
    if (entry.mode === 'section') {
      const begin = `<!-- nm:${entry.id} -->`;
      const end = `<!-- /nm:${entry.id} -->`;
      const bCount = out.doc.split(begin).length - 1;
      const eCount = out.doc.split(end).length - 1;
      const changed = out.doc !== fx.doc;
      if (!changed) {
        if (bCount !== 0 || eCount !== 0) fail('F', `未写入区块却留下标记（样本 ${fx.name}）`);
      } else {
        if (bCount !== 1) fail('F', `标记 ${begin} 出现 ${bCount} 次，应为 1 次（样本 ${fx.name}）`);
        if (eCount !== 1) fail('F', `标记 ${end} 出现 ${eCount} 次，应为 1 次（样本 ${fx.name}）`);
        const bi = out.doc.indexOf(begin);
        const ei = out.doc.indexOf(end);
        if (bi >= 0 && ei > bi) {
          const body = out.doc.slice(bi + begin.length, ei).trim();
          if (fx.name === 'rich' && body.length < 2) fail('F', '富文样本下区块内容为空');
          if (fx.name === 'codeonly' && body.length > 400) fail('F', '仅含代码块的文档生成了过大的区块（可能未跳过围栏）');
        }
      }
    }
  }
  pass('D');
  if (entry.mode !== 'append') pass('E');
  if (entry.mode === 'section') pass('F');
  return r;
}

/* ---------------------------------- 主流程 ---------------------------------- */

const targets = plan.plugins.filter((p) => {
  if (onlyNN && p.nn !== onlyNN) return false;
  if (onlyGroup !== null && p.group !== onlyGroup) return false;
  return true;
});

const results = [];
for (const entry of targets) {
  const base = checkPlugin(entry);
  if (base.path) await runBehavior(base);
  results.push(base);
}

const failed = results.filter((x) => x.errors.length > 0);
const warned = results.filter((x) => x.warnings.length > 0);

console.log('');
console.log(`Neo MD 社区插件校验 · 套件 v${plan.suiteVersion} · 目标 ${targets.length} 款`);
console.log('─'.repeat(72));
for (const r of results) {
  const ok = r.errors.length === 0;
  const tags = ok ? `通过(${r.checks.join('')})` : `失败(${r.errors.length})`;
  console.log(`${ok ? '✓' : '✗'} ${r.nn} ${r.name.padEnd(12, ' ')} ${r.id.padEnd(28, ' ')} ${tags}`);
  for (const e of r.errors) console.log(`    └─ ${e}`);
  for (const w of r.warnings) console.log(`    └─ 警告 ${w}`);
}
console.log('─'.repeat(72));
console.log(`合计 ${results.length} 款：通过 ${results.length - failed.length} · 失败 ${failed.length} · 警告 ${warned.length}`);
if (failed.length) {
  console.log('失败清单：' + failed.map((f) => f.id).join(', '));
}

if (wantJson) {
  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, 'validate-report.json');
  writeFileSync(
    file,
    JSON.stringify({ suiteVersion: plan.suiteVersion, generatedAt: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2) + '\n',
    'utf8'
  );
  console.log('机读报告：' + resolve(file));
}

process.exit(failed.length ? 1 : 0);
