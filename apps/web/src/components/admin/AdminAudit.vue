<script setup lang="ts">
/**
 * 后台 · 审计日志（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 所有管理写操作都会写 `audit_logs`（见 lib/audit.js）。这个页面是事后追责的唯一入口，
 * 因此**不做任何写操作**，只提供搜索与分页浏览。
 *
 * 动作名（action）用点分层级，例如 `admin.ai.models.update`、
 * `admin.knowledge_token.revoke`，方便按前缀筛选。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApi } from '@/api/client';
import { fmtTime } from './shared';

const emit = defineEmits<{ fail: [string] }>();

const items = ref<Array<Record<string, unknown>>>([]);
const search = ref('');
const action = ref('');
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApi.audit({
      page: 1,
      pageSize: 60,
      search: search.value.trim() || undefined,
      action: action.value.trim() || undefined,
    });
    items.value = res.items;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

/** 按动作名着色：删除/吊销类用红色，创建类用绿色，便于快速扫读 */
function actionVariant(name: string): string {
  const a = String(name ?? '');
  if (/delete|revoke|remove/.test(a)) return 'adm-badge--danger';
  if (/create|generate|grant/.test(a)) return 'adm-badge--ok';
  if (/update|save|set/.test(a)) return 'adm-badge--accent';
  return 'adm-badge--muted';
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="aud">
    <header class="adm-page-head">
      <div>
        <h2>审计日志</h2>
        <p>全部管理写操作的留痕：谁在什么时候对什么对象做了什么。只读，不可编辑或删除。</p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <div class="adm-toolbar">
      <input
        v-model="search"
        class="nm-input adm-toolbar__search"
        placeholder="搜索目标标识 / 用户名"
        @keyup.enter="load"
      />
      <input
        v-model="action"
        class="nm-input adm-toolbar__search"
        placeholder="按动作前缀筛选（如 admin.ai）"
        @keyup.enter="load"
      />
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="load">搜索</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">最近 {{ items.length }} 条</span>
    </div>

    <table class="adm-table adm-table--tight">
      <thead>
        <tr>
          <th style="width: 165px;">时间</th>
          <th style="width: 250px;">动作</th>
          <th>目标</th>
          <th style="width: 130px;">用户</th>
          <th style="width: 130px;">IP</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(a, i) in items" :key="i">
          <td class="adm-muted">{{ fmtTime(a.created_at ?? a.createdAt) }}</td>
          <td>
            <span class="adm-badge" :class="actionVariant(String(a.action))">{{ a.action }}</span>
          </td>
          <td class="adm-mono adm-muted">{{ a.target ?? '—' }}</td>
          <td class="adm-muted">{{ a.username ?? a.user_id ?? a.userId ?? '—' }}</td>
          <td class="adm-mono adm-muted">{{ a.ip ?? '—' }}</td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="5" class="adm-empty">{{ loading ? '加载中…' : '暂无日志' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
