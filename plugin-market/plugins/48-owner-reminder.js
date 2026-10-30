/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：48 | 分组：协作 · 分派与交付
 * id: owner-reminder | 命令: collab.ownerRemind
 * 说明：汇总未完成且标注负责人的任务，按负责人生成催办清单。
 * 模式：section
 */
const BEGIN = '<!-- nm:owner-reminder -->';
const END = '<!-- /nm:owner-reminder -->';

function stripSection(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e <= b) return text;
  return (text.slice(0, b) + text.slice(e + END.length)).replace(/\n{3,}/g, '\n\n');
}

function upsertSection(md, block) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) {
    return text.slice(0, b + BEGIN.length) + '\n' + block.trim() + '\n' + text.slice(e);
  }
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + BEGIN + '\n' + block.trim() + '\n' + END + '\n';
}

function bodyLines(md) {
  const out = [];
  let fence = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out;
}

function firstMention(line) {
  const m = /@([\u4e00-\u9fffA-Za-z0-9_-]{1,20})/.exec(line);
  return m ? m[1] : '';
}

export default {
  id: 'owner-reminder',
  name: '任务催办清单',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.ownerRemind',
      title: '按负责人汇总未完成催办清单',
      run() {
        const md = api.getMarkdown() || '';
        const groups = new Map();
        let noOwner = 0;
        for (const line of bodyLines(stripSection(md))) {
          if (!/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) continue;
          const owner = firstMention(line);
          const text = line
            .replace(/^\s*[-*+]\s+\[\s*\]\s+/, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!owner) {
            noOwner += 1;
            continue;
          }
          if (!groups.has(owner)) groups.set(owner, []);
          groups.get(owner).push(text);
        }
        if (groups.size === 0) {
          api.notify('未找到「未完成待办 + @负责人」的条目，未生成催办清单', 'info');
          return;
        }
        const owners = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
        const rows = ['## 📮 任务催办清单', ''];
        for (const o of owners) {
          const list = groups.get(o);
          rows.push('### @' + o + '（' + list.length + ' 项）');
          rows.push('');
          for (const t of list.slice(0, 10)) rows.push('- [ ] ' + t);
          if (list.length > 10) rows.push('- …等 ' + list.length + ' 项');
          rows.push('');
        }
        rows.push('- 待催办总数：' + owners.reduce((s, o) => s + groups.get(o).length, 0) + ' 项');
        if (noOwner > 0) rows.push('- 另有 ' + noOwner + ' 项未指派负责人，建议补上 @负责人');
        api.setMarkdown(upsertSection(md, rows.join('\n').trim()));
        api.notify('已汇总 ' + owners.length + ' 位负责人的催办清单', 'success');
      }
    });
  }
};
