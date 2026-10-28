<script setup lang="ts">
import { onMounted } from 'vue';
import { detectRuntime } from '@neomd/core';
import { useAuthStore } from './stores/auth';
import { useSettingsStore } from './stores/settings';

const auth = useAuthStore();
const settings = useSettingsStore();

onMounted(() => {
  // 运行平台标记：桌面端据此启用自定义标题栏拖拽区（.nm-drag）
  document.documentElement.dataset.runtime = detectRuntime().platform;
  settings.init();
  void auth.restore();
});
</script>

<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" />
  </router-view>
</template>
