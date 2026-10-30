import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const badDir = join(here, 'bad');
const MAX_BYTES = 12 * 1024;
const entry = {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  commandId: 'writing.todoProgress',
  commandTitle: '统计待办完成率并生成进度条',
  mode: 'section'
};
const forbidden = [[/\bfetch\s*\(/, '禁用标识符 fetch()']];
const apiWhitelist = new Set(['getMarkdown', 'setMarkdown', 'insertMarkdown', 'getTitle', 'notify', 'registerCommand']);

function makeHost(initial) {
  const state = { doc: initial, notices: [], commands: [] };
  return {
    state,
    api: {
      getMarkdown: () => state.doc,
      setMarkdown: (next) => { state.doc = String(next ?? ''); },
      insertMarkdown: (text) => { state.doc += String(text ?? ''); },
      getTitle: () => '自检文档',
      notify: (message, type = 'info') => { state.notices.push({ message, type }); },
      registerCommand: (command) => {
        state.commands.push(command);
        if (command && typeof command.run === 'function') command.run();
      }
    }
  };
}

function checkStatic(file, src) {
  const errors = [];
  if (statSync(file).size > MAX_BYTES) errors.push(`文件超过 ${MAX_BYTES} 字节`);
  for (const [pattern, label] of forbidden) if (pattern.test(src)) errors.push(label);
  const commandCount = (src.match(/registerCommand\s*\(/g) || []).length;
  if (commandCount !== 1) errors.push(`registerCommand 出现 ${commandCount} 次`);
  const apiCalls = [...src.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  for (const name of new Set(apiCalls)) if (!apiWhitelist.has(name)) errors.push(`未白名单 API: api.${name}`);
  if (!src.includes(`id: '${entry.id}'`) && !src.includes(`id: "${entry.id}"`)) errors.push(`源码 id 与 PLAN 不一致，应为 ${entry.id}`);
  return errors;
}

async function checkRuntime(file, initial = '# 自检\n\n- [ ] 任务\n') {
  const errors = [];
  let mod;
  try {
    mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
  } catch (error) {
    return [`模块加载失败: ${error.message}`];
  }
  if (mod?.id !== entry.id) errors.push(`导出 id 与 PLAN 不一致: ${mod?.id}`);
  try {
    const host = makeHost(initial);
    mod.setup(host.api);
    if (host.state.commands.length !== 1) errors.push(`运行时注册 ${host.state.commands.length} 个命令`);
  } catch (error) {
    errors.push(`run() 抛异常: ${error.message}`);
  }
  return errors;
}

async function checkIdempotence(file) {
  const errors = [];
  const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
  const first = makeHost('# 自检\n\n- [ ] 任务\n');
  const second = makeHost('');
  try {
    mod.setup(first.api);
    second.state.doc = first.state.doc;
    mod.setup(second.api);
    if (second.state.doc !== first.state.doc) errors.push('section 模式二次执行结果不同');
  } catch (error) {
    errors.push(`幂等检查执行抛异常: ${error.message}`);
  }
  return errors;
}

async function checkMarkers(file) {
  const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
  const host = makeHost('# 自检\n');
  const errors = [];
  try {
    mod.setup(host.api);
    const begin = `<!-- nm:${entry.id} -->`;
    const end = `<!-- /nm:${entry.id} -->`;
    const begins = host.state.doc.split(begin).length - 1;
    const ends = host.state.doc.split(end).length - 1;
    if (begins !== 1 || ends !== 1) errors.push(`section 标记不成对：BEGIN ${begins}，END ${ends}`);
  } catch (error) {
    errors.push(`标记检查执行抛异常: ${error.message}`);
  }
  return errors;
}

const scenarios = [
  ['源码出现 fetch(', 'fetch-call.js', async (file, src) => checkStatic(file, src)],
  ['注册 2 个命令', 'two-commands.js', async (file, src) => checkStatic(file, src)],
  ['section 模式不幂等', 'non-idempotent-section.js', async (file) => checkIdempotence(file)],
  ['文件 > 12KB', 'oversize-file.js', async (file, src) => checkStatic(file, src)],
  ['run() 抛异常', 'run-throws.js', async (file) => checkRuntime(file)],
  ['id 与 PLAN 不一致', 'plan-id-mismatch.js', async (file, src) => [...checkStatic(file, src), ...await checkRuntime(file)]],
  ['调用 api.save(...)', 'api-save-call.js', async (file, src) => checkStatic(file, src)],
  ['只有 BEGIN 标记没有 END 标记', 'missing-section-end.js', async (file) => checkMarkers(file)]
];

let failures = 0;
for (const [scenario, name, inspect] of scenarios) {
  const file = join(badDir, name);
  const src = readFileSync(file, 'utf8');
  const errors = await inspect(file, src);
  const ok = errors.length > 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${scenario} | ${name}${ok ? ` | ${errors.join('；')}` : ' | 未识别违规'}`);
  if (!ok) failures += 1;
}

let officialOk = false;
try {
  execFileSync(process.execPath, [join(root, 'validate.mjs'), '--only', '12'], { cwd: root, stdio: 'pipe' });
  officialOk = true;
} catch (error) {
  const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
  console.log(`FAIL | 正式校验器合格样例 | ${output || error.message}`);
  failures += 1;
}
if (officialOk) console.log('PASS | 正式校验器合格样例 | validate.mjs --only 12 退出码为 0');
console.log(`自检完成：${scenarios.length + 1 - failures}/${scenarios.length + 1} 项通过${failures ? `，失败 ${failures} 项` : ''}`);
process.exit(failures ? 1 : 0);
