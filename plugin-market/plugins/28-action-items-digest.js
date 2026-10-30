/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：28 | 分组：日常任务 · 协作会议
 * id: action-items-digest | 命令: collab.actionItems
 * 说明：扫描标注了负责人或截止日期的待办，按负责人分组汇总为行动项清单区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:action-items-digest -->';
const END = '<!-- /nm:action-items-digest -->';
const TODO_RE = /^\s*[-*+]\s+\[([ xX])\]\s+/;
const OWNER_RE = /@([^\s@，,。；;：:（）()]+)/;
const MAX_ITEMS = 50;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function isoOf(text) {
  const src = String(text || '');
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(src);
  if (full) return full[1] + '-' + full[2] + '-' + full[3];
  const year = String(new Date().getFullYear());
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(src);
  if (cn) return year + '-' + pad2(Number(cn[1])) + '-' + pad2(Number(cn[2]));
  const short = /(^|[^\d-])(\d{1,2})-(\d{1,2})(?![\d-])/.exec(src);
  if (short) return year + '-' + pad2(Number(short[2])) + '-' + pad2(Number(short[3]));
  return '';
}

function cell(text) {
  return String(text || '').replace(/\|/g, '\\|');
}

/** 去掉负责人与日期，得到纯行动项描述 */
function cleanText(raw) {
  return String(raw || '')
    .replace(/@[^\s@，,。；;：:（）()]+/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·,，。;；:：\-–—]+/, '')
    .replace(/[\s·,，。;；:：\-–—]+$/, '')
    .trim();
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
  id: 'action-items-digest',
  name: '行动项汇总',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.actionItems',
      title: '汇总负责人与截止日期行动项',
      run() {
        const md = api.getMarkdown() || '';
        const groups = {};
        const order = [];
        let total = 0;
        scanOutsideFence(withoutSection(md), (line) => {
          const m = TODO_RE.exec(line);
          if (!m) return;
          const raw = line.replace(TODO_RE, '').trim();
          if (!raw) return;
          const owner = OWNER_RE.exec(raw);
          const date = isoOf(raw);
          const key = owner ? owner[1] : '';
          if (!key && !date) return;
          if (!groups[key]) {
            groups[key] = [];
            order.push(key);
          }
          groups[key].push({ text: cleanText(raw) || raw, date, done: m[1] !== ' ' });
          total += 1;
        });
        if (total === 0) {
          api.notify('没有找到带负责人或截止日期的待办，未生成行动项', 'info');
          return;
        }
        const keys = order.filter((k) => k).concat(order.indexOf('') >= 0 ? [''] : []);
        const out = ['## 📌 行动项汇总', '', '汇总于 ' + todayIso() + ' · 共 ' + total + ' 项'];
        let used = 0;
        for (const key of keys) {
          if (used >= MAX_ITEMS) break;
          const items = groups[key];
          out.push('', '### ' + (key ? '@' + key : '未指派') + '（' + items.length + ' 项）');
          out.push('', '| 行动项 | 截止 | 状态 |', '| --- | --- | --- |');
          for (const item of items) {
            if (used >= MAX_ITEMS) break;
            out.push('| ' + cell(item.text) + ' | ' + (item.date || '—') + ' | ' + (item.done ? '已完成' : '进行中') + ' |');
            used += 1;
          }
        }
        if (total > used) out.push('', '> 其余 ' + (total - used) + ' 项已截断');
        api.setMarkdown(upsertSection(md, out.join('\n')));
        api.notify('已汇总 ' + total + ' 项行动项，共 ' + keys.length + ' 位负责人', 'success');
      }
    });
  }
};
