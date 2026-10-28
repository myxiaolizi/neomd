<script setup lang="ts">
/**
 * 后台 · 插件市场（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 社区开发者在插件开放平台发布的扩展插件，管理员审核上下架。
 * 注意：这里只管**市场上架状态**，不涉及用户本地已安装的插件。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV2, type CommunityPluginDto } from '@/api/client';
import { formatCompactNumber } from '@neomd/shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const items = ref<CommunityPluginDto[]>([]);
const search = ref('');
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = (await adminApiV2.plugins(1, 60, search.value.trim())).items;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function setStatus(id: number, status: 'published' | 'pending' | 'rejected' | 'disabled'): Promise<void> {
  try {
    await adminApiV2.setPluginStatus(id, status);
    await load();
    emit('notify', '插件状态已更新');
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

function statusLabel(s: string): { text: string; variant: string } {
  switch (s) {
    case 'published':
      return { text: '已上架', variant: 'ok' };
    case 'pending':
      return { text: '待审核', variant: 'warn' };
    case 'rejected':
      return { text: '已驳回', variant: 'danger' };
    default:
      return { text: '已下架', variant: 'muted' };
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="plg">
    <header class="adm-page-head">
      <div>
        <h2>插件市场</h2>
        <p>管理社区开发者在插件开放平台发布的扩展插件，支持审核上下架。这里只影响市场可见性，不影响用户本地已安装的插件。</p>
      </div>
    </header>

    <div class="adm-toolbar">
      <input
        v-model="search"
        class="nm-input adm-toolbar__search"
        placeholder="搜索插件名称、ID 或作者"
        @keyup.enter="load"
      />
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="load">搜索</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">共 {{ items.length }} 款</span>
    </div>

    <table class="adm-table">
      <thead>
        <tr>
          <th>插件名称</th>
          <th style="width: 170px;">标识 (ID)</th>
          <th style="width: 130px;">作者</th>
          <th style="width: 80px;">版本</th>
          <th class="adm-right" style="width: 150px;">安装 / 获赞</th>
          <th style="width: 100px;">状态</th>
          <th class="adm-right" style="width: 100px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pl in items" :key="pl.id">
          <td class="adm-strong">{{ pl.name }}</td>
          <td class="adm-mono adm-muted">{{ pl.pluginId }}</td>
          <td class="adm-muted">{{ pl.authorName }}</td>
          <td>v{{ pl.version }}</td>
          <td class="adm-right adm-muted">
            {{ formatCompactNumber(pl.downloads) }} / ★ {{ formatCompactNumber(pl.stars) }}
          </td>
          <td>
            <span class="adm-badge" :class="`adm-badge--${statusLabel(pl.status).variant}`">
              {{ statusLabel(pl.status).text }}
            </span>
          </td>
          <td class="adm-right">
            <button v-if="pl.status !== 'published'" class="adm-rowbtn" @click="setStatus(pl.id, 'published')">上架</button>
            <button v-else class="adm-rowbtn adm-rowbtn--danger" @click="setStatus(pl.id, 'disabled')">下架</button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="7" class="adm-empty">{{ loading ? '加载中…' : '暂无社区插件' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
