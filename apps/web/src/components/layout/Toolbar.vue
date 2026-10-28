<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { EditorMode, PageWidth } from '@neomd/shared';

const props = defineProps<{
  title: string;
  mode: EditorMode;
  pageWidth: PageWidth;
  dirty: boolean;
  syncState: string;
  aiOpen: boolean;
  sidebarOpen: boolean;
  path: string;
}>();

const emit = defineEmits<{
  setMode: [EditorMode];
  setPageWidth: [PageWidth];
  save: [];
  sync: [];
  toggleAi: [];
  toggleSidebar: [];
  history: [];
  share: [];
  publish: [];
  exportDoc: [];
  commandPalette: [];
  search: [];
  rename: [];
  back: [];
}>();

const MODES: Array<{ id: EditorMode; label: string; icon: string; hint: string }> = [
  { id: 'wysiwyg', label: '所见即所得', icon: 'type', hint: 'Ctrl+/ 切换' },
  { id: 'source', label: '源码', icon: 'code', hint: 'Markdown 源码' },
  { id: 'compare', label: '对照', icon: 'columns', hint: '左源码右预览' },
  { id: 'read', label: '阅读', icon: 'book', hint: '纯净阅读' },
];

const WIDTHS: Array<{ id: PageWidth; label: string }> = [
  { id: 'narrow', label: '窄' },
  { id: 'standard', label: '标准' },
  { id: 'wide', label: '宽' },
  { id: 'full', label: '铺满' },
];

const moreOpen = ref(false);
const widthOpen = ref(false);

