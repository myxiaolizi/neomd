/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：14 | 分组：日常使用 · 写作与整理
 * id: toc-regenerate | 命令: writing.toc
 * 说明：读取标题层级，重新生成带缩进的目录区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:toc-regenerate -->';
const END = '<!-- /nm:toc-regenerate -->';

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

/** 生成 GFM 锚点：小写、去标点、空格转短横线 */
function anchorOf(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()#!]/g, '')
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export default {
  id: 'toc-regenerate',
  name: '目录重建',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.toc',
      title: '根据标题重新生成文档目录',
      run() {
        const md = api.getMarkdown() || '';
        const heads = [];
        for (const line of bodyLines(stripSection(md))) {
          const m = /^(#{1,6})\s+(.*)$/.exec(line);
          if (!m) continue;
          const level = m[1].length;
          const text = m[2].trim();
          if (!text) continue;
          heads.push({ level, text });
        }
        if (heads.length === 0) {
          api.notify('文档中没有标题，未生成目录', 'info');
          return;
        }
        const minLevel = Math.min(...heads.map((h) => h.level));
        const rows = ['## 📑 目录', ''];
        for (const h of heads.slice(0, 80)) {
          const indent = '  '.repeat(Math.max(0, h.level - minLevel));
          const label = h.text.replace(/\|/g, '\\|');
          rows.push(indent + '- [' + label + '](#' + anchorOf(h.text) + ')');
        }
        if (heads.length > 80) rows.push('- …等 ' + heads.length + ' 个标题');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已根据 ' + heads.length + ' 个标题重建目录', 'success');
      }
    });
  }
};
