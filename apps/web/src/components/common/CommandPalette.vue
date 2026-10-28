<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  keys?: string;
  icon?: string;
  run: () => void;
}

const props = defineProps<{ modelValue: boolean; commands: Command[] }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const query = ref('');
const cursor = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.commands;
  return props.commands
    .map((c) => {
      const hay = `${c.title} ${c.group ?? ''} ${c.hint ?? ''}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 10 - Math.min(9, hay.indexOf(q));
      for (const ch of q) if (hay.includes(ch)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
});

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      query.value = '';
      cursor.value = 0;
      await nextTick();
      inputEl.value?.focus();
    }
  },
);

watch(filtered, () => {
  cursor.value = 0;
});

function move(delta: number): void {
  const len = filtered.value.length;
  if (!len) return;
  cursor.value = (cursor.value + delta + len) % len;
  void nextTick(() => {
    const el = listEl.value?.querySelector('.cmd-item.is-active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function choose(index = cursor.value): void {
  const cmd = filtered.value[index];
  if (!cmd) return;
  emit('update:modelValue', false);
  cmd.run();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('update:modelValue', false);
  }
}

function close(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="modelValue" class="palette-mask" @mousedown.self="close">
        <div class="palette" role="dialog" aria-label="命令面板">
          <div class="palette__input">
            <NmIcon name="search" :size="16" />
            <input
              ref="inputEl"
              v-model="query"
              placeholder="输入命令名称… 例如「标题」「同步」「导出」"
              @keydown="onKeydown"
            />
            <kbd>Esc</kbd>
          </div>
          <div ref="listEl" class="palette__list nm-scroll">
            <button
              v-for="(cmd, i) in filtered"
              :key="cmd.id"
              class="cmd-item"
              :class="{ 'is-active': i === cursor }"
              @mouseenter="cursor = i"
              @click="choose(i)"
            >
              <span class="cmd-item__icon"><NmIcon :name="cmd.icon ?? 'command'" :size="15" /></span>
              <span class="cmd-item__body">
                <span class="cmd-item__title">{{ cmd.title }}</span>
                <span v-if="cmd.hint" class="cmd-item__hint">{{ cmd.hint }}</span>
              </span>
              <span v-if="cmd.group" class="cmd-item__group">{{ cmd.group }}</span>
              <kbd v-if="cmd.keys" class="cmd-item__keys">{{ cmd.keys }}</kbd>
            </button>
            <p v-if="!filtered.length" class="palette__empty">没有匹配的命令</p>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.palette-mask {
  position: fixed;
  inset: 0;
  z-index: 8500;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(15, 23, 42, 0.36);
  backdrop-filter: blur(4px);
}
.palette {
  width: min(620px, calc(100vw - 32px));
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.palette__input {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-3);
  flex: 0 0 auto;
}
.palette__input input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 14px;
  color: var(--fg);
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
.palette__list {
  overflow-y: auto;
  padding: 6px;
  flex: 1 1 auto;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 7px;
  text-align: left;
  color: var(--fg);
}
.cmd-item.is-active {
  background: var(--bg-active);
}
.cmd-item__icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--bg-hover);
  color: var(--accent);
  flex: 0 0 auto;
}
.cmd-item.is-active .cmd-item__icon {
  background: var(--accent);
  color: #fff;
}
.cmd-item__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.cmd-item__title {
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-item__hint {
  font-size: 11px;
  color: var(--fg-3);
  margin-top: 1px;
}
.cmd-item__group {
  font-size: 10.5px;
  color: var(--fg-3);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  flex: 0 0 auto;
}
.cmd-item__keys {
  flex: 0 0 auto;
}
.palette__empty {
  margin: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--fg-3);
}
.palette-enter-active,
.palette-leave-active {
  transition: opacity 0.14s ease;
}
.palette-enter-active .palette,
.palette-leave-active .palette {
  transition: transform 0.16s cubic-bezier(0.2, 0.9, 0.3, 1);
}
.palette-enter-from,
.palette-leave-to {
  opacity: 0;
}
.palette-enter-from .palette,
.palette-leave-to .palette {
  transform: translateY(-8px) scale(0.99);
}
@media (max-width: 640px) {
  .palette-mask {
    padding-top: 8vh;
  }
}
</style>
