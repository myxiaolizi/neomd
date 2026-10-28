<script setup lang="ts">
/**
 * 积分流水面板（1.1.7 新增）。
 *
 * 数据来源 `credit_ledger`（余额变更的唯一账本）。
 * `delta` 为正表示入账、为负表示扣减，`balanceAfter` 是这笔之后的余额快照。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV3, type AdminLedgerDto } from '@/api/client';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const items = ref<AdminLedgerDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 30;
const search = ref('');
const userId = ref('');
const kind = ref('');
const loading = ref(false);
const summary = ref({ inflow: 0, outflow: 0 });

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

/** 流水类型的中文名与色调 */
const KIND_META: Record<string, { label: string; tone: string }> = {
  recharge: { label: '充值', tone: 'ok' },
  consume: { label: '消费', tone: 'rose' },
  grant: { label: '赠送', tone: 'blue' },
  refund: { label: '退款', tone: 'amber' },
};

function kindMeta(k: string): { label: string; tone: string } {
  return KIND_META[k] ?? { label: k, tone: 'blue' };
}

function fmtTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function signed(n: number): string {
  const v = Number(n) || 0;
  return `${v > 0 ? '+' : ''}${v.toLocaleString('zh-CN')}`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApiV3.ledger({
      page: page.value,
      pageSize,
      search: search.value,
      userId: userId.value ? Number(userId.value) : undefined,
      kind: kind.value || undefined,
    });
    items.value = res.items;
    total.value = res.total;
    summary.value = res.summary;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function doSearch(): Promise<void> {
  page.value = 1;
  await load();
}

async function reset(): Promise<void> {
  search.value = '';
  userId.value = '';
  kind.value = '';
  page.value = 1;
  await load();
}

async function goto(p: number): Promise<void> {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  await load();
}

onMounted(load);

defineExpose({ reload: load });
</script>

<template>
  <div class="ledger">
    <!-- 汇总 -->
    <section class="lsum">
      <div class="lsum__item lsum__item--in">
        <span>累计入账</span>
        <strong>{{ summary.inflow.toLocaleString('zh-CN') }}</strong>
        <small>充值 + 赠送</small>
      </div>
      <div class="lsum__item lsum__item--out">
        <span>累计扣减</span>
        <strong>{{ summary.outflow.toLocaleString('zh-CN') }}</strong>
        <small>AI 与知识库消费</small>
      </div>
      <div class="lsum__item">
        <span>净流通</span>
        <strong>{{ (summary.inflow - summary.outflow).toLocaleString('zh-CN') }}</strong>
        <small>入账 − 扣减</small>
      </div>
    </section>

    <!-- 筛选 -->
    <div class="ltoolbar">
      <input
        v-model="search"
        class="nm-input ltoolbar__search"
        placeholder="搜索用户名 / 邮箱 / 关联单号"
        @keyup.enter="doSearch"
      />
      <input
        v-model="userId"
        class="nm-input ltoolbar__uid"
        type="number"
        min="1"
        placeholder="用户 ID"
        @keyup.enter="doSearch"
      />
      <select v-model="kind" class="nm-input ltoolbar__sel" @change="doSearch">
        <option value="">全部类型</option>
        <option value="recharge">充值</option>
        <option value="consume">消费</option>
        <option value="grant">赠送</option>
        <option value="refund">退款</option>
      </select>
      <button class="nm-btn nm-btn--sm" @click="doSearch"><NmIcon name="search" :size="13" />筛选</button>
      <button class="nm-btn nm-btn--sm" @click="reset">重置</button>
      <span class="ltoolbar__count">共 {{ total }} 条</span>
    </div>

    <!-- 列表 -->
    <div class="ltable-wrap">
      <table class="ltable">
        <thead>
          <tr>
            <th class="num">#</th>
            <th>用户</th>
            <th>类型</th>
            <th class="num">变动</th>
            <th class="num">变动后余额</th>
            <th>关联</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id">
            <td class="num muted">{{ r.id }}</td>
            <td>
              <div class="luser">
                <span>{{ r.username ?? '—' }}</span>
                <small>{{ r.email ?? '' }}</small>
              </div>
            </td>
            <td>
              <span class="ltag" :class="`ltag--${kindMeta(r.kind).tone}`">{{ kindMeta(r.kind).label }}</span>
            </td>
            <td class="num" :class="r.delta >= 0 ? 'is-in' : 'is-out'">{{ signed(r.delta) }}</td>
            <td class="num">{{ r.balanceAfter.toLocaleString('zh-CN') }}</td>
            <td class="muted lref" :title="r.ref ?? ''">{{ r.ref ?? '—' }}</td>
            <td class="muted">{{ fmtTime(r.createdAt) }}</td>
          </tr>
          <tr v-if="!items.length && !loading">
            <td colspan="7" class="empty">暂无流水记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="lpager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1" @click="goto(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages" @click="goto(page + 1)">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.ledger { display: flex; flex-direction: column; gap: 16px; }

.lsum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.lsum__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}
.lsum__item span { font-size: 11.5px; color: var(--fg-3); }
.lsum__item strong { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; }
.lsum__item small { font-size: 10.5px; color: var(--fg-3); }
.lsum__item--in strong { color: #0e9f6e; }
.lsum__item--out strong { color: #d93025; }

.ltoolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ltoolbar__search { max-width: 260px; }
.ltoolbar__uid { max-width: 110px; }
.ltoolbar__sel { max-width: 130px; }
.ltoolbar__count { margin-left: auto; font-size: 12px; color: var(--fg-3); }

.ltable-wrap {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.ltable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ltable th {
  text-align: left;
  padding: 10px 14px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  background: var(--bg-hover);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.ltable td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ltable tbody tr:last-child td { border-bottom: none; }
.ltable tbody tr:hover { background: var(--bg-hover); }
.ltable .num { text-align: right; font-variant-numeric: tabular-nums; }
.ltable .muted { color: var(--fg-3); font-size: 11.5px; }
.ltable .is-in { color: #0e9f6e; font-weight: 600; }
.ltable .is-out { color: #d93025; font-weight: 600; }
.lref { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.luser { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.luser small { font-size: 10.5px; color: var(--fg-3); }

.ltag { font-size: 10.5px; padding: 2px 8px; border-radius: 9px; white-space: nowrap; }
.ltag--ok { background: rgba(16, 185, 129, 0.12); color: #0e9f6e; }
.ltag--rose { background: rgba(244, 63, 94, 0.12); color: #d93025; }
.ltag--blue { background: rgba(59, 130, 246, 0.12); color: #2563eb; }
.ltag--amber { background: rgba(245, 158, 11, 0.14); color: #b45309; }

.lpager { display: flex; align-items: center; justify-content: center; gap: 14px; font-size: 12px; color: var(--fg-3); }
.empty { text-align: center; color: var(--fg-3); padding: 30px 12px; }

@media (max-width: 1280px) {
  .lsum { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 1000px) {
  .lsum { grid-template-columns: minmax(0, 1fr); }
  .ltable-wrap { overflow-x: auto; }
  .ltable { min-width: 680px; }
}
</style>