function closeMenus(e: MouseEvent): void {
  const el = e.target as HTMLElement;
  if (!el.closest('.menu-anchor')) {
    moreOpen.value = false;
    widthOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', closeMenus));
onBeforeUnmount(() => document.removeEventListener('click', closeMenus));

watch(moreOpen, (v) => {
  if (v) widthOpen.value = false;
});

const syncLabel = computed(() => {
  switch (props.syncState) {
    case 'syncing':
      return '同步中';
    case 'error':
      return '同步失败';
    case 'offline':
      return '离线';
    default:
      return '已同步';
  }
});
</script>

<template>
  <header class="toolbar">
    <div class="toolbar__left">
      <button class="tb-btn tb-btn--mobile" title="返回" @click="emit('back')">
        <NmIcon name="chevronLeft" :size="17" />
      </button>
      <button class="tb-btn tb-btn--desktop" :title="sidebarOpen ? '收起侧栏 Ctrl+\\' : '展开侧栏 Ctrl+\\'" @click="emit('toggleSidebar')">
        <NmIcon name="sidebar" :size="16" />
      </button>
      <div class="tab-title" :title="path">
        <span class="tab-title__text">{{ title || '未命名' }}</span>
        <span v-if="dirty" class="tab-title__dot" title="未保存" />
      </div>
    </div>

    <div class="toolbar__center">
      <div class="mode-switch" role="tablist">
        <button
          v-for="m in MODES"
          :key="m.id"
          class="mode-switch__item"
          :class="{ 'is-active': mode === m.id }"
          :title="`${m.label} · ${m.hint}`"
          role="tab"
          :aria-selected="mode === m.id"
          @click="emit('setMode', m.id)"
        >
          <NmIcon :name="m.icon" :size="14" />
          <span class="mode-switch__label">{{ m.label }}</span>
        </button>
      </div>
    </div>

    <div class="toolbar__right">
      <div class="menu-anchor">
        <button class="tb-btn tb-btn--desktop" title="页宽" @click="widthOpen = !widthOpen">
          <NmIcon name="width" :size="16" />
        </button>
        <div v-if="widthOpen" class="menu menu--sm">
          <button
            v-for="w in WIDTHS"
            :key="w.id"
            class="menu__item"
            :class="{ 'is-active': pageWidth === w.id }"
            @click="emit('setPageWidth', w.id); widthOpen = false"
          >
            <span>{{ w.label }}</span>
            <NmIcon v-if="pageWidth === w.id" name="check" :size="13" />
          </button>
        </div>
      </div>

      <button class="tb-btn" title="搜索全库 Ctrl+Shift+F" @click="emit('search')">
        <NmIcon name="search" :size="16" />
      </button>
      <button class="tb-btn" title="命令面板 Ctrl+P" @click="emit('commandPalette')">
        <NmIcon name="command" :size="16" />
      </button>
      <button class="tb-btn" title="版本历史" @click="emit('history')">
        <NmIcon name="history" :size="16" />
      </button>

      <button class="tb-btn tb-btn--sync" :class="`is-${syncState}`" :title="`${syncLabel} · Ctrl+S 同步`" @click="emit('sync')">
        <NmIcon :name="syncState === 'error' ? 'cloudOff' : 'cloudCheck'" :size="16" />
        <span class="tb-btn__label">{{ syncLabel }}</span>
      </button>

      <button class="tb-btn tb-btn--save" title="保存 Ctrl+S" @click="emit('save')">
        <NmIcon name="save" :size="16" />
      </button>

      <div class="menu-anchor">
        <button class="tb-btn" title="更多" @click="moreOpen = !moreOpen">
          <NmIcon name="more" :size="16" />
        </button>
        <div v-if="moreOpen" class="menu">
          <button class="menu__item" @click="emit('rename'); moreOpen = false">
            <NmIcon name="edit" :size="14" /><span>重命名</span>
          </button>
          <button class="menu__item" @click="emit('share'); moreOpen = false">
            <NmIcon name="share" :size="14" /><span>分享与协作</span>
          </button>
          <button class="menu__item" @click="emit('publish'); moreOpen = false">
            <NmIcon name="globe" :size="14" /><span>发布为网页</span>
          </button>
          <div class="menu__sep" />
          <button class="menu__item" @click="emit('exportDoc'); moreOpen = false">
            <NmIcon name="download" :size="14" /><span>导出 PDF / Word / HTML</span>
          </button>
        </div>
      </div>

      <button class="tb-btn" :class="{ 'is-on': aiOpen }" title="AI 助手 Ctrl+Shift+A" @click="emit('toggleAi')">
        <NmIcon name="sparkles" :size="16" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--toolbar-h);
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
}
.toolbar__left,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex-shrink: 0;
}
.toolbar__left {
  flex: 1 1 0;
  overflow: hidden;
}
.toolbar__right {
  flex: 0 0 auto;
  justify-content: flex-end;
}
.toolbar__center {
  flex: 0 0 auto;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  min-width: 30px;
  padding: 0 6px;
  border-radius: 7px;
  color: var(--fg-2);
  justify-content: center;
}
.tb-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tb-btn.is-on {
  background: var(--accent-weak);
  color: var(--accent);
}
.tb-btn--sync {
  padding: 0 9px;
  font-size: 11.5px;
  color: var(--fg-3);
}
.tb-btn--sync.is-syncing {
  color: var(--accent);
}
.tb-btn--sync.is-error {
  color: #d93025;
}
.tb-btn__label {
  white-space: nowrap;
}
.tb-btn--save {
  color: var(--accent);
}
.tab-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 550;
}
.tab-title__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-title__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--orange);
  flex: 0 0 auto;
}
.mode-switch {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.mode-switch__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--fg-2);
  white-space: nowrap;
}
.mode-switch__item:hover {
  color: var(--fg);
}
.mode-switch__item.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.menu-anchor {
  position: relative;
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 500;
  min-width: 200px;
  padding: 5px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.menu--sm {
  min-width: 130px;
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--fg);
  text-align: left;
}
.menu__item:hover {
  background: var(--bg-hover);
}
.menu__item.is-active {
  color: var(--accent);
  font-weight: 600;
  justify-content: space-between;
}
.menu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
.tb-btn--mobile {
  display: none;
}

@media (max-width: 1100px) {
  .mode-switch__label {
    display: none;
  }
  .mode-switch__item {
    padding: 0 8px;
  }
  .tb-btn--save,
  .tb-btn--desktop {
    display: none;
  }
}
@media (max-width: 760px) {
  .toolbar {
    padding: 0 6px;
    gap: 4px;
  }
  .tb-btn--mobile {
    display: inline-flex;
  }
  .tb-btn__label {
    display: none;
  }
  .tab-title {
    font-size: 13px;
  }
  .mode-switch {
    padding: 2px;
  }
}
</style>
