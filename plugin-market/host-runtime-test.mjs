/**
 * Neo MD 社区插件 · 宿主真实执行路径集成测试
 *
 *   node plugin-market/host-runtime-test.mjs
 *
 * 为什么需要这个测试：
 * 校验器用的是 ESM `import()` 加载插件，但**真实宿主**（apps/web/src/views/EditorPage.vue
 * 的 runCommunityPlugin）走的是另一条路径：
 *
 *   const cleaned = item.codeJs.replace(/^\s*export\s+default\s+/, 'return ');
 *   const factory = new Function(cleaned);
 *   const mod = factory();
 *   mod.setup(hostApi);
 *
 * 这条路径对源码有额外约束（必须是合法的函数体、不能有顶层 import 等），
 * 一旦不满足就会在用户点命令时抛 SyntaxError。本测试逐条复刻该路径，
 * 并对每个插件做「真实文档 → 执行 → 断言」的端到端验证。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, 'PLAN.json'), 'utf8'));

/** 与 EditorPage.vue runCommunityPlugin 完全一致的宿主 API */
function makeHostApi(initialDoc) {
  const state = { doc: initialDoc, notices: [] };
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
      cmd?.run?.();
    }
  };
  return { api, state };
}

/** 复刻宿主执行路径（与 EditorPage.vue 的 normalizePluginSource 保持一致） */
function normalizePluginSource(codeJs) {
  const src = String(codeJs ?? '').replace(/^\uFEFF/, '');
  if (!/\bexport\s+default\b/.test(src)) return src;
  return src.replace(/^\s*export\s+default\s+/m, 'return ').replace(/\bexport\s+default\s+/, 'return ');
}

function runAsHost(codeJs, doc) {
  const cleaned = normalizePluginSource(codeJs);
  const factory = new Function(cleaned);
  const mod = factory();
  if (typeof mod?.setup !== 'function') throw new Error('导出对象缺少 setup 函数');
  const { api, state } = makeHostApi(doc);
  mod.setup(api);
  return { mod, doc: state.doc, notices: state.notices };
}

const DOCS = {
  rich: [
    '---',
    'title: 项目周会纪要',
    '---',
    '',
    '# 项目周会纪要',
    '',
    '## 一、进展',
    '',
    '- [x] 完成登录模块重构 @张三 2026-10-28',
    '- [ ] 补齐同步冲突用例 @李四 2026-11-02 P1',
    '- [ ] 评审插件市场文案 P0',
    '',
    '> 决策：本周五前完成插件市场上架。',
    '',
    '| 事项 | 负责人 | 截止 |',
    '| --- | --- | --- |',
    '| 上架插件 | 张三 | 2026-11-01 |',
    '',
    '风险：第三方依赖升级可能影响构建。',
    '',
    '```js',
    '# 代码里的标题',
    '- [ ] 代码里的待办',
    '```',
    '',
    '- [ ] 输出测试报告 @王五 2026-10-31',
    ''
  ].join('\r\n'),
  empty: '',
  codeonly: '```md\n# 假标题\n- [ ] 假待办\n```\n'
};

const results = [];
for (const p of plan.plugins) {
  const codeJs = readFileSync(join(here, 'plugins', p.file), 'utf8');
  const rec = { nn: p.nn, id: p.id, name: p.name, mode: p.mode, errors: [], samples: {} };

  for (const [name, doc] of Object.entries(DOCS)) {
    try {
      const out = runAsHost(codeJs, doc);
      if (out.mod.id !== p.id) rec.errors.push(`${name}: 导出 id=${out.mod.id} ≠ ${p.id}`);
      if (out.mod.name !== p.name) rec.errors.push(`${name}: 导出 name=${out.mod.name} ≠ ${p.name}`);
      if (out.notices.length !== 1) rec.errors.push(`${name}: notify 调用 ${out.notices.length} 次（应为 1）`);
      if (typeof out.doc !== 'string') rec.errors.push(`${name}: 输出非字符串`);
      rec.samples[name] = out.doc.length;
      if (name === 'rich') {
        // 幂等复检（走同一宿主路径）
        if (p.mode !== 'append') {
          const again = runAsHost(codeJs, out.doc);
          if (again.doc !== out.doc) rec.errors.push('rich: 连续两次执行结果不同（不幂等）');
        } else {
          const again = runAsHost(codeJs, out.doc);
          if (again.doc.length <= out.doc.length) rec.errors.push('append: 二次执行未追加内容');
        }
        // 不得吞掉或破坏原有正文。
        // 注意：SPEC 硬性要求输出统一 join('\n')，因此 inplace 模式下 CRLF→LF 是
        // 规范行为，不能拿原始字节做前缀比对。这里改为语义级断言：
        //   1) frontmatter 与一级标题必须保留；
        //   2) 非空行数量不得明显减少（允许合并空行/重排，不允许大段删除）；
        //   3) append 模式另外单独断言「原文逐字为前缀」。
        if (p.mode === 'append') {
          if (!out.doc.startsWith(doc)) rec.errors.push('append: 改动了原有正文（应仅在末尾追加）');
        } else {
          const flat = (s) => String(s).replace(/\r\n/g, '\n');
          const outFlat = flat(out.doc);
          if (!outFlat.includes('title: 项目周会纪要')) rec.errors.push('rich: 丢失了 frontmatter');
          if (!outFlat.includes('# 项目周会纪要')) rec.errors.push('rich: 丢失了一级标题');
          const nb = (s) => flat(s).split('\n').filter((l) => l.trim()).length;
          const beforeNb = nb(doc);
          const afterNb = nb(out.doc);
          if (afterNb < Math.floor(beforeNb * 0.8)) {
            rec.errors.push(`rich: 非空行从 ${beforeNb} 降到 ${afterNb}，疑似丢内容`);
          }
        }
      }
    } catch (e) {
      rec.errors.push(`${name}: ${e.constructor.name}: ${e.message}`);
    }
  }
  results.push(rec);
}

const failed = results.filter((r) => r.errors.length > 0);
console.log('Neo MD 插件 · 宿主真实执行路径集成测试（new Function + return 转换）');
console.log('─'.repeat(76));
for (const r of results) {
  const ok = r.errors.length === 0;
  console.log(`${ok ? '✓' : '✗'} ${r.nn} ${r.name.padEnd(12, ' ')} ${r.id.padEnd(28, ' ')} ${ok ? 'PASS' : 'FAIL'}`);
  for (const e of r.errors) console.log(`    └─ ${e}`);
}
console.log('─'.repeat(76));
console.log(`合计 ${results.length} 款：通过 ${results.length - failed.length} · 失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
