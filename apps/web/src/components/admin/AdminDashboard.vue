<script setup lang="ts">
/**
 * 后台数据看板。
 *
 * 图表全部用**内联 SVG 手写**（折线 + 柱状 + 环形），不引任何第三方图表库，
 * 与项目「零新依赖」约束一致。
 *
 * 交互约定：
 * - 顶部可切换 7 / 30 天区间，切换后由父级重新拉数据；
 * - 每张趋势图支持鼠标悬浮查看当天数值（用 SVG 命中区 + tooltip）；
 * - 所有数值为 0 时也能正常绘制（不出现 NaN 路径）。
 */
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { AdminCompareItem, AdminDashboard, AdminTrendPoint } from '@/api/client';

const props = defineProps<{
  data: AdminDashboard | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  /** 切换时间区间 */
  rangeChange: [number];
  /** 手动刷新 */
  refresh: [];
}>();

const days = computed(() => props.data?.range.days ?? 7);

/* ---------------- 指标卡 ---------------- */

interface MetricCard {
  key: string;
  label: string;
  value: string;
  sub: string;
  icon: string;
  tone: 'blue' | 'green' | 'violet' | 'amber' | 'rose' | 'cyan';
  /** 环比（1.1.8）：有值时在卡片右上角显示 ↑/↓ 百分比徽标 */
  compare?: AdminCompareItem;
}

/**
 * 环比徽标文案。
 * - `delta === null`：昨日为 0 且今日有值 → 显示「新增」
 * - 其余按百分比显示，保留 1 位小数
 */
