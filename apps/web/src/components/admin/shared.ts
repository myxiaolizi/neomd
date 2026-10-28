/**
 * 后台管理端各模块共用的小工具（1.1.9 拆分 components/admin/* 时抽出）。
 *
 * 为什么单独建文件而不是复制到每个组件：
 *  - 时间/百分比格式化最容易出现「这个模块显示 2026-10-29、那个显示 2026/10/29」的不一致；
 *  - 纯函数不依赖组件状态，放在这里可以被任何模块 import，也方便单独测试。
 */

/** 统一时间格式：`YYYY-MM-DD HH:mm`（空值统一显示 —，避免表格里出现 null） */
export function fmtTime(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：用于「上次使用」这类需要一眼看出新鲜度的字段 */
export function fmtAgo(value: unknown): string {
  if (!value) return '从未使用';
  const t = new Date(String(value)).getTime();
  if (!Number.isFinite(t)) return String(value);
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/** 比率（0~1）转百分比文本，默认 1 位小数；0 直接显示 0%，避免「0.0%」的噪声 */
export function pct(ratio: number, digits = 1): string {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n === 0) return '0%';
  return `${(n * 100).toFixed(digits)}%`;
}

/** 延迟文本：>=1000ms 显示秒，避免大数字挤爆指标卡 */
export function fmtLatency(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

/** 令牌状态徽章文案与配色变体 */
export function tokenStatusLabel(status: string): { text: string; variant: string } {
  switch (status) {
    case 'active':
      return { text: '有效', variant: 'ok' };
    case 'revoked':
      return { text: '已吊销', variant: 'danger' };
    case 'expired':
      return { text: '已过期', variant: 'warn' };
    default:
      return { text: status || '未知', variant: 'muted' };
  }
}

/**
 * 把风险信号翻译成中文短语（后台令牌治理用）。
 * 后端只给稳定的英文信号名，文案放在前端，便于以后调整措辞而不用改接口。
 */
export const RISK_SIGNAL_LABELS: Record<string, string> = {
  owner_disabled: '账号已停用',
  write_scope: '可写权限',
  never_expires: '永不过期',
  never_used: '从未使用',
  stale: '超 90 天未用',
};

/** 风险等级对应的中文与配色 */
export function riskLevelLabel(level: string): { text: string; variant: string } {
  switch (level) {
    case 'high':
      return { text: '高风险', variant: 'danger' };
    case 'medium':
      return { text: '需关注', variant: 'warn' };
    default:
      return { text: '正常', variant: 'ok' };
  }
}

/** 数字压缩展示（k / w），用于看板大数字 */
export function fmtCount(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}
