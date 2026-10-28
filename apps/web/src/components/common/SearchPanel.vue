<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface SearchResultView {
  docId: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
}

const props = defineProps<{ modelValue: boolean; results: SearchResultView[]; query: string; searching?: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [boolean];
  'update:query': [string];
  open: [string];
  replaceQuery: [string];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const cursor = ref(0);

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      cursor.value = 0;
      await nextTick();
      inputEl.value?.select();
    }
  },
);

watch(
  () => props.results,
  () => {
    cursor.value = 0;
  },
);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cursor.value = Math.min(cursor.value + 1, props.results.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cursor.value = Math.max(cursor.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const r = props.results[cursor.value];
    if (r) emit('open', r.docId);
  } else if (e.key === 'Escape') {
    emit('update:modelValue', false);
  }
}

const highlighted = computed(() => props.results);
</script>

<template>
  <Teleport to="body">
    <Transition name="searchfade">
      <div v-if="modelValue" class="search-mask" @mousedown.self="emit('update:modelValue', false)">
        <div class="search-panel" role="dialog" aria-label="全库搜索">
          <div class="search-panel__head">
            <NmIcon name="search" :size="17" />
            <input
              ref="inputEl"
              :value="query"
              placeholder="搜索整个仓库… 支持中文分词、前缀与模糊匹配"
              @input="emit('update:query', ($event.target as HTMLInputElement).value)"
              @keydown="onKeydown"
            />
            <span v-if="searching" class="search-panel__status">搜索中…</span>
            <span v-else-if="query" class="search-panel__status">{{ results.length }} 条结果</span>
            <kbd>Esc</kbd>
          </div>
          <div class="search-panel__list nm-scroll">
            <button
              v-for="(r, i) in highlighted"
              :key="r.docId + i"
              class="hit"
              :class="{ 'is-active': i === cursor }"
              @mouseenter="cursor = i"
              @click="emit('open', r.docId)"
            >
              <div class="hit__head">
                <NmIcon name="file" :size="13" />
                <span class="hit__title">{{ r.title }}</span>
                <span class="hit__path">{{ r.path }}</span>
              </div>
              <p class="hit__snippet">{{ r.snippet }}</p>
            </button>
            <p v-if="!results.length && query && !searching" class="search-panel__empty">
              没有找到包含「{{ query }}」的内容
            </p>
            <p v-if="!query" class="search-panel__empty">输入关键词开始搜索，结果按相关度排序。</p>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.search-mask {
  position: fixed;
  inset: 0;
  z-index: 8400;
  display: flex;
  justify-content: center;
  padding-top: 10vh;
  background: rgba(15, 23, 42, 0.36);
  backdrop-filter: blur(4px);
}
.search-panel {
  width: min(700px, calc(100vw - 32px));
  max-height: 66vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.search-panel__head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-3);
  flex: 0 0 auto;
}
.search-panel__head input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 14px;
  color: var(--fg);
  min-width: 0;
}
.search-panel__status {
  font-size: 11.5px;
  color: var(--fg-3);
  flex: 0 0 auto;
}
kbd {
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--fg-3);
  border: 1px solid var(--border);
}
.search-panel__list {
  overflow-y: auto;
  padding: 6px;
  flex: 1 1 auto;
}
.hit {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 7px;
  color: var(--fg);
}
.hit.is-active {
  background: var(--bg-active);
}
.hit__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--fg-2);
}
.hit__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
}
.hit__path {
  font-size: 11px;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit__snippet {
  margin: 4px 0 0 20px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.search-panel__empty {
  margin: 30px 0;
  text-align: center;
  font-size: 13px;
  color: var(--fg-3);
}
.searchfade-enter-active,
.searchfade-leave-active {
  transition: opacity 0.14s ease;
}
.searchfade-enter-from,
.searchfade-leave-to {
  opacity: 0;
}
</style>
