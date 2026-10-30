/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：11 | 分组：日常使用 · 写作与整理
 * id: word-count-badge | 命令: writing.wordStats
 * 说明：统计字数、词数、段落数与预计阅读时长，生成字数仪表盘区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:word-count-badge -->';
const END = '<!-- /nm:word-count-badge -->';

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

function countCjk(s) {
  const m = String(s || '').match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function countEn(s) {
  const m = String(s || '').match(/[A-Za-z][A-Za-z'-]*/g);
  return m ? m.length : 0;
}

export default {
  id: 'word-count-badge',
  name: '字数仪表盘',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.wordStats',
      title: '生成字数词数与阅读时长仪表盘',
      run() {
        const md = api.getMarkdown() || '';
        const body = stripSection(md);
        const lines = bodyLines(body);
        const text = lines.join('\n');
        if (text.replace(/\s/g, '').length === 0) {
          api.notify('文档为空，未生成字数仪表盘', 'info');
          return;
        }
        const cjk = countCjk(text);
        const en = countEn(text);
        const chars = (text.match(/[^\s]/g) || []).length;
        const paragraphs = lines.filter((l) => l.trim() && !/^#{1,6}\s/.test(l)).length;
        const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
        const words = cjk + en;
        const minutes = Math.max(1, Math.round(words / 350));
        const rows = [];
        rows.push('## 📝 字数仪表盘');
        rows.push('');
        rows.push('| 指标 | 数值 |');
        rows.push('| --- | --- |');
        rows.push('| 中文字数 | ' + cjk + ' |');
        rows.push('| 英文单词 | ' + en + ' |');
        rows.push('| 合计字词 | ' + words + ' |');
        rows.push('| 非空白字符 | ' + chars + ' |');
        rows.push('| 正文段落 | ' + paragraphs + ' |');
        rows.push('| 标题数量 | ' + headings + ' |');
        rows.push('| 预计阅读 | ' + minutes + ' 分钟 |');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('共 ' + words + ' 字词，预计阅读 ' + minutes + ' 分钟', 'success');
      }
    });
  }
};
