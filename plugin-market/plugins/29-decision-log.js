/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：29 | 分组：日常任务 · 协作会议
 * id: decision-log | 命令: collab.decisionLog
 * 说明：收集以「决策 / 结论 / 决定」开头的条目，生成含日期、内容与依据的决策表。
 * 模式：section
 */
const BEGIN = '<!-- nm:decision-log -->';
const END = '<!-- /nm:decision-log -->';
const DEC_RE = /^(?:[-*+]\s+|\d+[.)]\s+)?\*{0,2}(决策|结论|决定)\*{0,2}\s*[:：]\s*(.+)$/;
const MAX_ITEMS = 50;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function isoOf(text) {
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (full) return full[1] + '-' + full[2] + '-' + full[3];
  const year = String(new Date().getFullYear());
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(String(text || ''));
  if (cn) return year + '-' + pad2(Number(cn[1])) + '-' + pad2(Number(cn[2]));
  return '';
}

function cell(text) {
  return String(text || '').replace(/\|/g, '\\|');
}

/** 去掉引用与列表前缀，得到纯文本行 */
function plain(line) {
  return String(line || '')
    .replace(/^\s*(?:>\s*)+/, '')
    .trim();
}

/** 拆分「依据 / 理由」部分 */
function splitBasis(text) {
  const src = String(text || '');
  const hit = /(?:依据|理由)\s*[:：]\s*(.+)$/.exec(src);
  if (!hit) return [src.replace(/\s+$/, ''), ''];
  const content = src.slice(0, hit.index).replace(/[\s；;，,。]+$/, '').trim();
  return [content || src.replace(/\s+$/, ''), hit[1].trim()];
}

function withoutSection(md) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) return text.slice(0, b) + text.slice(e + END.length);
  return text;
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

function scanOutsideFence(md, visit) {
  const lines = String(md || '').split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    visit(line, i);
  }
}

export default {
  id: 'decision-log',
  name: '决策记录',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.decisionLog',
      title: '归档全文决策记录为决策表',
      run() {
        const md = api.getMarkdown() || '';
        const items = [];
        scanOutsideFence(withoutSection(md), (line) => {
          const m = DEC_RE.exec(plain(line));
          if (!m) return;
          const parts = splitBasis(m[2].trim());
          items.push({ kind: m[1], content: parts[0], basis: parts[1], date: isoOf(parts[0]) });
        });
        if (items.length === 0) {
          api.notify('没有找到以「决策 / 结论 / 决定」开头的条目', 'info');
          return;
        }
        const out = [
          '## 📋 决策记录',
          '',
          '汇总于 ' + todayIso() + ' · 共 ' + items.length + ' 项',
          '',
          '| 日期 | 类型 | 决策内容 | 依据 |',
          '| --- | --- | --- | --- |'
        ];
        let used = 0;
        for (const item of items) {
          if (used >= MAX_ITEMS) break;
          out.push('| ' + (item.date || '—') + ' | ' + item.kind + ' | ' + cell(item.content) + ' | ' + cell(item.basis || '—') + ' |');
          used += 1;
        }
        if (items.length > used) out.push('', '> 其余 ' + (items.length - used) + ' 项已截断');
        api.setMarkdown(upsertSection(md, out.join('\n')));
        api.notify('已归档 ' + items.length + ' 条决策记录', 'success');
      }
    });
  }
};