function compareLabel(item: AdminCompareItem): string {
  if (item.delta === null) return '新增';
  const pct = item.delta * 100;
  if (Math.abs(pct) < 0.05) return '持平';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** 环比方向：用于着色（上升绿、下降红、持平灰） */
function compareTone(item: AdminCompareItem): 'up' | 'down' | 'flat' {
  if (item.delta === null) return 'up';
  if (Math.abs(item.delta * 100) < 0.05) return 'flat';
  return item.delta > 0 ? 'up' : 'down';
}

/** 紧凑数字：万/亿 级别用中文单位，避免指标卡被长数字撑破 */
function compact(n: number): string {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return v.toLocaleString('zh-CN');
}

/** 字节格式化：保留 1 位小数，单位分级 */
function bytes(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const scaled = v / 1024 ** i;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[i]}`;
}

const metrics = computed<MetricCard[]>(() => {
  const m = props.data?.metrics;
  if (!m) return [];
  const cmp = props.data?.compare;
  return [
    {
      key: 'users',
      label: '总用户数',
      value: compact(m.users.total),
      sub: `活跃 ${compact(m.users.active)} · 禁用 ${compact(m.users.disabled)} · 管理员 ${compact(m.users.admins)}`,
      icon: 'users',
      tone: 'blue',
    },
    {
      key: 'activeToday',
      label: '今日活跃',
      value: compact(m.users.activeToday),
      sub: `今日新增 ${compact(m.users.newToday)} · 近 7 天新增 ${compact(m.users.newThisWeek)}`,
      icon: 'zap',
      tone: 'green',
      // 环比用「今日新增 vs 昨日新增」，比「活跃」更能反映增长
      compare: cmp?.users,
    },
    {
      key: 'documents',
      label: '总文档数',
      value: compact(m.documents.total),
      sub: `仓库 ${compact(m.documents.vaults)} 个${m.documents.disabledVaults > 0 ? `（停用 ${m.documents.disabledVaults}）` : ''}`,
      icon: 'book',
      tone: 'violet',
    },
    {
      key: 'storage',
      label: '总存储占用',
      value: bytes(m.storage.bytes),
      sub: `备份 ${bytes(m.storage.backupBytes)}（${compact(m.storage.backups)} 份）`,
      icon: 'hdd',
      tone: 'amber',
    },
    {
      key: 'ai',
      label: 'AI 调用',
      value: compact(m.ai.callsTotal),
      sub: `今日 ${compact(m.ai.callsToday)} 次 · 今日消耗 ${compact(m.ai.costToday)} 积分`,
      icon: 'sparkles',
      tone: 'rose',
      compare: cmp?.ai,
    },
    {
      key: 'knowledge',
      label: '知识库查询',
      value: compact(m.knowledge.queriesTotal),
      sub: `今日 ${compact(m.knowledge.queriesToday)} 次 · 命中片段 ${compact(m.knowledge.chunksToday)}`,
      icon: 'search',
      tone: 'cyan',
      compare: cmp?.knowledge,
    },
    /* ---- 1.1.8 新增两张健康度指标卡 ---- */
    {
      key: 'aiFailRate',
      label: 'AI 失败率（今日）',
      value: `${(Number(m.ai.failRateToday ?? 0) * 100).toFixed(1)}%`,
      sub: `失败 ${compact(m.ai.errorsToday ?? 0)} 次 / 共 ${compact(m.ai.callsToday)} 次`,
      icon: 'alert',
      tone: 'rose',
    },
    {
      key: 'aiLatency',
      label: '平均响应时间',
      value: m.ai.avgLatencyToday > 0 ? `${compact(m.ai.avgLatencyToday)} ms` : '—',
      sub: '仅统计今日成功且有耗时的调用',
      icon: 'clock',
      tone: 'blue',
    },
  ];
});

/* ---------------- 趋势图（内联 SVG 折线） ---------------- */

interface LineSeries {
  key: keyof Omit<AdminTrendPoint, 'date'>;
  label: string;
  color: string;
  /** 数值是否为字节（决定 tooltip 格式） */
  isBytes?: boolean;
}

const SERIES: LineSeries[] = [
  { key: 'newUsers', label: '新增用户', color: '#3b82f6' },
  { key: 'activeUsers', label: '活跃用户', color: '#10b981' },
  { key: 'aiCalls', label: 'AI 调用', color: '#f43f5e' },
  { key: 'knowledgeQueries', label: '知识库查询', color: '#8b5cf6' },
];

/** 折线图绘制区尺寸（viewBox 坐标系，实际显示按容器宽度缩放） */
const CHART_W = 720;
const CHART_H = 220;
const PAD = { top: 16, right: 14, bottom: 26, left: 42 };

const trend = computed<AdminTrendPoint[]>(() => props.data?.trends ?? []);

/** 每个系列的路径与点坐标 */
const chartPaths = computed(() => {
  const rows = trend.value;
  const n = rows.length;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  // 所有系列共用一条 Y 轴上限，便于横向比较量级
  const maxAll = Math.max(1, ...rows.flatMap((r) => SERIES.map((s) => Number(r[s.key]) || 0)));
  return SERIES.map((s) => {
    const points = rows.map((r, i) => {
      const x = n <= 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
      const v = Number(r[s.key]) || 0;
      const y = PAD.top + innerH - (v / maxAll) * innerH;
      return { x, y, v, date: r.date };
    });
    // 平滑折线（Catmull-Rom 转三次贝塞尔），点数过少时退化为直线
    let d = '';
    if (points.length > 0) {
      d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
      for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i]!;
        const p1 = points[i + 1]!;
        const cx = (p0.x + p1.x) / 2;
        d += ` C ${cx.toFixed(2)} ${p0.y.toFixed(2)}, ${cx.toFixed(2)} ${p1.y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
      }
    }
    const area =
      points.length > 0
        ? `${d} L ${points[points.length - 1]!.x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} L ${points[0]!.x.toFixed(2)} ${(PAD.top + innerH).toFixed(2)} Z`
        : '';
    return { ...s, d, area, points };
  });
});

/** Y 轴刻度（4 条） */
const yTicks = computed(() => {
  const rows = trend.value;
  const maxAll = Math.max(1, ...rows.flatMap((r) => SERIES.map((s) => Number(r[s.key]) || 0)));
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: PAD.top + (CHART_H - PAD.top - PAD.bottom) * (1 - ratio),
    label: compact(Math.round(maxAll * ratio)),
  }));
});

/** X 轴标签：点数多时隔几个显示，避免文字重叠 */
const xTicks = computed(() => {
  const rows = trend.value;
  const n = rows.length;
  if (n === 0) return [];
  const step = Math.max(1, Math.ceil(n / 7));
  return rows
    .map((r, i) => ({ i, date: r.date }))
    .filter(({ i }) => i % step === 0 || i === n - 1)
    .map(({ i, date }) => {
      const innerW = CHART_W - PAD.left - PAD.right;
      const x = n <= 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
      return { x, label: date.slice(5) };
    });
});

/* ---------------- 悬浮提示 ---------------- */

const hover = ref<{ x: number; y: number; date: string; values: Array<{ label: string; text: string; color: string }> } | null>(null);

