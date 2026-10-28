<script setup lang="ts">
/**
 * 后台 · 知识库令牌治理（1.1.9 新增）。
 *
 * 解决的运维盲区：用户侧只能看到自己的令牌，一旦出现「离职账号还留着有效令牌」
 * 「某枚可写令牌在外部被滥用」，运营没有任何入口。本页提供全局视角：
 *  - 分页列表 + 按用户 / 状态 / 名称筛选；
 *  - 风险审计（账号停用、可写权限、永不过期、从未使用、超 90 天未用）；
 *  - 管理员可直接吊销任意用户令牌（写审计日志 `admin.knowledge_token.revoke`）。
 *
 * 安全约定：接口只返回令牌前 12 位前缀，**明文与哈希永远不会再出现**
 * （明文只在用户创建令牌的那一次响应里出现过）。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { api } from '@/api/client';
import { RISK_SIGNAL_LABELS, fmtAgo, fmtTime, riskLevelLabel, tokenStatusLabel } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

/** 令牌行（管理员视角：比用户侧多出 owner 与 risk 两组字段） */
interface AdminKnowledgeTokenRow {
  id: number;
  name: string;
  tokenPrefix: string;
  scope: 'read' | 'write';
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  status: 'active' | 'revoked' | 'expired';
  usable: boolean;
  userId: number;
  username: string | null;
  email: string | null;
  ownerStatus: 'active' | 'disabled' | null;
  risk: { level: 'none' | 'medium' | 'high'; signals: string[] };
}

interface Summary {
  total: number;
  active: number;
  revoked: number;
  expired: number;
  writeScope: number;
  /** 持有令牌的去重用户数（全库口径） */
  users: number;
  riskyOnPage: number;
  writeScopeOnPage: number;
  neverUsedOnPage: number;
  ownerDisabledOnPage: number;
}

const items = ref<AdminKnowledgeTokenRow[]>([]);
const summary = ref<Summary | null>(null);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const revoking = ref(0);

const search = ref('');
const status = ref<'' | 'active' | 'revoked' | 'expired'>('');
const userIdInput = ref<string>('');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

/**
 * 拉取列表。
 *
 * 注意 `userIdInput` 允许非数字（用户在输入框里打字时会短暂出现空串/字母），
 * 这里只在「是正整数」时才把它作为筛选条件发出去，避免 400 打断输入体验。
 */
