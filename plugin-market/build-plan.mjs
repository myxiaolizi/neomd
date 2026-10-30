/**
 * 由 plan-source.mjs 生成 plugin-market/PLAN.json（唯一可被机器消费的契约）。
 *
 *   node plugin-market/build-plan.mjs
 *
 * 生成的 PLAN.json 包含每款插件的全部元数据与自动生成的 README，
 * 供 validate.mjs（校验）、deploy/seed。（生产入库）与市场发布共用。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGINS, GROUPS } from './plan-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const MODE_LABEL = {
  section: '维护文末标记区块，重复执行只刷新区块内容。',
  inplace: '就地改写正文，重复执行结果一致。',
  append: '每次执行在文末追加一份新模板。'
};

function slug(nn, id) {
  return `${nn}-${id}.js`;
}

function readme(p) {
  const [nn, id, name, group, category, icon, commandId, commandTitle, mode, description] = p;
  const lines = [
    `# ${name}`,
    '',
    description,
    '',
    '## 使用方式',
    '',
    '1. 安装并启用插件；',
    `2. 在编辑器命令面板（\`Ctrl+P\`）中搜索「${name}」或直接执行命令 \`${commandId}\`；`,
    `3. 命令标题：${commandTitle}。`,
    '',
    '## 行为说明',
    '',
    `- 输出模式：\`${mode}\` —— ${MODE_LABEL[mode]}`,
    '- 仅使用宿主提供的 `getMarkdown` / `setMarkdown` / `insertMarkdown` / `getTitle` / `notify` / `registerCommand` 六个 API；',
    '- 跳过围栏代码块内容，兼容 CRLF 与 BOM；空文档不会报错；',
    '- 不发起任何网络请求，不访问 DOM 与本地存储。',
    '',
    '## 元信息',
    '',
    `- 插件标识：\`${id}\``,
    `- 版本：1.0.0`,
    `- 分类：${category}`,
    `- 图标：${icon}`,
    `- 分组：${GROUPS[group].name}`,
    ''
  ];
  return lines.join('\n');
}

const items = PLUGINS.map((p) => {
  const [nn, id, name, group, category, icon, commandId, commandTitle, mode, description] = p;
  return {
    nn,
    file: slug(nn, id),
    id,
    name,
    group,
    groupName: GROUPS[group].name,
    category,
    icon,
    commandId,
    commandTitle,
    mode,
    description,
    readme: readme(p)
  };
});

// 一致性硬校验：序号连续、id 唯一、commandId 唯一
const seenId = new Set();
const seenCmd = new Set();
const problems = [];
items.forEach((it, i) => {
  const expect = String(i + 1).padStart(2, '0');
  if (it.nn !== expect) problems.push(`第 ${i + 1} 条序号为 ${it.nn}，应为 ${expect}`);
  if (seenId.has(it.id)) problems.push(`插件 id 重复：${it.id}`);
  if (seenCmd.has(it.commandId)) problems.push(`命令 id 重复：${it.commandId}`);
  seenId.add(it.id);
  seenCmd.add(it.commandId);
  if (it.description.length < 2 || it.description.length > 500) problems.push(`${it.id} 简介长度非法：${it.description.length}`);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(it.id)) problems.push(`${it.id} 不符合 id 规范`);
  if (it.commandTitle.length > 28) problems.push(`${it.id} 命令标题超过 28 字符：${it.commandTitle.length}`);
  if (!['section', 'inplace', 'append'].includes(it.mode)) problems.push(`${it.id} mode 非法`);
});

if (problems.length) {
  console.error('PLAN 契约自校验失败：');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}

const plan = {
  schema: 'neomd.community-plugin-plan/1',
  suiteVersion: '1.3.0',
  total: items.length,
  groups: Object.entries(GROUPS).map(([g, v]) => ({ group: Number(g), ...v })),
  plugins: items
};

writeFileSync(join(here, 'PLAN.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
console.log(`PLAN.json 已生成：${items.length} 款插件，${plan.groups.length} 个分组`);