function onChartMove(e: MouseEvent): void {
  const rows = trend.value;
  if (rows.length === 0) return;
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  // 屏幕坐标 → viewBox 坐标
  const vx = ((e.clientX - rect.left) / rect.width) * CHART_W;
  const innerW = CHART_W - PAD.left - PAD.right;
  const ratio = Math.min(1, Math.max(0, (vx - PAD.left) / innerW));
  const idx = Math.round(ratio * (rows.length - 1));
  const row = rows[idx];
  if (!row) return;
  const x = rows.length <= 1 ? PAD.left + innerW / 2 : PAD.left + (idx / (rows.length - 1)) * innerW;
  hover.value = {
    x,
    y: PAD.top,
    date: row.date,
    values: SERIES.map((s) => ({
      label: s.label,
      text: s.isBytes ? bytes(Number(row[s.key]) || 0) : compact(Number(row[s.key]) || 0),
      color: s.color,
    })),
  };
}

function onChartLeave(): void {
  hover.value = null;
}

/* ---------------- 分布：供应商占比环形 ---------------- */

const providerTotal = computed(() => (props.data?.distributions.aiProviders ?? []).reduce((s, p) => s + p.calls, 0));

/** 环形图扇区：用 stroke-dasharray 画圆环，避免 path 弧度计算 */
const donut = computed(() => {
  const list = props.data?.distributions.aiProviders ?? [];
  const total = providerTotal.value;
  const circumference = 2 * Math.PI * 54;
  let offset = 0;
  const palette = ['#3b82f6', '#10b981', '#f43f5e', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16'];
  return list.slice(0, 8).map((p, i) => {
    const ratio = total > 0 ? p.calls / total : 0;
    const dash = ratio * circumference;
    const seg = {
      provider: p.provider,
      name: p.name,
      calls: p.calls,
      share: p.share,
      color: palette[i % palette.length]!,
      dash,
      gap: circumference - dash,
      offset,
    };
    offset += dash;
    return seg;
  });
});

/* ---------------- 状态卡 ---------------- */

const statusItems = computed(() => {
  const s = props.data?.status;
  if (!s) return [];
  return [
    {
      label: '服务健康',
      ok: s.ok,
      text: s.ok ? '正常' : '异常',
      detail: `v${s.version} · ${s.env}`,
    },
    {
      label: '数据库',
      ok: s.db.ok,
      text: s.db.ok ? '连通' : '不可用',
      detail: s.db.error ?? 'SELECT 1 正常',
    },
    {
      label: '对象存储',
      // ok 为 null 表示探测超时，用中性色
      ok: s.oss.ok === null ? 'unknown' : s.oss.ok,
      text: s.oss.ok === null ? '超时' : s.oss.ok ? '可用' : s.oss.configured ? '不可用' : '未配置',
      detail: s.oss.configured ? `${s.oss.message} · ${s.oss.latencyMs}ms` : '未配置对象存储',
    },
    {
      label: '消息队列',
      ok: 'unknown',
      text: '无队列',
      detail: '同步处理模型',
    },
    {
      label: '近 24h 审计事件',
      ok: true,
      text: compact(s.auditEvents24h),
      detail: `运行 ${Math.floor(s.uptimeSeconds / 3600)} 小时`,
    },
  ];
});

/** 运行时长可读化 */
function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}
</script>

