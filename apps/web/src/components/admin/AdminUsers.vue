<script setup lang="ts">
/**
 * 后台 · 用户与配额（1.4.0 大幅扩展）。
 *
 * ## 1.3.1 及以前的能力（保留不变）
 * 搜索/状态/排序筛选、分页、角色与状态切换、重置密码、删除、详情与积分调整。
 *
 * ## 1.4.0 新增（本文件的核心）
 * 1. **封禁 / 解封**：带原因与到期时间。数据层用 `status='disabled' + ban_reason` 表达
 *    （不新增 ENUM 值，避免破坏 auth / `/api/auth/me` / 列表筛选等既有消费方）。
 *    到期后由服务端**惰性解封**（列表接口入口顺手纠正），无需定时任务。
 * 2. **批量操作**：勾选多行 → 批量禁用 / 启用 / 发放积分 / 调整角色。
 *    服务端逐条执行并返回逐条结果，部分失败不会拖垮整批。
 * 3. **登录记录 / 最后活跃**：来自审计表聚合（`auth.login` / `auth.login_failed`），不新增表；
 *    列表新增「最后活跃」列（审计表 MAX(created_at)）。
 * 4. **用户数据概览**：仓库/文档/分享/发布/AI 用量/积分/配额，聚合数字一个弹窗看全。
 * 5. **导出 CSV**：按当前筛选条件导出，带 UTF-8 BOM（Excel 中文不乱码）。
 * 6. **角色调整**：独立接口与独立审计动作（`admin.user.role`），比笼统的 update 更可追溯。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { adminApi, adminApiV2, type UserDto } from '@/api/client';
import { formatCompactNumber } from '@neomd/shared';
import { fmtTime } from './shared';
import {
  banUser,
  batchUsers,
  exportUsersCsv,
  fetchUserLogins,
  fetchUserOverview,
  setUserRole,
  unbanUser,
  type AdminUserRow,
  type BatchResult,
  type LoginRecord,
  type UserOverview,
} from './admin-api';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const PAGE_SIZE = 20;

/** 服务端 1.4.0 起返回封禁与活跃字段；这里把它当 UserDto 的超集用 */
type UserRow = UserDto & Partial<AdminUserRow>;

const users = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const search = ref('');
const status = ref('');
const role = ref('');
const sort = ref('created');
const selected = ref<number[]>([]);
const exporting = ref(false);
const batchBusy = ref(false);

const detail = ref<Record<string, unknown> | null>(null);
const detailOpen = ref(false);
const creditAmount = ref(100);
const creditReason = ref('管理员调整');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 当前页是否全选 */
const allSelected = computed(() => users.value.length > 0 && selected.value.length === users.value.length);
const someSelected = computed(() => selected.value.length > 0 && !allSelected.value);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApi.users({
      page: page.value,
      pageSize: PAGE_SIZE,
      search: search.value.trim() || undefined,
      sort: sort.value || undefined,
      status: status.value || undefined,
    });
    users.value = res.items as UserRow[];
    total.value = res.total;
    // 清掉已不在当前页的选中项（避免「跨页残留选中」造成批量误操作）
    const visible = new Set(users.value.map((u) => u.id));
    selected.value = selected.value.filter((id) => visible.has(id));
    // 当前页超界时回退
    if (users.value.length === 0 && page.value > 1 && total.value > 0) {
      page.value = totalPages.value;
      return load();
    }
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function applyFilter(): Promise<void> {
  page.value = 1;
  selected.value = [];
  await load();
}

