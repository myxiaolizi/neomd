<script setup lang="ts">
/**
 * 仓库管理面板（1.1.7 新增）。
 *
 * 数据来源 `user_vaults` 表：一个用户可以拥有多个仓库，
 * 每个仓库有独立的文档数、占用字节与启停状态。
 *
 * 安全约定：停用/删除都只改注册表，**不动对象存储里的实体文件**，
 * 因此删除后仍可由同步流程重建，误操作可恢复。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV3, type AdminVaultDto } from '@/api/client';

const emit = defineEmits<{
  /** 操作成功后的提示，交由父级统一展示 */
  notify: [string];
  /** 操作失败 */
  fail: [string];
}>();

const items = ref<AdminVaultDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const search = ref('');
const status = ref('');
const loading = ref(false);
const summary = ref({ total: 0, bytes: 0, docs: 0, disabled: 0 });

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function bytes(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const scaled = v / 1024 ** i;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[i]}`;
}

function fmtTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApiV3.vaults({
      page: page.value,
      pageSize,
      search: search.value,
      status: status.value || undefined,
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

async function toggleStatus(v: AdminVaultDto): Promise<void> {
  const next = v.status === 'active' ? 'disabled' : 'active';
  const label = next === 'disabled' ? '停用' : '启用';
  if (!window.confirm(`确认${label}仓库「${v.name}」？\n\n停用后该仓库的同步接口会被拒绝，数据保留。`)) return;
  try {
    await adminApiV3.setVaultStatus(v.id, next);
    emit('notify', `仓库「${v.name}」已${label}`);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function remove(v: AdminVaultDto): Promise<void> {
  if (
    !window.confirm(
      `确认删除仓库「${v.name}」的注册记录？\n\n` +
        `· 用户：${v.username ?? '未知'}\n· 文档数：${v.docCount}\n· 占用：${bytes(v.bytes)}\n\n` +
        `注意：只删除注册记录，对象存储中的实体文件会保留。`,
    )
  ) {
    return;
  }
  try {
    await adminApiV3.deleteVault(v.id);
    emit('notify', `仓库「${v.name}」的注册记录已删除（实体文件保留）`);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function doSearch(): Promise<void> {
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
  <div class="vaults">
    <!-- 概览条 -->
    <section class="vsum">
      <div class="vsum__item">
        <span>仓库总数</span>
        <strong>{{ summary.total.toLocaleString('zh-CN') }}</strong>
      </div>
      <div class="vsum__item">
        <span>文档总数</span>
        <strong>{{ summary.docs.toLocaleString('zh-CN') }}</strong>
      </div>
      <div class="vsum__item">
        <span>占用空间</span>
        <strong>{{ bytes(summary.bytes) }}</strong>
      </div>
      <div class="vsum__item" :class="{ 'is-warn': summary.disabled > 0 }">
        <span>已停用</span>
        <strong>{{ summary.disabled }}</strong>
      </div>
    </section>

    <!-- 工具条 -->
    <div class="vtoolbar">
      <input
        v-model="search"
        class="nm-input vtoolbar__search"
        placeholder="搜索仓库名 / 仓库 ID / 用户名 / 邮箱"
        @keyup.enter="doSearch"
      />
      <select v-model="status" class="nm-input vtoolbar__sel" @change="doSearch">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="disabled">已停用</option>
      </select>
      <button class="nm-btn nm-btn--sm" @click="doSearch">
        <NmIcon name="search" :size="13" />搜索
      </button>
      <span class="vtoolbar__count">共 {{ total }} 个仓库</span>
    </div>

    <!-- 列表 -->
    <div class="vtable-wrap">
      <table class="vtable">
        <thead>
          <tr>
            <th>仓库</th>
            <th>归属用户</th>
            <th class="num">文档数</th>
            <th class="num">占用</th>
            <th>状态</th>
            <th>最近同步</th>
            <th class="right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in items" :key="v.id">
            <td>
              <div class="vname">
                <strong :title="v.name">{{ v.name }}</strong>
                <code :title="v.vaultId">{{ v.vaultId }}</code>
              </div>
            </td>
            <td>
              <div class="vowner">
                <span>{{ v.username ?? '—' }}</span>
                <small>{{ v.email ?? '' }}</small>
              </div>
            </td>
            <td class="num">{{ v.docCount.toLocaleString('zh-CN') }}</td>
            <td class="num">{{ bytes(v.bytes) }}</td>
            <td>
              <span class="vtag" :class="v.status === 'active' ? 'vtag--ok' : 'vtag--off'">
                {{ v.status === 'active' ? '正常' : '已停用' }}
              </span>
            </td>
            <td class="muted">{{ fmtTime(v.lastSyncedAt) }}</td>
            <td class="right">
              <button class="vbtn" @click="toggleStatus(v)">
                {{ v.status === 'active' ? '停用' : '启用' }}
              </button>
              <button class="vbtn vbtn--danger" @click="remove(v)">删除</button>
            </td>
          </tr>
          <tr v-if="!items.length && !loading">
            <td colspan="7" class="empty">暂无仓库数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="vpager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1" @click="goto(page - 1)">上一页</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages" @click="goto(page + 1)">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.vaults { display: flex; flex-direction: column; gap: 16px; }

.vsum {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.vsum__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}
.vsum__item span { font-size: 12px; color: var(--fg-3); }
.vsum__item strong { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.vsum__item.is-warn strong { color: #f59e0b; }

.vtoolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vtoolbar__search { max-width: 300px; }
.vtoolbar__sel { max-width: 132px; }
.vtoolbar__count { margin-left: auto; font-size: 12px; color: var(--fg-3); }

.vtable-wrap {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.vtable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.vtable th {
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
.vtable td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.vtable tbody tr:last-child td { border-bottom: none; }
.vtable tbody tr:hover { background: var(--bg-hover); }
.vtable .num { text-align: right; font-variant-numeric: tabular-nums; }
.vtable .right { text-align: right; }
.vtable .muted { color: var(--fg-3); font-size: 12px; white-space: nowrap; }

.vname { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vname strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vname code { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }
.vowner { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.vowner small { font-size: 10.5px; color: var(--fg-3); }

.vtag { font-size: 10.5px; padding: 2px 8px; border-radius: 9px; white-space: nowrap; }
.vtag--ok { background: rgba(16, 185, 129, 0.12); color: #0e9f6e; }
.vtag--off { background: rgba(245, 158, 11, 0.14); color: #b45309; }

.vbtn {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 5px;
  color: var(--accent);
  margin-left: 6px;
}
.vbtn:hover { background: var(--accent-weak); }
.vbtn--danger { color: #d93025; }
.vbtn--danger:hover { background: rgba(217, 48, 37, 0.08); }

.vpager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 12px;
  color: var(--fg-3);
}
.empty { text-align: center; color: var(--fg-3); padding: 30px 12px; }

@media (max-width: 1280px) {
  .vsum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 1000px) {
  .vsum { grid-template-columns: minmax(0, 1fr); }
  .vtable-wrap { overflow-x: auto; }
  .vtable { min-width: 640px; }
}
</style>