<template>
  <div class="dash">
    <!-- 顶部：区间切换 + 刷新 -->
    <div class="dash__bar">
      <div class="dash__range">
        <button
          v-for="d in [7, 30]"
          :key="d"
          type="button"
          class="dash__range-btn"
          :class="{ 'is-active': days === d }"
          @click="emit('rangeChange', d)"
        >
          近 {{ d }} 天
        </button>
      </div>
      <div class="dash__meta">
        <span v-if="data" class="dash__stamp">
          <NmIcon name="clock" :size="12" />更新于 {{ new Date(data.generatedAt).toLocaleTimeString('zh-CN') }}
        </span>
        <button type="button" class="nm-btn nm-btn--sm" :disabled="loading" @click="emit('refresh')">
          <NmIcon name="refresh" :size="13" />{{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 指标卡 -->
    <section class="metric-grid" aria-label="核心指标">
      <article v-for="m in metrics" :key="m.key" class="metric" :class="`metric--${m.tone}`">
        <div class="metric__top">
          <span class="metric__label">{{ m.label }}</span>
          <!-- 环比徽标（1.1.8）：只有带 compare 的卡片才显示 -->
          <span
            v-if="m.compare"
            class="metric__cmp"
            :class="`metric__cmp--${compareTone(m.compare)}`"
            :title="`今日 ${m.compare.today} · 昨日 ${m.compare.yesterday}`"
          >
            {{ compareLabel(m.compare) }}
          </span>
          <span class="metric__icon"><NmIcon :name="m.icon" :size="15" /></span>
        </div>
        <strong class="metric__value">{{ m.value }}</strong>
        <span class="metric__sub">{{ m.sub }}</span>
      </article>
      <article v-if="!metrics.length" class="metric metric--empty">
        <span class="metric__label">暂无数据</span>
        <strong class="metric__value">—</strong>
        <span class="metric__sub">请检查接口权限或稍后刷新</span>
      </article>
    </section>

    <!-- 趋势图 -->
    <section class="card card--chart" aria-label="趋势">
      <header class="card__head">
        <h3>趋势概览</h3>
        <div class="legend">
          <span v-for="s in SERIES" :key="s.key" class="legend__item">
            <i :style="{ background: s.color }" />{{ s.label }}
          </span>
        </div>
      </header>
      <div class="chart" v-if="trend.length">
        <svg
          class="chart__svg"
          :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
          preserveAspectRatio="none"
          role="img"
          aria-label="近 N 天趋势折线图"
          @mousemove="onChartMove"
          @mouseleave="onChartLeave"
        >
          <!-- 横向网格线与 Y 轴刻度 -->
          <g class="chart__grid">
            <line v-for="t in yTicks" :key="`gy${t.y}`" :x1="PAD.left" :x2="CHART_W - PAD.right" :y1="t.y" :y2="t.y" />
            <text v-for="t in yTicks" :key="`ty${t.y}`" :x="PAD.left - 8" :y="t.y + 3.5" text-anchor="end">{{ t.label }}</text>
          </g>
          <!-- X 轴日期 -->
          <g class="chart__axis">
            <text v-for="t in xTicks" :key="`tx${t.x}`" :x="t.x" :y="CHART_H - 8" text-anchor="middle">{{ t.label }}</text>
          </g>
          <!-- 面积 + 折线 -->
          <g v-for="s in chartPaths" :key="String(s.key)">
            <path v-if="s.area" :d="s.area" :fill="s.color" fill-opacity="0.07" />
            <path v-if="s.d" :d="s.d" fill="none" :stroke="s.color" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </g>
          <!-- 悬浮竖线 -->
          <line
            v-if="hover"
            :x1="hover.x"
            :x2="hover.x"
            :y1="PAD.top"
            :y2="CHART_H - PAD.bottom"
            class="chart__cursor"
          />
          <circle v-if="hover" :cx="hover.x" :cy="PAD.top + 6" r="3" class="chart__dot" />
        </svg>
        <!-- 悬浮提示 -->
        <div
          v-if="hover"
          class="chart__tip"
          :style="{ left: `${(hover.x / CHART_W) * 100}%` }"
        >
          <strong>{{ hover.date }}</strong>
          <span v-for="v in hover.values" :key="v.label">
            <i :style="{ background: v.color }" />{{ v.label }}：{{ v.text }}
          </span>
        </div>
      </div>
      <p v-else class="empty">暂无趋势数据</p>
    </section>

    <!-- 分布区：两列 -->
    <div class="dash__cols">
      <!-- AI 供应商占比 -->
      <section class="card" aria-label="AI 供应商占比">
        <header class="card__head"><h3>AI 供应商调用占比</h3></header>
        <div v-if="donut.length" class="donut-wrap">
          <svg class="donut" viewBox="0 0 140 140" role="img" aria-label="供应商调用占比环形图">
            <circle cx="70" cy="70" r="54" fill="none" stroke="var(--border)" stroke-width="16" />
            <circle
              v-for="seg in donut"
              :key="seg.provider"
              cx="70"
              cy="70"
              r="54"
              fill="none"
              :stroke="seg.color"
              stroke-width="16"
              :stroke-dasharray="`${seg.dash} ${seg.gap}`"
              :stroke-dashoffset="-seg.offset"
              transform="rotate(-90 70 70)"
              stroke-linecap="butt"
            />
            <text x="70" y="66" text-anchor="middle" class="donut__num">{{ compact(providerTotal) }}</text>
            <text x="70" y="82" text-anchor="middle" class="donut__label">总调用</text>
          </svg>
          <ul class="rank">
            <li v-for="seg in donut" :key="seg.provider">
              <i :style="{ background: seg.color }" />
              <span class="rank__name">{{ seg.name }}</span>
              <span class="rank__val">{{ compact(seg.calls) }}</span>
              <span class="rank__pct">{{ (seg.share * 100).toFixed(1) }}%</span>
            </li>
          </ul>
        </div>
        <p v-else class="empty">近 {{ days }} 天暂无 AI 调用</p>
      </section>

      <!-- 实时状态 -->
      <section class="card" aria-label="实时状态">
        <header class="card__head">
          <h3>实时状态</h3>
          <span v-if="data" class="card__hint">探测耗时 {{ data.status.latencyMs }}ms</span>
        </header>
        <ul class="status">
          <li v-for="s in statusItems" :key="s.label">
            <span class="status__dot" :class="{ 'is-ok': s.ok === true, 'is-bad': s.ok === false, 'is-unknown': s.ok === 'unknown' }" />
            <span class="status__label">{{ s.label }}</span>
            <strong class="status__text">{{ s.text }}</strong>
            <span class="status__detail">{{ s.detail }}</span>
          </li>
        </ul>
        <p v-if="data" class="card__foot">
          服务已运行 {{ uptimeText(data.status.uptimeSeconds) }}
        </p>
      </section>
    </div>

    <!-- Top 榜：两列 -->
    <div class="dash__cols">
      <section class="card" aria-label="仓库文档数 Top">
        <header class="card__head"><h3>仓库文档数 Top 10</h3></header>
        <ul v-if="data?.distributions.vaultsTop.length" class="rank rank--vaults">
          <li v-for="(v, i) in data.distributions.vaultsTop" :key="v.vaultId">
            <span class="rank__idx">{{ i + 1 }}</span>
            <span class="rank__name" :title="`${v.username ?? '未知'} / ${v.vaultId}`">{{ v.name }}</span>
            <span class="rank__owner">{{ v.username ?? '—' }}</span>
            <span class="rank__val">{{ compact(v.docCount) }} 篇</span>
            <span class="rank__pct">{{ bytes(v.bytes) }}</span>
          </li>
        </ul>
        <p v-else class="empty">暂无仓库数据</p>
      </section>

      <section class="card" aria-label="存储占用 Top">
        <header class="card__head"><h3>存储占用 Top 10 用户</h3></header>
        <ul v-if="data?.distributions.storageTop.length" class="rank rank--vaults">
          <li v-for="(u, i) in data.distributions.storageTop" :key="u.userId">
            <span class="rank__idx">{{ i + 1 }}</span>
            <span class="rank__name">{{ u.username ?? `用户 #${u.userId}` }}</span>
            <span class="rank__owner">{{ u.vaults }} 仓库</span>
            <span class="rank__val">{{ bytes(u.bytes) }}</span>
            <span class="rank__pct">{{ compact(u.docCount) }} 篇</span>
          </li>
        </ul>
        <p v-else class="empty">暂无存储数据</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ---------------- 顶部工具条 ---------------- */
.dash__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dash__range {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 9px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
}
.dash__range-btn {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
  transition: background 0.14s ease, color 0.14s ease;
}
.dash__range-btn.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.dash__meta {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.dash__stamp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--fg-3);
}

/* ---------------- 指标卡 ---------------- */
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.metric {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 22px 24px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  overflow: hidden;
  /* 浅色主题下靠轻微阴影建立层次（1.1.8「更大气」） */
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06);
  transition: box-shadow 0.16s ease;
}
.metric:hover { box-shadow: 0 4px 12px rgba(16, 24, 40, 0.08), 0 2px 4px rgba(16, 24, 40, 0.06); }
/* 左侧色条：用伪元素而不是 border-left，避免圆角处出现直角 */
.metric::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
}
.metric--blue::before { background: #3b82f6; }
.metric--green::before { background: #10b981; }
.metric--violet::before { background: #8b5cf6; }
.metric--amber::before { background: #f59e0b; }
.metric--rose::before { background: #f43f5e; }
.metric--cyan::before { background: #06b6d4; }
.metric__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.metric__label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-2);
  letter-spacing: 0.01em;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 环比徽标：上升绿 / 下降红 / 持平灰，浅色底上使用低饱和背景 */
.metric__cmp {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 7px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.metric__cmp--up { background: rgba(16, 185, 129, 0.12); color: #047857; }
.metric__cmp--down { background: rgba(244, 63, 94, 0.12); color: #be123c; }
.metric__cmp--flat { background: var(--bg-hover); color: var(--fg-3); }
.metric__icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--fg-2);
  flex: 0 0 auto;
}
.metric__value {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.12;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}
.metric__sub {
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.55;
}
.metric--empty { opacity: 0.7; }

/* ---------------- 卡片 ---------------- */
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  min-width: 0;
}
.card--chart { gap: 8px; }
.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.card__head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--fg);
}
.card__hint {
  font-size: 11.5px;
  color: var(--fg-3);
}
.card__foot {
  margin: 0;
  font-size: 11.5px;
  color: var(--fg-3);
}

/* ---------------- 趋势图 ---------------- */
.chart { position: relative; }
.chart__svg {
  display: block;
  width: 100%;
  height: 236px;
  overflow: visible;
}
.chart__grid line {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}
.chart__grid text,
.chart__axis text {
  font-size: 10px;
  fill: var(--fg-3);
}
.chart__cursor {
  stroke: var(--accent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  opacity: 0.7;
}
.chart__dot { fill: var(--accent); }
.chart__tip {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  min-width: 132px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  pointer-events: none;
  z-index: 2;
}
.chart__tip strong {
  font-size: 11.5px;
  color: var(--fg);
  margin-bottom: 2px;
}
.chart__tip span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-2);
  white-space: nowrap;
}
.chart__tip i,
.legend__item i,
.rank i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--fg-2);
}