async function gotoPage(p: number): Promise<void> {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  selected.value = [];
  await load();
  const scroller = document.querySelector('.adm-body');
  if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- 选择 ---------------- */

function toggleAll(): void {
  if (allSelected.value) selected.value = [];
  else selected.value = users.value.map((u) => u.id);
}

function toggleOne(id: number): void {
  const idx = selected.value.indexOf(id);
  if (idx >= 0) selected.value.splice(idx, 1);
  else selected.value.push(id);
}

/* ---------------- 封禁状态展示 ---------------- */

/**
 * 状态展示：必须区分「封禁」与「人工禁用」。
 *
 * 两者数据层都是 `status='disabled'`，区别在 `ban_reason`：
 * 有原因 = 封禁（可能是临时的），无原因 = 管理员手工停用。
 * 统一由服务端派生的 `banned` 字段判定，前端不自己拼条件。
 */
function statusView(u: UserRow): { text: string; cls: string; title: string } {
  if (u.banned) {
    const until = u.banUntil ? `至 ${fmtTime(u.banUntil)}` : '永久';
    return { text: '已封禁', cls: 'adm-badge--danger', title: `原因：${u.banReason ?? '—'}\n到期：${until}` };
  }
  if (u.status !== 'active') return { text: '已禁用', cls: 'adm-badge--warn', title: '管理员手工停用（无封禁记录）' };
  return { text: '正常', cls: 'adm-badge--ok', title: '账号正常' };
}

/* ---------------- 单个操作 ---------------- */

async function toggleStatus(u: UserRow): Promise<void> {
  // 封禁中的账号点状态徽章 → 走解封（比「先解封再启用」少一步）
  if (u.banned) return unban(u);
  try {
    await adminApi.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' });
    await load();
    emit('notify', `${u.username} 已${u.status === 'active' ? '禁用' : '启用'}`);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function toggleRole(u: UserRow): Promise<void> {
  const next = u.role === 'admin' ? 'user' : 'admin';
  if (!window.confirm(`${u.username}：${next === 'admin' ? '设为管理员' : '撤销管理员'}？`)) return;
  try {
    const res = await setUserRole(u.id, next);
    await load();
    emit('notify', res.message);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function resetPassword(u: UserRow): Promise<void> {
  if (!window.confirm(`重置 ${u.username} 的密码？新密码只显示一次。`)) return;
  try {
    const res = await adminApi.resetPassword(u.id);
    emit('notify', `${u.username} 的新密码：${res.password}`);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function remove(u: UserRow): Promise<void> {
  if (!window.confirm(`删除用户 ${u.username}？不可恢复。`)) return;
  try {
    await adminApi.deleteUser(u.id);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

/* ---------------- 封禁 / 解封 ---------------- */

const banOpen = ref(false);
const banTarget = ref<UserRow | null>(null);
const banReason = ref('');
const banPreset = ref<'1h' | '24h' | '7d' | '30d' | 'forever'>('24h');
const banBusy = ref(false);

const banHours = computed<number | undefined>(() => {
  switch (banPreset.value) {
    case '1h':
      return 1;
    case '24h':
      return 24;
    case '7d':
      return 24 * 7;
    case '30d':
      return 24 * 30;
    default:
      return undefined; // 永久
  }
});

function openBan(u: UserRow): void {
  banTarget.value = u;
  banReason.value = '';
  banPreset.value = '24h';
  banOpen.value = true;
}

async function submitBan(): Promise<void> {
  const u = banTarget.value;
  if (!u || banReason.value.trim().length < 2) return;
  banBusy.value = true;
  try {
    const res = await banUser(u.id, { reason: banReason.value.trim(), hours: banHours.value });
    banOpen.value = false;
    await load();
    emit('notify', res.message);
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    banBusy.value = false;
  }
}

async function unban(u: UserRow): Promise<void> {
  if (!window.confirm(`解封 ${u.username}？账号将恢复为正常状态，可立即登录。`)) return;
  try {
    const res = await unbanUser(u.id);
    await load();
    emit('notify', res.message);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

/* ---------------- 批量操作 ---------------- */

const batchOpen = ref(false);
const batchAction = ref<'disable' | 'enable' | 'grant' | 'role'>('disable');
const batchAmount = ref(100);
const batchReason = ref('管理员批量调整');
const batchRole = ref<'user' | 'admin'>('user');
const batchResult = ref<BatchResult | null>(null);

function openBatch(): void {
  if (!selected.value.length) return;
  batchResult.value = null;
  batchOpen.value = true;
}

async function submitBatch(): Promise<void> {
  if (!selected.value.length) return;
  const labels: Record<string, string> = {
    disable: '禁用',
    enable: '启用',
    grant: `每人发放 ${batchAmount.value} 积分`,
    role: `设为${batchRole.value === 'admin' ? '管理员' : '普通用户'}`,
  };
  if (!batchResult.value && !window.confirm(`确认对选中的 ${selected.value.length} 个用户执行「${labels[batchAction.value]}」？`)) {
    return;
  }
  batchBusy.value = true;
  try {
    const res = await batchUsers({
      ids: selected.value,
      action: batchAction.value,
      ...(batchAction.value === 'grant' ? { amount: batchAmount.value, reason: batchReason.value } : {}),
      ...(batchAction.value === 'role' ? { role: batchRole.value } : {}),
    });
    batchResult.value = res;
    await load();
    emit('notify', res.message);
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    batchBusy.value = false;
  }
}

/* ---------------- 导出 CSV ---------------- */

async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    const size = await exportUsersCsv({
      search: search.value.trim() || undefined,
      status: status.value || undefined,
      role: role.value || undefined,
      sort: sort.value || undefined,
    });
    emit('notify', `已导出 CSV（${(size / 1024).toFixed(1)} KB，当前筛选条件）`);
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    exporting.value = false;
  }
}

/* ---------------- 详情 / 概览 / 登录记录 ---------------- */

const detailTab = ref<'overview' | 'raw' | 'logins'>('overview');
const overview = ref<UserOverview['overview'] | null>(null);
const overviewLoading = ref(false);
const logins = ref<LoginRecord[]>([]);
const loginSummary = ref<{ success: number; failed: number; lastSuccessAt: string | null } | null>(null);
const loginsLoading = ref(false);
const loginFailuresOnly = ref(false);

async function openDetail(u: UserRow): Promise<void> {
  detailOpen.value = true;
  detailTab.value = 'overview';
  overview.value = null;
  logins.value = [];
  loginSummary.value = null;
  try {
    detail.value = await adminApiV2.userDetail(u.id);
    await loadOverview(u.id);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function loadOverview(id: number): Promise<void> {
  overviewLoading.value = true;
  try {
    const res = await fetchUserOverview(id);
    overview.value = res.overview;
    detail.value = { ...(detail.value ?? {}), user: res.user };
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    overviewLoading.value = false;
  }
}

async function loadLogins(id: number): Promise<void> {
  loginsLoading.value = true;
  try {
    const res = await fetchUserLogins(id, { pageSize: 50, failuresOnly: loginFailuresOnly.value });
    logins.value = res.items;
    loginSummary.value = res.summary;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loginsLoading.value = false;
  }
}

async function switchDetailTab(t: 'overview' | 'raw' | 'logins'): Promise<void> {
  detailTab.value = t;
  const u = detail.value?.user as { id?: number } | undefined;
  if (!u?.id) return;
  if (t === 'logins' && !logins.value.length) await loadLogins(u.id);
  if (t === 'overview' && !overview.value) await loadOverview(u.id);
}

async function adjustCredits(): Promise<void> {
  const u = detail.value?.user as { id?: number } | undefined;
  if (!u?.id) return;
  try {
    await adminApiV2.adjustCredits(u.id, { amount: creditAmount.value, reason: creditReason.value });
    emit('notify', '积分已调整');
    detail.value = await adminApiV2.userDetail(u.id);
    await loadOverview(u.id);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

function bytes(n: number): string {
  return formatCompactNumber(Number(n) || 0);
}

function fmtBytes(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const s = v / 1024 ** i;
  return `${s >= 100 ? s.toFixed(0) : s.toFixed(1)} ${units[i]}`;
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="usr">
    <header class="adm-page-head">
      <div>
        <h2>用户与配额</h2>
        <p>
          点角色/状态徽章可直接切换；「封禁」需填写原因并可设到期时间，「详情」里可看数据概览与登录记录。
          所有写操作都会记入审计日志。
        </p>
      </div>
      <div class="adm-page-actions">
        <button
          class="nm-btn nm-btn--sm"
          :disabled="exporting"
          data-testid="export-csv"
          @click="doExport"
        >
          <NmIcon name="download" :size="13" />{{ exporting ? '导出中…' : '导出 CSV' }}
        </button>
      </div>
    </header>

    <div class="adm-toolbar">
      <input v-model="search" class="nm-input adm-toolbar__search" placeholder="搜索用户名或邮箱" @keyup.enter="applyFilter" />
      <select v-model="status" class="nm-input adm-toolbar__sel" @change="applyFilter">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="disabled">已禁用/封禁</option>
      </select>
      <select v-model="sort" class="nm-input adm-toolbar__sel" @change="applyFilter">
        <option value="created">按注册时间</option>
        <option value="lastLogin">按最近登录</option>
        <option value="credits">按积分</option>
        <option value="documents">按文档数</option>
      </select>
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="applyFilter">搜索</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">共 {{ total }} 位</span>
    </div>

    <!-- 批量操作条：有选中才出现，避免常驻干扰 -->
    <div v-if="selected.length" class="usr__batchbar" data-testid="batch-bar">
      <span>已选 <b>{{ selected.length }}</b> 位用户</span>
      <button class="nm-btn nm-btn--sm nm-btn--primary" data-testid="batch-open" @click="openBatch">
        批量操作
      </button>
      <button class="nm-btn nm-btn--sm" @click="selected = []">取消选择</button>
    </div>

    <table class="adm-table">
      <thead>
        <tr>
          <th style="width: 40px;">
            <input
              type="checkbox"
              :checked="allSelected"
              :indeterminate.prop="someSelected"
              data-testid="select-all"
              @change="toggleAll"
            />
          </th>
          <th>用户</th>
          <th>邮箱</th>
          <th style="width: 84px;">角色</th>
          <th style="width: 92px;">状态</th>
          <th class="adm-right" style="width: 92px;">积分</th>
          <th style="width: 140px;">最后活跃</th>
          <th class="adm-right" style="width: 280px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>
            <input
              type="checkbox"
              :checked="selected.includes(u.id)"
              data-testid="select-one"
              @change="toggleOne(u.id)"
            />
          </td>
          <td class="adm-strong">
            {{ u.username }}
            <span v-if="u.banned" class="usr__bantag" :title="`原因：${u.banReason ?? ''}`">
              封禁中{{ u.banUntil ? ` · 至 ${fmtTime(u.banUntil)}` : ' · 永久' }}
            </span>
          </td>
          <td class="adm-muted">{{ u.email }}</td>
          <td>
            <button class="adm-badge" :class="{ 'adm-badge--accent': u.role === 'admin' }" @click="toggleRole(u)">
              {{ u.role === 'admin' ? '管理员' : '普通' }}
            </button>
          </td>
          <td>
            <button
              class="adm-badge"
              :class="statusView(u).cls"
              :title="statusView(u).title"
              @click="toggleStatus(u)"
            >
              {{ statusView(u).text }}
            </button>
          </td>
          <td class="adm-right">{{ formatCompactNumber(u.credits ?? 0) }}</td>
          <td class="adm-muted">{{ fmtTime(u.lastActiveAt ?? u.lastLoginAt) }}</td>
          <td class="adm-right">
            <button class="adm-rowbtn" @click="openDetail(u)">详情</button>
            <button
              v-if="u.banned"
              class="adm-rowbtn"
              data-testid="unban-btn"
              @click="unban(u)"
            >解封</button>
            <button
              v-else
              class="adm-rowbtn adm-rowbtn--danger"
              data-testid="ban-btn"
              @click="openBan(u)"
            >封禁</button>
            <button class="adm-rowbtn" @click="resetPassword(u)">重置密码</button>
            <button class="adm-rowbtn adm-rowbtn--danger" @click="remove(u)">删除</button>
          </td>
        </tr>
        <tr v-if="!users.length">
          <td colspan="8" class="adm-empty">{{ loading ? '加载中…' : '没有匹配的用户' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="totalPages > 1" class="adm-pager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
      <span class="adm-muted usr__pagerinfo">每页 {{ PAGE_SIZE }} 条</span>
    </div>

    <!-- ======================== 封禁弹窗 ======================== -->
    <NmModal v-model="banOpen" title="封禁用户" :width="560">
      <div v-if="banTarget" class="usr__form">
        <p class="adm-note">
          正在封禁 <strong>{{ banTarget.username }}</strong>（{{ banTarget.email }}）。
          封禁后该用户会立即掉线，且无法登录；到期后自动解封。
        </p>
        <label class="adm-field">
          <span class="nm-label">封禁原因（必填，会展示给审计，也可用于向用户说明）</span>
          <input
            v-model="banReason"
            class="nm-input"
            maxlength="255"
            placeholder="例如：发布违规内容 / 滥用 AI 接口"
            data-testid="ban-reason"
          />
        </label>
        <label class="adm-field">
          <span class="nm-label">封禁时长</span>
          <select v-model="banPreset" class="nm-input" data-testid="ban-preset">
            <option value="1h">1 小时</option>
            <option value="24h">24 小时</option>
            <option value="7d">7 天</option>
            <option value="30d">30 天</option>
            <option value="forever">永久封禁</option>
          </select>
        </label>
        <p class="nm-hint">
          到期后服务端在下次读取用户列表时自动解封（惰性），无需定时任务。
        </p>
      </div>
      <template #footer>
        <button class="nm-btn" :disabled="banBusy" @click="banOpen = false">取消</button>
        <button
          class="nm-btn nm-btn--danger"
          :disabled="banBusy || banReason.trim().length < 2"
          data-testid="ban-submit"
          @click="submitBan"
        >{{ banBusy ? '提交中…' : '确认封禁' }}</button>
      </template>
    </NmModal>

    <!-- ======================== 批量操作弹窗 ======================== -->
    <NmModal v-model="batchOpen" title="批量操作" :width="620">
      <div class="usr__form">
        <p class="adm-note">
          将对 <strong>{{ selected.length }}</strong> 位用户执行操作。
          不合规的条目（例如你自己、或系统最后一个管理员）会被**逐条跳过**，不影响其余用户。
        </p>
        <label class="adm-field">
          <span class="nm-label">操作类型</span>
          <select v-model="batchAction" class="nm-input" data-testid="batch-action">
            <option value="disable">批量禁用</option>
            <option value="enable">批量启用（同时清除封禁）</option>
            <option value="grant">批量发放积分</option>
            <option value="role">批量调整角色</option>
          </select>
        </label>
        <div v-if="batchAction === 'grant'" class="usr__inline">
          <label class="adm-field">
            <span class="nm-label">每人积分（可负）</span>
            <input v-model.number="batchAmount" type="number" class="nm-input" data-testid="batch-amount" />
          </label>
          <label class="adm-field usr__grow">
            <span class="nm-label">备注</span>
            <input v-model="batchReason" class="nm-input" />
          </label>
        </div>
        <label v-if="batchAction === 'role'" class="adm-field">
          <span class="nm-label">目标角色</span>
          <select v-model="batchRole" class="nm-input">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>

        <!-- 逐条结果 -->
        <div v-if="batchResult" class="adm-note" data-testid="batch-result">
          <strong>{{ batchResult.message }}</strong>
          <ul class="usr__issues">
            <li v-for="r in batchResult.results" :key="r.id">
              <span :class="r.ok ? 'usr__ok' : 'usr__no'">{{ r.ok ? '✓' : '✕' }}</span>
              {{ r.username ?? `#${r.id}` }}
              <span v-if="!r.ok" class="adm-muted">— {{ r.reason }}</span>
              <span v-else-if="r.delta !== undefined" class="adm-muted">— 余额 {{ r.balance }}</span>
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <button class="nm-btn" :disabled="batchBusy" @click="batchOpen = false">关闭</button>
        <button class="nm-btn nm-btn--primary" :disabled="batchBusy" data-testid="batch-submit" @click="submitBatch">
          {{ batchBusy ? '执行中…' : '执行' }}
        </button>
      </template>
    </NmModal>

    <!-- ======================== 详情弹窗（概览/原始/登录记录） ======================== -->
    <NmModal v-model="detailOpen" title="用户详情" :width="860">
      <div v-if="detail" class="detail">
        <div class="adm-seg usr__tabs">
          <button :class="{ 'is-on': detailTab === 'overview' }" data-testid="tab-overview" @click="switchDetailTab('overview')">数据概览</button>
          <button :class="{ 'is-on': detailTab === 'logins' }" data-testid="tab-logins" @click="switchDetailTab('logins')">登录记录</button>
          <button :class="{ 'is-on': detailTab === 'raw' }" @click="switchDetailTab('raw')">原始数据</button>
        </div>

        <!-- 数据概览 -->
        <div v-if="detailTab === 'overview'">
          <div v-if="overviewLoading" class="usr__loading">加载中…</div>
          <div v-else-if="overview" class="usr__ovgrid" data-testid="overview-grid">
            <div class="usr__ovcard">
              <span>仓库 / 文档</span>
              <b>{{ overview.vaults.total }} / {{ overview.vaults.documents }}</b>
              <i>停用仓库 {{ overview.vaults.disabled }} · {{ fmtBytes(overview.vaults.bytes) }}</i>
            </div>
            <div class="usr__ovcard">
              <span>分享</span>
              <b>{{ overview.shares.active }} / {{ overview.shares.total }}</b>
              <i>浏览 {{ formatCompactNumber(overview.shares.views) }} · 评论 {{ overview.shares.comments }}</i>
            </div>
            <div class="usr__ovcard">
              <span>网页发布</span>
              <b>{{ overview.publishes.active }} / {{ overview.publishes.total }}</b>
              <i>在线 / 累计</i>
            </div>
            <div class="usr__ovcard">
              <span>AI 调用</span>
              <b>{{ formatCompactNumber(overview.ai.calls) }}</b>
              <i>
                入 {{ formatCompactNumber(overview.ai.inTokens) }} / 出 {{ formatCompactNumber(overview.ai.outTokens) }}
                token · 失败 {{ overview.ai.errors }}
              </i>
            </div>
            <div class="usr__ovcard">
              <span>积分余额</span>
              <b>{{ formatCompactNumber(overview.credits.balance) }}</b>
              <i>入 {{ overview.credits.inflow }} / 出 {{ overview.credits.outflow }} · {{ overview.credits.entries }} 笔流水</i>
            </div>
            <div class="usr__ovcard">
              <span>配额使用</span>
              <b>{{ (overview.quota.usageRatio * 100).toFixed(1) }}%</b>
              <i>{{ fmtBytes(overview.quota.storageBytes) }} / {{ fmtBytes(overview.quota.quotaBytes) }}</i>
            </div>
          </div>
          <p v-if="overview" class="nm-hint">
            最后登录 {{ fmtTime(overview.activity.lastLoginAt) }} · 最后活跃 {{ fmtTime(overview.activity.lastActiveAt) }}
          </p>

          <h4>手动增加 / 扣减积分</h4>
          <div class="inline-form">
            <input v-model.number="creditAmount" class="nm-input nm-input--num" type="number" />
            <input v-model="creditReason" class="nm-input" placeholder="调整原因" />
            <button class="nm-btn nm-btn--primary nm-btn--sm" @click="adjustCredits">执行</button>
          </div>
          <p class="nm-hint">正数增加、负数扣减；调整会写一条 <code>credit_ledger</code> 流水，可在「积分流水」页查到。</p>
        </div>

        <!-- 登录记录 -->
        <div v-else-if="detailTab === 'logins'">
          <div v-if="loginSummary" class="usr__loginsum" data-testid="login-summary">
            成功 <b class="usr__ok">{{ loginSummary.success }}</b> 次 ·
            失败 <b class="usr__no">{{ loginSummary.failed }}</b> 次 ·
            最近成功 {{ fmtTime(loginSummary.lastSuccessAt) }}
            <label class="usr__check">
              <input v-model="loginFailuresOnly" type="checkbox" @change="loadLogins(Number((detail?.user as { id?: number })?.id ?? 0))" />
              只看失败
            </label>
          </div>
          <table class="adm-table adm-table--tight">
            <thead>
              <tr>
                <th style="width: 150px;">时间</th>
                <th style="width: 100px;">结果</th>
                <th style="width: 130px;">原因</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in logins" :key="l.id">
                <td class="adm-muted">{{ fmtTime(l.createdAt) }}</td>
                <td>
                  <span class="adm-badge" :class="l.success ? 'adm-badge--ok' : 'adm-badge--danger'">
                    {{ l.success ? '成功' : '失败' }}
                  </span>
                </td>
                <td class="adm-muted">{{ l.reason ?? '—' }}</td>
                <td class="adm-mono adm-muted">{{ l.ip ?? '—' }}</td>
              </tr>
              <tr v-if="!logins.length">
                <td colspan="4" class="adm-empty">{{ loginsLoading ? '加载中…' : '暂无登录记录' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 原始数据 -->
        <div v-else>
          <pre class="detail__json">{{ JSON.stringify(detail.user, null, 2) }}</pre>
        </div>
      </div>
      <template #footer>
        <button class="nm-btn" @click="detailOpen = false">关闭</button>
      </template>
    </NmModal>
  </div>
</template>

<style scoped>
.inline-form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.nm-input--num { width: 110px; flex: 0 0 auto; }
.detail__json {
  background: #f7f8fa;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  max-height: 320px;
  overflow: auto;
}
.detail h4 { margin: 18px 0 10px; font-size: 13px; color: #1f2329; }

.usr__batchbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--adm-accent-weak);
  color: var(--adm-accent-deep);
  font-size: 13px;
}
.usr__batchbar b { font-weight: 700; }
.usr__bantag {
  margin-left: 7px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--adm-danger-weak, #fee2e2);
  color: var(--adm-danger, #d93025);
  font-size: 10.5px;
  font-weight: 600;
}
.usr__pagerinfo { margin-left: 6px; font-size: 12px; }
.usr__form { display: flex; flex-direction: column; gap: 12px; }
.usr__inline { display: flex; gap: 12px; align-items: flex-end; }
.usr__grow { flex: 1; min-width: 0; }
.usr__issues { margin: 6px 0 0; padding-left: 4px; list-style: none; max-height: 200px; overflow: auto; }
.usr__issues li { margin: 2px 0; font-size: 12.5px; }
.usr__ok { color: #0e9f6e; font-weight: 600; }
.usr__no { color: #d93025; font-weight: 600; }

.usr__tabs { margin-bottom: 16px; }
.usr__ovgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.usr__ovcard {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid #e8eaee;
  border-radius: 10px;
  background: #fbfcfd;
}
.usr__ovcard span { font-size: 11.5px; color: #6b7280; }
.usr__ovcard b { font-size: 19px; font-weight: 650; color: #1f2329; line-height: 1.2; }
.usr__ovcard i { font-style: normal; font-size: 11px; color: #8a9099; line-height: 1.5; }
.usr__loginsum { margin-bottom: 12px; font-size: 12.5px; color: #4b5563; }
.usr__check { display: inline-flex; align-items: center; gap: 6px; margin-left: 14px; font-size: 12.5px; }
.usr__loading { padding: 26px 0; text-align: center; color: #6b7280; font-size: 13px; }

@media (max-width: 900px) {
  .usr__ovgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
