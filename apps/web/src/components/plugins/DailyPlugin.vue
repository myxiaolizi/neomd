<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface DailyItem {
  docId: string;
  title: string;
  date: string;
}

const props = defineProps<{ items: DailyItem[]; today: string }>();
const emit = defineEmits<{ open: [string]; create: [string] }>();

const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth());

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

const byDate = computed(() => {
  const map = new Map<string, DailyItem>();
  for (const d of props.items) map.set(d.date, d);
  return map;
});

const cells = computed(() => {
  const first = new Date(year.value, month.value, 1);
  const startWeekday = (first.getDay() + 6) % 7; // 周一为起点
  const daysInMonth = new Date(year.value, month.value + 1, 0).getDate();
  const out: Array<{ day: number | null; date: string; has: boolean }> = [];
  for (let i = 0; i < startWeekday; i += 1) out.push({ day: null, date: '', has: false });
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = `${year.value}-${String(month.value + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ day: d, date, has: byDate.value.has(date) });
  }
  return out;
});

const monthLabel = computed(() => `${year.value} 年 ${month.value + 1} 月`);

function prev(): void {
  if (month.value === 0) {
    month.value = 11;
    year.value -= 1;
  } else month.value -= 1;
}

function next(): void {
  if (month.value === 11) {
    month.value = 0;
    year.value += 1;
  } else month.value += 1;
}

function pick(date: string): void {
  const hit = byDate.value.get(date);
  if (hit) emit('open', hit.docId);
  else emit('create', date);
}

const recent = computed(() => [...props.items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8));
</script>

<template>
  <div class="daily">
    <div class="daily__head">
      <button class="nav" @click="prev"><NmIcon name="chevronLeft" :size="13" /></button>
      <span class="daily__month">{{ monthLabel }}</span>
      <button class="nav" @click="next"><NmIcon name="chevronRight" :size="13" /></button>
    </div>
    <div class="daily__week">
      <span v-for="d in DAY_NAMES" :key="d">{{ d }}</span>
    </div>
    <div class="daily__grid">
      <button
        v-for="(c, i) in cells"
        :key="i"
        class="cell"
        :class="{ 'is-empty': !c.day, 'has-doc': c.has, 'is-today': c.date === today }"
        :disabled="!c.day"
        @click="c.day && pick(c.date)"
      >
        {{ c.day ?? '' }}
      </button>
    </div>
    <button class="daily__today" @click="pick(today)">
      <NmIcon name="calendar" :size="13" />
      打开今天（{{ today }}）
    </button>
    <div class="daily__recent">
      <div class="daily__subtitle">最近的日记</div>
      <p v-if="!recent.length" class="daily__empty">还没有日记，点上面的按钮创建今天的第一篇。</p>
      <button v-for="d in recent" :key="d.docId" class="daily-row" @click="emit('open', d.docId)">
        <NmIcon name="file" :size="12" />
        <span>{{ d.date }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.daily {
  padding: 8px 10px 20px;
}
.daily__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.daily__month {
  flex: 1;
  text-align: center;
  font-size: 12.5px;
  font-weight: 600;
}
.nav {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.nav:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.daily__week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  margin-bottom: 4px;
}
.daily__week span {
  text-align: center;
  font-size: 10px;
  color: var(--fg-3);
}
.daily__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.cell {
  aspect-ratio: 1;
  border-radius: 5px;
  font-size: 11px;
  color: var(--fg-2);
  display: grid;
  place-items: center;
}
.cell:hover:not(.is-empty) {
  background: var(--bg-hover);
}
.cell.is-empty {
  cursor: default;
}
.cell.has-doc {
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.cell.is-today {
  outline: 1.5px solid var(--accent);
  outline-offset: -1.5px;
}
.daily__today {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 10px;
  height: 30px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.daily__recent {
  margin-top: 14px;
}
.daily__subtitle {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 6px;
}
.daily__empty {
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.daily-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
  font-family: var(--font-mono);
}
.daily-row:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
