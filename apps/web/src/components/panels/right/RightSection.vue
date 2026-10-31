<script setup lang="ts">
/**
 * 右侧栏附加区块（1.0.2）。
 *
 * 一个组件承载 6 种区块（大纲 / 反向链接 / 标签 / 历史 / 统计 / 日历），
 * 由 `section` prop 决定渲染哪一个。这样避免 6 个近乎同构的小文件，
 * 也让样式集中、切换区块时无重建开销。
 *
 * 数据全部通过 props 传入，组件本身不依赖 Pinia，便于单测复用。
 */
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { relativeTime } from '@neomd/shared';
import type { RightPanelSection } from '@neomd/shared';
import { buildMonthGrid, computeStats, extractTags, hasDailyNote } from './shared';

const props = defineProps<{
  section: RightPanelSection;
  content?: string;
  docId?: string;
  title?: string;
  /** 大纲：[{level,text}] */
  outline?: Array<{ level: number; text: string }>;
  /** 反向链接候选：全库中引用了当前标题的文档 */
  docs?: Array<{ docId: string; title: string; path: string; content?: string }>;
  /** 历史版本 */
  versions?: Array<{ id: string; rev: number; createdAt: number; label?: string }>;
}>();

const emit = defineEmits<{
  jump: [string];
  openDoc: [string];
  openVersion: [];
  openDaily: [string];
  /** 关闭本子窗口（1.1.9）：由 EditorPage 收到后从 rightPanelSections 移除本区块 */
  close: [];
  /**
   * 标题栏开始拖动（1.4.0 拖动排序）。
   *
   * 为什么不在这里自己排序：区块的上下顺序由 EditorPage 统一持有
   * （`settings.layout.rightPanelSections`），单个区块组件不应知道兄弟区块的存在。
   * 这里只把原生 DragEvent 原样抛上去，由父组件负责插入位置计算与持久化。
   */
  headerDragStart: [event: DragEvent];
  /** 标题栏拖动结束（含被取消），父组件据此清掉拖拽态样式 */
  headerDragEnd: [];
}>();

/* ---------------- 反向链接：扫描全库中的 [[当前标题]] ---------------- */
const backlinks = computed(() => {
  const target = (props.title ?? '').trim();
  if (!target) return [];
  const out: Array<{ docId: string; title: string; snippet: string }> = [];
  for (const d of props.docs ?? []) {
    if (d.docId === props.docId) continue;
    const body = d.content ?? '';
    if (!body.includes(`[[${target}`)) continue;
    const idx = body.indexOf(`[[${target}`);
    out.push({
      docId: d.docId,
      title: d.title,
      snippet: body.slice(Math.max(0, idx - 30), idx + target.length + 40).replace(/\s+/g, ' '),
    });
  }
  return out.slice(0, 30);
});

/* ---------------- 标签 ---------------- */
const tags = computed(() => extractTags(props.content ?? ''));

/* ---------------- 统计 ---------------- */
const stats = computed(() => computeStats(props.content ?? ''));

/* ---------------- 日历 ---------------- */
const today = new Date();
const cursor = ref({ year: today.getFullYear(), month: today.getMonth() });
const monthLabel = computed(() => `${cursor.value.year} 年 ${cursor.value.month + 1} 月`);
const monthCells = computed(() => buildMonthGrid(cursor.value.year, cursor.value.month));
const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

function shiftMonth(delta: number): void {
  let { year, month } = cursor.value;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  cursor.value = { year, month };
}

/** 某天是否有日记文件 */
function dailyExists(date: string): boolean {
  return hasDailyNote(props.docs ?? [], date);
}

const titles: Record<string, string> = {
  outline: '大纲',
  backlinks: '反向链接',
  tags: '标签',
  history: '版本历史',
  stats: '文档统计',
  calendar: '日历',
};
</script>

