<script setup lang="ts">
/**
 * 后台 · AI 运营分析（1.1.9 新增）。
 *
 * 与「数据看板」的分工：
 *  - 数据看板是首页概览，指标以今日/累计为主，够看就行；
 *  - 本页是运营分析，可切 7/30 天窗口，并把**长尾延迟（p95）**与**模型维度成本**拆出来，
 *    这才是判断「哪个模型在拖慢 / 在烧钱」的依据。
 *
 * 图表全部用**自绘 SVG**（不引入任何图表库）：
 *  - 折线 + 面积：调用量 / 失败率 / 延迟三条序列共用一套时间轴；
 *  - 横向条形：模型 / 供应商成本占比；
 *  - 环形：令牌健康分布。
 * 这样既满足「不新增依赖」，也避免图表库在浅色主题下自带一套难以覆盖的配色。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { api } from '@/api/client';
import { fmtCount, fmtLatency, fmtTime, pct } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

interface DailyPoint {
  date: string;
  calls: number;
  errors: number;
  failRate: number;
  inTokens: number;
  outTokens: number;
  cost: number;
  avgLatency: number;
  p95Latency: number;
}

interface DimensionRow {
  calls: number;
  errors: number;
  failRate: number;
  inTokens: number;
  outTokens: number;
  cost: number;
  costShare: number;
  users: number;
  avgLatency: number;
  p95Latency: number;
  latencySamples: number;
}

interface ModelRow extends DimensionRow {
  model: string;
  provider: string | null;
  providerName: string | null;
}

interface ProviderRow extends DimensionRow {
  provider: string;
  name: string;
}

interface Analytics {
  range: { days: number; span: number };
  totals: {
    calls: number;
    errors: number;
    failRate: number;
    inTokens: number;
    outTokens: number;
    cost: number;
    activeUsers: number;
    avgLatency: number;
    p95Latency: number;
    peakCallsPerDay: number;
    avgCallsPerDay: number;
  };
  daily: DailyPoint[];
  byModel: ModelRow[];
  byProvider: ProviderRow[];
  knowledgeTokens: {
    total: number;
    active: number;
    revoked: number;
    neverUsed: number;
    neverExpires: number;
    used7d: number;
    users: number;
  };
  conversion: {
    users: number;
    payingUsers: number;
    creditedUsers: number;
    rate: number;
    rechargedCredits: number;
  };
  lowBalanceUsers: Array<{ id: number; username: string | null; email: string | null; credits: number }>;
  generatedAt: string;
}

const days = ref<7 | 30>(7);
const data = ref<Analytics | null>(null);
const loading = ref(false);

/**
 * 当前图表展示的序列：调用量 / 失败率 / 延迟。
 *
 * 用 `Record<SeriesKey, …>` 而不是数组：模板里要按当前 `series` 取颜色，
 * 数组需要用 `find()` 查找（结果可能 undefined），对象则能直接索引；
 * 值类型显式写成 `{ key; label: string; color: string }`，
 * 避免 `as const` 把 label 收窄成字面量类型后与 SeriesKey 索引对不上。
 */
type SeriesKey = 'calls' | 'failRate' | 'latency';
const series = ref<SeriesKey>('calls');

const seriesMeta: Record<SeriesKey, { key: SeriesKey; label: string; color: string }> = {
  calls: { key: 'calls', label: '调用量', color: '#1677ff' },
  failRate: { key: 'failRate', label: '失败率', color: '#d93025' },
  latency: { key: 'latency', label: 'p95 延迟', color: '#b5540f' },
};

/** 序列按钮列表（由 seriesMeta 派生，保证两处顺序永远一致） */
const SERIES_OPTIONS = Object.values(seriesMeta);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api<Analytics>(`/api/admin/ai-analytics?days=${days.value}`, { auth: true });
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function setDays(d: 7 | 30): Promise<void> {
  days.value = d;
  await load();
}

/* ---------------------------- 折线图几何计算 ---------------------------- */

/**
 * SVG 视口。用固定 viewBox + `width:100%` 让图表自适应容器宽度，
 * 不依赖 getBoundingClientRect（那玩意不是响应式依赖，首帧取到的宽高不可靠）。
 */
const W = 860;
const H = 240;
const PAD = { top: 18, right: 18, bottom: 30, left: 52 };