async function load(): Promise<void> {
  loading.value = true;
  try {
    const q = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
    if (search.value.trim()) q.set('search', search.value.trim());
    if (status.value) q.set('status', status.value);
    const uid = Number(userIdInput.value.trim());
    if (Number.isInteger(uid) && uid > 0) q.set('userId', String(uid));
    const res = await api<{ items: AdminKnowledgeTokenRow[]; total: number; summary: Summary }>(
      `/api/admin/knowledge-tokens?${q}`,
      { auth: true },
    );
    items.value = res.items ?? [];
    total.value = res.total ?? 0;
    summary.value = res.summary ?? null;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function applyFilter(): Promise<void> {
  page.value = 1;
  await load();
}

async function gotoPage(p: number): Promise<void> {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  await load();
}

function resetFilter(): void {
  search.value = '';
  status.value = '';
  userIdInput.value = '';
  void applyFilter();
}

/** 吊销（管理员跨用户操作，必须二次确认并明确说明影响） */
async function revoke(row: AdminKnowledgeTokenRow): Promise<void> {
  const who = row.username ?? row.email ?? `用户 ${row.userId}`;
  if (!window.confirm(`确认吊销「${who}」的令牌「${row.name}」？\n吊销后该令牌立即失效，外部 AI 调用会返回 401。`)) {
    return;
  }
  revoking.value = row.id;
  try {
    const res = await api<{ alreadyRevoked: boolean }>(`/api/admin/knowledge-tokens/${row.id}`, {
      method: 'DELETE',
      auth: true,
    });
    emit('notify', res.alreadyRevoked ? '该令牌此前已被吊销' : `已吊销「${row.name}」，令牌立即失效`);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    revoking.value = 0;
  }
}

/** 风险信号 → 中文标签列表 */
function riskLabels(row: AdminKnowledgeTokenRow): string[] {
  return row.risk.signals.map((s) => RISK_SIGNAL_LABELS[s] ?? s);
}

onMounted(load);

defineExpose({ reload: load });
</script>

<template>
  <div class="kt">
    <header class="adm-page-head">
      <div>
        <h2>知识库令牌治理</h2>
        <p>
          全局查看所有用户的知识库访问令牌（<code>Authorization: Bearer nmd_kb_…</code>）。
          令牌明文只在用户创建时显示一次，这里只展示前 12 位前缀；发现异常可直接吊销，操作会记入审计日志。
        </p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 汇总指标：全库口径，不受下方筛选影响 -->
    <div class="adm-metric-grid" style="margin-bottom: 22px;">
      <article class="adm-metric">
        <span class="adm-metric__label">令牌总数</span>
        <span class="adm-metric__value">{{ summary?.total ?? 0 }}</span>
        <span class="adm-metric__sub">{{ summary?.users ?? 0 }} 个用户持有</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">有效令牌</span>
        <span class="adm-metric__value">{{ summary?.active ?? 0 }}</span>
        <span class="adm-metric__sub">未吊销且未过期</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">可写权限</span>
        <span class="adm-metric__value" :class="{ 'is-warn': (summary?.writeScope ?? 0) > 0 }">
          {{ summary?.writeScope ?? 0 }}
        </span>
        <span class="adm-metric__sub">泄露后影响面大于只读</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">已吊销</span>
        <span class="adm-metric__value">{{ summary?.revoked ?? 0 }}</span>
        <span class="adm-metric__sub">已过期 {{ summary?.expired ?? 0 }}</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">本页风险项</span>
        <span class="adm-metric__value" :class="{ 'is-danger': (summary?.ownerDisabledOnPage ?? 0) > 0 }">
          {{ summary?.riskyOnPage ?? 0 }}
        </span>
        <span class="adm-metric__sub">
          账号停用 <b>{{ summary?.ownerDisabledOnPage ?? 0 }}</b> · 从未使用 <b>{{ summary?.neverUsedOnPage ?? 0 }}</b>
        </span>
      </article>
    </div>

    <p class="adm-note">
      <NmIcon name="info" :size="14" />
      <span>
        风险判定为**可解释信号**而非黑箱打分：账号已停用但令牌仍有效（应立刻吊销）、可写权限、永不过期、
        创建后从未使用、超过 90 天未使用。已吊销/已过期的令牌不再判风险，避免噪声。
      </span>
    </p>

    <div class="adm-toolbar">
      <input
        v-model="search"
        class="nm-input adm-toolbar__search"
        placeholder="搜索令牌名称 / 前缀 / 用户名 / 邮箱"
        @keyup.enter="applyFilter"
      />
      <input
        v-model="userIdInput"
        class="nm-input adm-toolbar__num"
        placeholder="用户 ID"
        inputmode="numeric"
        @keyup.enter="applyFilter"
      />
      <select v-model="status" class="nm-input adm-toolbar__sel" @change="applyFilter">
        <option value="">全部状态</option>
        <option value="active">有效</option>
        <option value="revoked">已吊销</option>
        <option value="expired">已过期</option>
      </select>
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="applyFilter">筛选</button>
      <button class="nm-btn nm-btn--sm" @click="resetFilter">重置</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">共 {{ total }} 枚</span>
    </div>

    <div v-if="loading && !items.length" class="adm-empty">加载中…</div>

    <table v-else class="adm-table">
      <thead>
        <tr>
          <th>令牌</th>
          <th>所属用户</th>
          <th style="width: 92px;">状态</th>
          <th style="width: 200px;">最近使用</th>
          <th style="width: 170px;">有效期</th>
          <th style="width: 190px;">风险审计</th>
          <th class="adm-right" style="width: 100px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in items" :key="row.id">
          <td>
            <div class="adm-strong">{{ row.name }}</div>
            <div class="adm-mono adm-muted" style="margin-top: 2px;">{{ row.tokenPrefix }}…</div>
            <span class="adm-badge" :class="row.scope === 'write' ? 'adm-badge--warn' : 'adm-badge--muted'" style="margin-top: 4px;">
              {{ row.scope === 'write' ? '可写' : '只读' }}
            </span>
          </td>
          <td>
            <div class="adm-strong">{{ row.username ?? '—' }}</div>
            <div class="adm-muted" style="font-size: 11.5px;">{{ row.email ?? `ID ${row.userId}` }}</div>
            <span v-if="row.ownerStatus !== 'active'" class="adm-badge adm-badge--danger" style="margin-top: 4px;">
              账号已停用
            </span>
          </td>
          <td>
            <span class="adm-badge" :class="`adm-badge--${tokenStatusLabel(row.status).variant}`">
              {{ tokenStatusLabel(row.status).text }}
            </span>
          </td>
          <td>
            <div>{{ fmtAgo(row.lastUsedAt) }}</div>
            <div class="adm-muted" style="font-size: 11px;">{{ fmtTime(row.lastUsedAt) }}</div>
          </td>
          <td>
            <div v-if="row.expiresAt">{{ fmtTime(row.expiresAt) }}</div>
            <span v-else class="adm-badge adm-badge--warn">永不过期</span>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span class="adm-badge" :class="`adm-badge--${riskLevelLabel(row.risk.level).variant}`">
                {{ riskLevelLabel(row.risk.level).text }}
              </span>
              <span v-for="label in riskLabels(row)" :key="label" class="risk-chip">{{ label }}</span>
            </div>
          </td>
          <td class="adm-right">
            <button
              v-if="row.usable"
              class="adm-rowbtn adm-rowbtn--danger"
              :disabled="revoking === row.id"
              @click="revoke(row)"
            >
              {{ revoking === row.id ? '吊销中…' : '吊销' }}
            </button>
            <span v-else class="adm-muted" style="font-size: 11.5px;">不可用</span>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="7" class="adm-empty">没有匹配的知识库令牌</td>
        </tr>
      </tbody>
    </table>

    <div v-if="totalPages > 1" class="adm-pager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.risk-chip {
  font-size: 10.5px;
  padding: 1.5px 7px;
  border-radius: 8px;
  background: #f1f3f5;
  color: #4b5563;
  white-space: nowrap;
}
</style>