<template>
  <section class="rsection">
    <!--
      标题栏可拖动排序（1.4.0）。
      `draggable` 直接加在 header 上，满足「拖动标题栏调整位置」的直觉；
      标题栏内的关闭按钮显式 `draggable="false"`，避免从按钮上按下时
      起一个拖拽而吞掉这一次点击。
    -->
    <header
      class="rsection__head"
      draggable="true"
      :title="`拖动标题栏调整「${titles[section] ?? section}」的位置`"
      @dragstart="emit('headerDragStart', $event)"
      @dragend="emit('headerDragEnd')"
    >
      <NmIcon :name="section === 'outline' ? 'outline' : section === 'backlinks' ? 'link' : section === 'tags' ? 'tag' : section === 'history' ? 'history' : section === 'stats' ? 'chart' : 'calendar'" :size="13" />
      <span class="rsection__label">{{ titles[section] ?? section }}</span>
      <!--
        每个子窗口标题栏的独立关闭按钮（1.1.9）。
        多区块堆叠时，用户需要能只关掉其中一个（比如关掉日历、留下大纲），
        而不是只能通过顶部小图标反选、或干脆关掉整个右侧栏。
      -->
      <button
        class="rsection__close"
        draggable="false"
        :title="`关闭「${titles[section] ?? section}」子窗口`"
        :aria-label="`关闭「${titles[section] ?? section}」子窗口`"
        @click="emit('close')"
      >
        <NmIcon name="close" :size="12" />
      </button>
    </header>

    <!-- 大纲 -->
    <div v-if="section === 'outline'" class="rsection__body nm-scroll">
      <p v-if="!outline?.length" class="rsection__empty">本文档暂无标题结构。</p>
      <button
        v-for="(h, i) in outline"
        :key="i"
        class="outline-item"
        :style="{ paddingLeft: `${8 + (h.level - 1) * 12}px` }"
        :title="h.text"
        @click="emit('jump', h.text)"
      >
        {{ h.text }}
      </button>
    </div>

    <!-- 反向链接 -->
    <div v-else-if="section === 'backlinks'" class="rsection__body nm-scroll">
      <p v-if="!backlinks.length" class="rsection__empty">还没有其他文档链接到本篇。</p>
      <button v-for="b in backlinks" :key="b.docId" class="backlink" :title="b.snippet" @click="emit('openDoc', b.docId)">
        <span class="backlink__title">{{ b.title }}</span>
        <span class="backlink__snippet">{{ b.snippet }}</span>
      </button>
    </div>

    <!-- 标签 -->
    <div v-else-if="section === 'tags'" class="rsection__body nm-scroll">
      <p v-if="!tags.length" class="rsection__empty">正文里还没有 #标签。</p>
      <div class="tagcloud">
        <button v-for="t in tags" :key="t" class="tagchip" @click="emit('jump', t)">
          <NmIcon name="tag" :size="11" />{{ t }}
        </button>
      </div>
    </div>

    <!-- 历史版本 -->
    <div v-else-if="section === 'history'" class="rsection__body nm-scroll">
      <p v-if="!versions?.length" class="rsection__empty">还没有历史版本记录。</p>
      <button v-for="v in (versions ?? []).slice(0, 8)" :key="v.id" class="verrow" @click="emit('openVersion')">
        <span class="verrow__rev">v{{ v.rev }}</span>
        <span class="verrow__time">{{ relativeTime(v.createdAt) }}</span>
        <span class="verrow__label">{{ v.label || '本地/云端' }}</span>
      </button>
      <button v-if="versions?.length" class="rsection__more" @click="emit('openVersion')">查看全部版本…</button>
    </div>

    <!-- 统计 -->
    <div v-else-if="section === 'stats'" class="rsection__body">
      <dl class="statlist">
        <div><dt>字数</dt><dd>{{ stats.words }}</dd></div>
        <div><dt>字符</dt><dd>{{ stats.chars }}</dd></div>
        <div><dt>段落</dt><dd>{{ stats.paragraphs }}</dd></div>
        <div><dt>阅读</dt><dd>{{ stats.readingMinutes }} 分钟</dd></div>
      </dl>
    </div>

    <!-- 日历 -->
    <div v-else class="rsection__body">
      <div class="calendar__nav">
        <button class="calendar__btn" title="上个月" @click="shiftMonth(-1)"><NmIcon name="chevronLeft" :size="13" /></button>
        <span class="calendar__month">{{ monthLabel }}</span>
        <button class="calendar__btn" title="下个月" @click="shiftMonth(1)"><NmIcon name="chevronRight" :size="13" /></button>
      </div>
      <div class="calendar__week">
        <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w">{{ w }}</span>
      </div>
      <div class="calendar__grid">
        <button
          v-for="(c, i) in monthCells"
          :key="i"
          class="calendar__day"
          :class="{ 'is-out': !c.inMonth, 'is-today': c.date === todayKey, 'has-note': dailyExists(c.date) }"
          :title="dailyExists(c.date) ? `${c.date} 已有日记` : `${c.date} 点击创建日记`"
          @click="emit('openDaily', c.date)"
        >
          {{ c.day }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rsection {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
}
.rsection:first-child {
  border-top: none;
}
.rsection__head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.rsection__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 子窗口标题栏的关闭按钮（1.1.9）。
 * 用 margin-left: auto 贴右，与 AiPanel 的 `.ai__close` 保持同样的点击热区高度（20px）。
 */
.rsection__close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.rsection__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.rsection__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 10px;
}
.rsection__empty {
  margin: 4px 2px;
  font-size: 11.5px;
  color: var(--fg-3);
  line-height: 1.6;
}
.rsection__more {
  width: 100%;
  margin-top: 4px;
  padding: 5px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--accent);
}
.rsection__more:hover {
  background: var(--bg-hover);
}