const chart = computed(() => {
  const points = data.value?.daily ?? [];
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  if (points.length === 0) {
    return { points: [], path: '', area: '', maxY: 0, ticks: [], yLabels: [] as Array<{ y: number; text: string }> };
  }

  const valueOf = (p: DailyPoint): number => {
    if (series.value === 'calls') return p.calls;
    if (series.value === 'failRate') return p.failRate * 100;
    return p.p95Latency;
  };

  const raw = points.map(valueOf);
  // 纵轴上限留 15% 头部空间，避免峰值顶到边框；全 0 时用 1 兜底防除零
  const peak = Math.max(...raw);
  const maxY = peak > 0 ? peak * 1.15 : 1;

  const xAt = (i: number): number =>
    points.length === 1 ? PAD.left + innerW / 2 : PAD.left + (innerW * i) / (points.length - 1);
  const yAt = (v: number): number => PAD.top + innerH - (v / maxY) * innerH;

  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(valueOf(p)), point: p }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area =
    coords.length > 0
      ? `${path} L${coords[coords.length - 1]!.x.toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${coords[0]!.x.toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`
      : '';

  // 4 条水平网格线 + 对应的纵轴刻度文字
  const yLabels: Array<{ y: number; text: string }> = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = (maxY / 4) * i;
    yLabels.push({
      y: PAD.top + innerH - (innerH * i) / 4,
      text:
        series.value === 'failRate'
          ? `${v.toFixed(0)}%`
          : series.value === 'latency'
            ? fmtLatency(v)
            : fmtCount(Math.round(v)),
    });
  }

  return { points: coords, path, area, maxY, ticks: coords, yLabels };
});

/** X 轴标签：点数多时隔几个显示，避免 30 天时标签重叠 */
const xLabels = computed(() => {
  const pts = chart.value.points;
  if (pts.length === 0) return [];
  const step = pts.length <= 8 ? 1 : pts.length <= 16 ? 2 : 5;
  return pts
    .filter((_, i) => i % step === 0 || i === pts.length - 1)
    .map((c) => ({ x: c.x, text: c.point.date.slice(5) }));
});

/* ---------------------------- 环形图（令牌健康） ---------------------------- */
const ring = computed(() => {
  const t = data.value?.knowledgeTokens;
  if (!t || t.total === 0) return { segments: [] as Array<{ color: string; dash: string; offset: number }>, total: 0 };
  const R = 46;
  const C = 2 * Math.PI * R;
  const parts = [
    { value: t.active, color: '#0e9f6e' },
    { value: t.revoked, color: '#d93025' },
    // 过期 = 总数 - 有效 - 吊销，避免后端没单独统计时的口径缺口
    { value: Math.max(0, t.total - t.active - t.revoked), color: '#b5540f' },
  ];
  let acc = 0;
  const segments = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const len = (p.value / t.total) * C;
      const seg = { color: p.color, dash: `${len.toFixed(2)} ${(C - len).toFixed(2)}`, offset: -acc };
      acc += len;
      return seg;
    });
  return { segments, total: t.total, circumference: C, radius: R };
});

/* ---------------------------- 模型 / 供应商表格 ---------------------------- */

/** 成本占比最高的前 8 个模型，条形图与表格共用 */
const topModels = computed(() => (data.value?.byModel ?? []).slice(0, 8));
const maxModelCost = computed(() => Math.max(1, ...topModels.value.map((m) => m.cost)));

/** 失败率着色：>10% 红、>3% 橙，其余正常 */
function failClass(rate: number): string {
  if (rate > 0.1) return 'is-danger';
  if (rate > 0.03) return 'is-warn';
  return '';
}

onMounted(load);

defineExpose({ reload: load });
</script>

