/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：17 | 分组：日常使用 · 写作与整理
 * id: quote-collector | 命令: writing.quoteCards
 * 说明：提取全文引用块内容，去重后生成编号金句摘录卡区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:quote-collector -->';
const END = '<!-- /nm:quote-collector -->';

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

export default {
  id: 'quote-collector',
  name: '金句摘录卡',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.quoteCards',
      title: '汇总全文引用生成金句摘录卡',
      run() {
        const md = api.getMarkdown() || '';
        const seen = new Set();
        const quotes = [];
        for (const line of bodyLines(stripSection(md))) {
          if (!/^\s{0,3}>/.test(line)) continue;
          const text = line.replace(/^\s{0,3}>\s?/, '').trim();
          if (!text || /^[-=*_]{3,}$/.test(text)) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          quotes.push(text);
        }
        if (quotes.length === 0) {
          api.notify('当前文档没有引用块（>），未生成摘录卡', 'info');
          return;
        }
        const cap = 30;
        const rows = ['## 📌 金句摘录卡', ''];
        quotes.slice(0, cap).forEach((q, i) => {
          rows.push((i + 1) + '. 「' + q + '」');
        });
        rows.push('');
        rows.push('- 共收录 ' + quotes.length + ' 条引用');
        if (quotes.length > cap) rows.push('- 超出 ' + cap + ' 条已截断');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已收录 ' + quotes.length + ' 条金句', 'success');
      }
    });
  }
};