.outline-item {
  display: block;
  width: 100%;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--fg-2);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.outline-item:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

.backlink {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
}
.backlink:hover {
  background: var(--bg-hover);
}
.backlink__title {
  font-size: 12px;
  font-weight: 550;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backlink__snippet {
  font-size: 10.5px;
  color: var(--fg-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tagcloud {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 2px;
}
.tagchip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  background: var(--sky);
  color: var(--accent);
  font-size: 11px;
}
.tagchip:hover {
  background: var(--bg-active);
}

.verrow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--fg-2);
  text-align: left;
}
.verrow:hover {
  background: var(--bg-hover);
}
.verrow__rev {
  font-family: var(--font-mono);
  color: var(--accent);
  flex: 0 0 auto;
}
.verrow__time {
  flex: 0 0 auto;
  color: var(--fg-3);
}
.verrow__label {
  margin-left: auto;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statlist {
  margin: 0;
  padding: 2px 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.statlist > div {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border-radius: 5px;
  font-size: 12px;
}
.statlist > div:hover {
  background: var(--bg-hover);
}
.statlist dt {
  color: var(--fg-3);
}
.statlist dd {
  margin: 0;
  font-weight: 600;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.calendar__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px;
}
.calendar__month {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-2);
}
.calendar__btn {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.calendar__btn:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.calendar__week,
.calendar__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.calendar__week span {
  text-align: center;
  font-size: 10px;
  color: var(--fg-3);
  padding-bottom: 2px;
}
.calendar__day {
  height: 24px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--fg-2);
  display: grid;
  place-items: center;
  position: relative;
}
.calendar__day:hover {
  background: var(--bg-hover);
}
.calendar__day.is-out {
  color: var(--fg-3);
  opacity: 0.45;
}
.calendar__day.is-today {
  box-shadow: inset 0 0 0 1.5px var(--accent);
  color: var(--accent);
  font-weight: 700;
}
.calendar__day.has-note::after {
  content: '';
  position: absolute;
  bottom: 3px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
}
</style>