<template>
  <div class="aiu">
    <header class="adm-page-head">
      <div>
        <h2>AI 运营分析</h2>
        <p>
          按天 / 模型 / 供应商三个维度看调用量、失败率、平均与 p95 延迟、token 与积分消耗。
          p95 用 MySQL 8 窗口函数在库内计算，只统计成功且有耗时的样本（失败调用的耗时不代表模型性能）。
        </p>
      </div>
      <div class="adm-page-actions">
        <div class="adm-seg">
          <button :class="{ 'is-on': days === 7 }" @click="setDays(7)">近 7 天</button>
          <button :class="{ 'is-on': days === 30 }" @click="setDays(30)">近 30 天</button>
        </div>
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <div v-if="loading && !data" class="adm-empty">加载中…</div>

    <template v-else-if="data">
      <!-- 汇总指标 -->
      <div class="adm-metric-grid" style="margin-bottom: 22px;">
        <article class="adm-metric">
          <span class="adm-metric__label">调用总量</span>
          <span class="adm-metric__value">{{ fmtCount(data.totals.calls) }}</span>
          <span class="adm-metric__sub">日均 <b>{{ data.totals.avgCallsPerDay }}</b> · 峰值 <b>{{ data.totals.peakCallsPerDay }}</b>/天</span>
        </article>
        <article class="adm-metric">
          <span class="adm-metric__label">失败率</span>
          <span class="adm-metric__value" :class="failClass(data.totals.failRate)">{{ pct(data.totals.failRate) }}</span>
          <span class="adm-metric__sub">{{ data.totals.errors }} 次失败 / {{ data.totals.calls }} 次调用</span>
        </article>
        <article class="adm-metric">
          <span class="adm-metric__label">平均延迟</span>
          <span class="adm-metric__value">{{ fmtLatency(data.totals.avgLatency) }}</span>
          <span class="adm-metric__sub">按天样本加权平均</span>
        </article>
        <article class="adm-metric">
          <span class="adm-metric__label">p95 延迟</span>
          <span class="adm-metric__value">{{ fmtLatency(data.totals.p95Latency) }}</span>
          <span class="adm-metric__sub">长尾体验指标</span>
        </article>
        <article class="adm-metric">
          <span class="adm-metric__label">积分消耗</span>
          <span class="adm-metric__value">{{ fmtCount(data.totals.cost) }}</span>
          <span class="adm-metric__sub">token 入 {{ fmtCount(data.totals.inTokens) }} / 出 {{ fmtCount(data.totals.outTokens) }}</span>
        </article>
        <article class="adm-metric">
          <span class="adm-metric__label">付费转化率</span>
          <span class="adm-metric__value">{{ pct(data.conversion.rate) }}</span>
          <span class="adm-metric__sub">
            付费 <b>{{ data.conversion.payingUsers }}</b> / 总用户 <b>{{ data.conversion.users }}</b>
          </span>
        </article>
      </div>

      <!-- 趋势折线图（自绘 SVG） -->
      <section class="adm-card" style="margin-bottom: 22px;">
        <div class="adm-card__head">
          <div>
            <h3 class="adm-card__title">每日趋势</h3>
            <p class="adm-card__sub">{{ data.range.days }} 天窗口 · 共 {{ data.daily.length }} 个数据点</p>
          </div>
          <div class="adm-seg">
            <button
              v-for="opt in SERIES_OPTIONS"
              :key="opt.key"
              :class="{ 'is-on': series === opt.key }"
              @click="series = opt.key"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div class="adm-card__body">
          <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="每日趋势折线图">
            <!-- 水平网格 + 纵轴刻度 -->
            <g>
              <template v-for="(lbl, i) in chart.yLabels" :key="`y${i}`">
                <line
                  :x1="PAD.left"
                  :x2="W - PAD.right"
                  :y1="lbl.y"
                  :y2="lbl.y"
                  stroke="#eef0f3"
                  stroke-width="1"
                />
                <text :x="PAD.left - 10" :y="lbl.y + 4" text-anchor="end" class="axis-text">{{ lbl.text }}</text>
              </template>
            </g>
            <!-- 面积 + 折线 -->
            <path v-if="chart.area" :d="chart.area" :fill="seriesMeta[series].color" fill-opacity="0.08" />
            <path
              v-if="chart.path"
              :d="chart.path"
              fill="none"
              :stroke="seriesMeta[series].color"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <!-- 数据点（点数少时才画，30 天画满会糊成一片） -->
            <template v-if="chart.points.length <= 14">
              <circle
                v-for="(c, i) in chart.points"
                :key="`p${i}`"
                :cx="c.x"
                :cy="c.y"
                r="3"
                :fill="seriesMeta[series].color"
              >
                <title>{{ c.point.date }}：{{ series === 'failRate' ? pct(c.point.failRate) : series === 'latency' ? fmtLatency(c.point.p95Latency) : c.point.calls }}</title>
              </circle>
            </template>
            <!-- X 轴标签 -->
            <text
              v-for="(lbl, i) in xLabels"
              :key="`x${i}`"
              :x="lbl.x"
              :y="H - 8"
              text-anchor="middle"
              class="axis-text"
            >
              {{ lbl.text }}
            </text>
          </svg>
        </div>
      </section>

      <!-- 模型维度 -->
      <section class="adm-card" style="margin-bottom: 22px;">
        <div class="adm-card__head">
          <div>
            <h3 class="adm-card__title">模型维度用量与成本</h3>
            <p class="adm-card__sub">按积分消耗降序，最多展示 30 个模型</p>
          </div>
        </div>
        <div class="adm-card__body" style="padding-top: 4px;">
          <!-- 成本占比条形图 -->
          <div v-if="topModels.length" class="barlist">
            <div v-for="m in topModels" :key="m.model" class="barlist__row">
              <span class="barlist__name" :title="m.model">{{ m.model }}</span>
              <div class="adm-bar barlist__bar">
                <div class="adm-bar__fill" :style="{ width: `${(m.cost / maxModelCost) * 100}%` }" />
              </div>
              <span class="barlist__val">{{ fmtCount(m.cost) }}</span>
            </div>
          </div>
          <p v-else class="adm-empty" style="padding: 12px 0;">该窗口内没有模型调用记录</p>

          <table class="adm-table adm-table--tight" style="margin-top: 18px;">
            <thead>
              <tr>
                <th>模型</th>
                <th>供应商</th>
                <th class="adm-right">调用</th>
                <th class="adm-right">失败率</th>
                <th class="adm-right">平均</th>
                <th class="adm-right">p95</th>
                <th class="adm-right">积分</th>
                <th class="adm-right">成本占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.byModel" :key="m.model">
                <td class="adm-mono adm-strong">{{ m.model }}</td>
                <td class="adm-muted">{{ m.providerName ?? m.provider ?? '—' }}</td>
                <td class="adm-right">{{ fmtCount(m.calls) }}</td>
                <td class="adm-right" :class="failClass(m.failRate)">{{ pct(m.failRate) }}</td>
                <td class="adm-right">{{ fmtLatency(m.avgLatency) }}</td>
                <td class="adm-right">{{ fmtLatency(m.p95Latency) }}</td>
                <td class="adm-right adm-strong">{{ fmtCount(m.cost) }}</td>
                <td class="adm-right">{{ pct(m.costShare) }}</td>
              </tr>
              <tr v-if="!data.byModel.length">
                <td colspan="8" class="adm-empty">暂无模型调用</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 供应商维度 -->
      <section class="adm-card" style="margin-bottom: 22px;">
        <div class="adm-card__head">
          <div>
            <h3 class="adm-card__title">供应商维度</h3>
            <p class="adm-card__sub">判断哪个上游渠道在承载主要流量、是否健康</p>
          </div>
        </div>
        <div class="adm-card__body" style="padding-top: 4px;">
          <table class="adm-table adm-table--tight">
            <thead>
              <tr>
                <th>供应商</th>
                <th class="adm-right">调用</th>
                <th class="adm-right">失败率</th>
                <th class="adm-right">平均</th>
                <th class="adm-right">p95</th>
                <th class="adm-right">用户数</th>
                <th class="adm-right">积分</th>
                <th class="adm-right">成本占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.byProvider" :key="p.provider">
                <td>
                  <div class="adm-strong">{{ p.name }}</div>
                  <div class="adm-mono adm-muted" style="font-size: 11px;">{{ p.provider }}</div>
                </td>
                <td class="adm-right">{{ fmtCount(p.calls) }}</td>
                <td class="adm-right" :class="failClass(p.failRate)">{{ pct(p.failRate) }}</td>
                <td class="adm-right">{{ fmtLatency(p.avgLatency) }}</td>
                <td class="adm-right">{{ fmtLatency(p.p95Latency) }}</td>
                <td class="adm-right">{{ p.users }}</td>
                <td class="adm-right adm-strong">{{ fmtCount(p.cost) }}</td>
                <td class="adm-right">{{ pct(p.costShare) }}</td>
              </tr>
              <tr v-if="!data.byProvider.length">
                <td colspan="8" class="adm-empty">暂无供应商调用</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 令牌健康 + 低余额用户 -->
      <div class="duo">
        <section class="adm-card">
          <div class="adm-card__head">
            <div>
              <h3 class="adm-card__title">知识库令牌健康</h3>
              <p class="adm-card__sub">全库口径，不受时间窗口影响</p>
            </div>
          </div>
          <div class="adm-card__body ring-body">
            <svg viewBox="0 0 120 120" class="ring" role="img" aria-label="令牌状态分布环形图">
              <circle cx="60" cy="60" :r="ring.radius ?? 46" fill="none" stroke="#eef0f3" stroke-width="12" />
              <circle
                v-for="(seg, i) in ring.segments"
                :key="i"
                cx="60"
                cy="60"
                :r="ring.radius ?? 46"
                fill="none"
                :stroke="seg.color"
                stroke-width="12"
                :stroke-dasharray="seg.dash"
                :stroke-dashoffset="seg.offset"
                transform="rotate(-90 60 60)"
                stroke-linecap="butt"
              />
              <text x="60" y="56" text-anchor="middle" class="ring-num">{{ ring.total ?? 0 }}</text>
              <text x="60" y="74" text-anchor="middle" class="ring-label">令牌总数</text>
            </svg>
            <ul class="ring-legend">
              <li><i style="background: #0e9f6e" />有效 <b>{{ data.knowledgeTokens.active }}</b></li>
              <li><i style="background: #d93025" />已吊销 <b>{{ data.knowledgeTokens.revoked }}</b></li>
              <li><i style="background: #b5540f" />已过期 <b>{{ Math.max(0, data.knowledgeTokens.total - data.knowledgeTokens.active - data.knowledgeTokens.revoked) }}</b></li>
              <li><i style="background: #cbd5e1" />从未使用 <b>{{ data.knowledgeTokens.neverUsed }}</b></li>
              <li><i style="background: #93c5fd" />近 7 天用过 <b>{{ data.knowledgeTokens.used7d }}</b></li>
              <li><i style="background: #fbbf24" />永不过期 <b>{{ data.knowledgeTokens.neverExpires }}</b></li>
            </ul>
          </div>
        </section>

        <section class="adm-card">
          <div class="adm-card__head">
            <div>
              <h3 class="adm-card__title">低余额用户</h3>
              <p class="adm-card__sub">余额 &lt; 50 且账号正常，可主动跟进</p>
            </div>
            <span class="adm-badge adm-badge--warn">{{ data.lowBalanceUsers.length }} 人</span>
          </div>
          <div class="adm-card__body" style="padding-top: 4px;">
            <ul class="lowlist">
              <li v-for="u in data.lowBalanceUsers" :key="u.id">
                <div>
                  <div class="adm-strong">{{ u.username ?? `用户 ${u.id}` }}</div>
                  <div class="adm-muted" style="font-size: 11.5px;">{{ u.email ?? '—' }}</div>
                </div>
                <span class="adm-badge" :class="u.credits <= 0 ? 'adm-badge--danger' : 'adm-badge--warn'">
                  {{ u.credits }} 积分
                </span>
              </li>
              <li v-if="!data.lowBalanceUsers.length" class="adm-empty" style="padding: 20px 0;">
                没有低余额用户
              </li>
            </ul>
          </div>
        </section>
      </div>

      <p class="adm-muted" style="font-size: 11.5px; margin-top: 18px;">
        数据生成时间 {{ fmtTime(data.generatedAt) }}
      </p>
    </template>
  </div>
