<script setup lang="ts">
/**
 * 后台 · 用户与配额（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 包含：搜索/状态/排序筛选、分页、角色与状态切换、重置密码、删除、详情与积分调整。
 * 用户详情弹窗也搬到这里 —— 它与「调积分」强耦合，留在父组件会让父组件继续持有业务状态。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { adminApi, adminApiV2, type UserDto } from '@/api/client';
import { formatCompactNumber } from '@neomd/shared';
import { fmtTime } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const PAGE_SIZE = 20;

const users = ref<UserDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const search = ref('');
const status = ref('');
const sort = ref('created');

const detail = ref<Record<string, unknown> | null>(null);
const detailOpen = ref(false);
const creditAmount = ref(100);
const creditReason = ref('管理员调整');

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

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
    users.value = res.items;
    total.value = res.total;
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

async function toggleStatus(u: UserDto): Promise<void> {
  try {
    await adminApi.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' });
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function toggleRole(u: UserDto): Promise<void> {
  if (!window.confirm(`${u.username}：${u.role === 'admin' ? '撤销管理员' : '设为管理员'}？`)) return;
  try {
    await adminApi.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function resetPassword(u: UserDto): Promise<void> {
  if (!window.confirm(`重置 ${u.username} 的密码？新密码只显示一次。`)) return;
  try {
    const res = await adminApi.resetPassword(u.id);
    emit('notify', `${u.username} 的新密码：${res.password}`);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function remove(u: UserDto): Promise<void> {
  if (!window.confirm(`删除用户 ${u.username}？不可恢复。`)) return;
  try {
    await adminApi.deleteUser(u.id);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function openDetail(u: UserDto): Promise<void> {
  try {
    detail.value = await adminApiV2.userDetail(u.id);
    detailOpen.value = true;
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function adjustCredits(): Promise<void> {
  const u = detail.value?.user as { id?: number } | undefined;
  if (!u?.id) return;
  try {
    await adminApiV2.adjustCredits(u.id, { amount: creditAmount.value, reason: creditReason.value });
    emit('notify', '积分已调整');
    detail.value = await adminApiV2.userDetail(u.id);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="usr">
    <header class="adm-page-head">
      <div>
        <h2>用户与配额</h2>
        <p>点角色/状态徽章可直接切换；积分调整与账号详情在「详情/调积分」里，所有写操作都会记入审计日志。</p>
      </div>
    </header>

    <div class="adm-toolbar">
      <input v-model="search" class="nm-input adm-toolbar__search" placeholder="搜索用户名或邮箱" @keyup.enter="applyFilter" />
      <select v-model="status" class="nm-input adm-toolbar__sel" @change="applyFilter">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="disabled">已禁用</option>
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

    <table class="adm-table">
      <thead>
        <tr>
          <th>用户</th>
          <th>邮箱</th>
          <th style="width: 92px;">角色</th>
          <th style="width: 92px;">状态</th>
          <th class="adm-right" style="width: 100px;">积分</th>
          <th style="width: 150px;">注册时间</th>
          <th class="adm-right" style="width: 210px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td class="adm-strong">{{ u.username }}</td>
          <td class="adm-muted">{{ u.email }}</td>
          <td>
            <button class="adm-badge" :class="{ 'adm-badge--accent': u.role === 'admin' }" @click="toggleRole(u)">
              {{ u.role === 'admin' ? '管理员' : '普通' }}
            </button>
          </td>
          <td>
            <button class="adm-badge" :class="{ 'adm-badge--danger': u.status !== 'active' }" @click="toggleStatus(u)">
              {{ u.status === 'active' ? '正常' : '已禁用' }}
            </button>
          </td>
          <td class="adm-right">{{ formatCompactNumber(u.credits ?? 0) }}</td>
          <td class="adm-muted">{{ fmtTime(u.createdAt) }}</td>
          <td class="adm-right">
            <button class="adm-rowbtn" @click="openDetail(u)">详情/调积分</button>
            <button class="adm-rowbtn" @click="resetPassword(u)">重置密码</button>
            <button class="adm-rowbtn adm-rowbtn--danger" @click="remove(u)">删除</button>
          </td>
        </tr>
        <tr v-if="!users.length">
          <td colspan="7" class="adm-empty">{{ loading ? '加载中…' : '没有匹配的用户' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="totalPages > 1" class="adm-pager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
    </div>

    <NmModal v-model="detailOpen" title="用户详情与积分调整" :width="680">
      <div v-if="detail" class="detail">
        <pre class="detail__json">{{ JSON.stringify(detail.user, null, 2) }}</pre>
        <h4>手动增加 / 扣减积分</h4>
        <div class="inline-form">
          <input v-model.number="creditAmount" class="nm-input nm-input--num" type="number" />
          <input v-model="creditReason" class="nm-input" placeholder="调整原因" />
          <button class="nm-btn nm-btn--primary nm-btn--sm" @click="adjustCredits">执行</button>
        </div>
        <p class="nm-hint">正数增加、负数扣减；调整会写一条 <code>credit_ledger</code> 流水，可在「积分流水」页查到。</p>
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
  max-height: 260px;
  overflow: auto;
}
.detail h4 { margin: 18px 0 10px; font-size: 13px; color: #1f2329; }
</style>