/* ---------------- 两列区 ---------------- */
.dash__cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

/* ---------------- 环形图 + 排行 ---------------- */
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.donut {
  width: 140px;
  height: 140px;
  flex: 0 0 140px;
}
.donut__num {
  font-size: 17px;
  font-weight: 700;
  fill: var(--fg);
}
.donut__label {
  font-size: 9.5px;
  fill: var(--fg-3);
}
.rank {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 200px;
  min-width: 0;
}
.rank li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px;
  border-radius: 7px;
  font-size: 12px;
  min-width: 0;
}
.rank li:hover { background: var(--bg-hover); }
.rank__idx {
  width: 18px;
  flex: 0 0 18px;
  text-align: center;
  font-size: 10.5px;
  color: var(--fg-3);
  font-variant-numeric: tabular-nums;
}
.rank__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.rank__owner {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-3);
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank__val {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--fg-2);
  font-weight: 550;
}
.rank__pct {
  flex: 0 0 auto;
  min-width: 52px;
  text-align: right;
  font-size: 11px;
  color: var(--fg-3);
  font-variant-numeric: tabular-nums;
}
.rank--vaults li { gap: 10px; }

/* ---------------- 状态列表 ---------------- */
.status {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.status li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 6px;
  border-radius: 7px;
  font-size: 12.5px;
  min-width: 0;
}
.status li:hover { background: var(--bg-hover); }
.status__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--fg-3);
}
.status__dot.is-ok { background: #10b981; box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.16); }
.status__dot.is-bad { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16); }
.status__dot.is-unknown { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16); }
.status__label { flex: 0 0 108px; color: var(--fg-2); }
.status__text { flex: 0 0 auto; color: var(--fg); }
.status__detail {
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
  font-size: 11px;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 0;
  padding: 28px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--fg-3);
}

/* ---------------- 响应式 ---------------- */
/* 1920 宽屏：8 张指标卡铺成 4 列（每列 2 张），避免单卡过宽显得空 */
@media (min-width: 1680px) {
  .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
/* 中等屏（1280~1679）：4 列 */
@media (max-width: 1679px) {
  .metric-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
/* 1280 及以下：2 列，分布区单列 */
@media (max-width: 1280px) {
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dash__cols { grid-template-columns: minmax(0, 1fr); }
}
/* <1000：全部单列 */
@media (max-width: 1000px) {
  .metric-grid { grid-template-columns: minmax(0, 1fr); }
  .metric__value { font-size: 26px; }
  .chart__svg { height: 200px; }
  .donut-wrap { justify-content: flex-start; }
  .status__label { flex-basis: 88px; }
}
</style>