</template>

<style scoped>
/* 图表视口：宽 100%、高度自适应，保持 viewBox 比例 */
.chart {
  width: 100%;
  height: auto;
  display: block;
}
.axis-text {
  font-size: 10.5px;
  fill: #9aa1ab;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
}

/* 成本占比条形列表：名称定宽 + 弹性条 + 数值右对齐 */
.barlist { display: flex; flex-direction: column; gap: 9px; }
.barlist__row {
  display: grid;
  grid-template-columns: 190px 1fr 74px;
  align-items: center;
  gap: 12px;
}
.barlist__name {
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 11.5px;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.barlist__bar { height: 8px; }
.barlist__val {
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  color: #4b5563;
  font-variant-numeric: tabular-nums;
}

/* 令牌健康 + 低余额：并排两栏，窄屏堆叠 */
.duo {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 22px;
}
.ring-body {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.ring { width: 132px; height: 132px; flex: 0 0 132px; }
.ring-num {
  font-size: 20px;
  font-weight: 700;
  fill: #1f2329;
}
.ring-label {
  font-size: 9.5px;
  fill: #9aa1ab;
}
.ring-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12.5px;
  color: #4b5563;
  min-width: 0;
}
.ring-legend li { display: flex; align-items: center; gap: 8px; }
.ring-legend i {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: 0 0 9px;
}
.ring-legend b { margin-left: auto; color: #1f2329; font-weight: 650; }

.lowlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.lowlist li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid #eef0f3;
}
.lowlist li:last-child { border-bottom: none; }

.is-danger { color: #d93025 !important; font-weight: 600; }
.is-warn { color: #b5540f !important; font-weight: 600; }

@media (max-width: 1100px) {
  .duo { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .barlist__row { grid-template-columns: 110px 1fr 60px; }
}
</style>
