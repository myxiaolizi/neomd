/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：49 | 分组：协作 · 分派与交付
 * id: share-summary | 命令: collab.shareSummary
 * 说明：提炼标题、要点与待办数量，生成分享摘要卡片区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:share-summary -->';
const END = '<!-- /nm:share-summary -->';

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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
  id: 'share-summary',
  name: '分享摘要卡片',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.shareSummary',
      title: '提炼标题与要点生成分享摘要',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名文档）';
        const lines = bodyLines(stripSection(md));
        const heads = [];
        const bullets = [];
        let open = 0;
        for (const line of lines) {
          if (/^##\s+/.test(line)) {
            const t = line.replace(/^##\s+/, '').replace(/^[一二三四五六七八九十\d]+[、.]\s*/, '').trim();
            if (t) heads.push(t);
          } else if (/^\s*[-*+]\s+/.test(line)) {
            const t = line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\[[xX ]\]\s*/, '').replace(/\s+/g, ' ').trim();
            if (t) bullets.push(t);
            if (/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) open += 1;
          }
        }
        if (heads.length === 0 && bullets.length === 0) {
          api.notify('文档缺少章节与要点，未生成分享摘要', 'info');
          return;
        }
        const points = [];
        for (const h of heads) {
          if (points.length >= 3) break;
          if (!points.includes(h)) points.push(h);
        }
        for (const b of bullets) {
          if (points.length >= 3) break;
          if (!points.includes(b) && b.length <= 60) points.push(b);
        }
        const rows = ['## 🔗 分享摘要 · ' + title, ''];
        rows.push('> ' + (points.length > 0 ? points.join('；') : '暂无要点') + '。');
        rows.push('');
        rows.push('**要点**');
        if (points.length === 0) rows.push('- 暂无');
        else points.forEach((p, i) => rows.push((i + 1) + '. ' + p));
        rows.push('');
        rows.push('| 项 | 值 |');
        rows.push('| --- | --- |');
        rows.push('| 章节数 | ' + heads.length + ' |');
        rows.push('| 未完成待办 | ' + open + ' 项 |');
        rows.push('| 生成日期 | ' + todayIso() + ' |');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成分享摘要（' + points.length + ' 个要点）', 'success');
      }
    });
  }
};
