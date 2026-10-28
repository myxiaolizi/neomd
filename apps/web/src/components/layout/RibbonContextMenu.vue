<script setup lang="ts">
/**
 * 功能区（ribbon）右键菜单 —— 1.0.2 新增。
 *
 * 诉求：「功能区需要支持右键，可以显示隐藏功能按钮；调整顺序等」。
 *
 * 两种触发场景：
 * - 在某个功能按钮上右键：只针对该按钮（隐藏 / 上移 / 下移）；
 * - 在功能区空白处右键：批量操作（添加按钮、功能区位置、隐藏整个功能区）。
 *
 * 组件不直接读写 store，全部通过 emits 交给父组件处理，便于复用与测试。
 */
import { computed } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { RibbonPosition } from '@neomd/shared';

export interface RibbonItemDef {
  id: string;
  label: string;
  icon: string;
}

const props = defineProps<{
  /** 菜单是否可见 */
  open: boolean;
  /** 屏幕坐标（相对视口） */
  x: number;
  y: number;
  /** 右键命中的按钮 id；为空表示在空白处右键 */
  targetId?: string;
  targetLabel?: string;
  /** 全部可用按钮 */
  allItems: RibbonItemDef[];
  /** 当前已启用的按钮 id（有序） */
  enabledIds: string[];
  /** 当前功能区位置 */
  position: RibbonPosition;
}>();

const emit = defineEmits<{
  close: [];
  hide: [string];
  move: [string, 'up' | 'down'];
  toggle: [string];
  setPosition: [RibbonPosition];
  disableRibbon: [];
  openSettings: [];
}>();

const POSITIONS: Array<{ id: RibbonPosition; label: string }> = [
  { id: 'left', label: '最左侧' },
  { id: 'right', label: '最右侧' },
  { id: 'statusbar-left', label: '状态栏左侧' },
  { id: 'statusbar-right', label: '状态栏右侧' },
];

/** 菜单样式：贴边时自动翻转，避免超出视口 */
const menuStyle = computed(() => {
  const vw = typeof globalThis !== 'undefined' ? globalThis.innerWidth || 1280 : 1280;
  const vh = typeof globalThis !== 'undefined' ? globalThis.innerHeight || 800 : 800;
  const width = 226;
  const height = props.targetId ? 132 : 420;
  return {
    left: `${Math.min(props.x, Math.max(8, vw - width - 8))}px`,
    top: `${Math.min(props.y, Math.max(8, vh - height - 8))}px`,
    width: `${width}px`,
  };
});

/** 未启用的按钮（用于「添加功能按钮」子列表） */
const disabledItems = computed(() => props.allItems.filter((i) => !props.enabledIds.includes(i.id)));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ribbonmenu__mask" @mousedown="emit('close')" @contextmenu.prevent="emit('close')" />
    <div
      v-if="open"
      class="ribbonmenu"
      :style="menuStyle"
      role="menu"
      @mousedown.stop
      @contextmenu.prevent
    >
      <!-- 场景一：在某个按钮上右键 -->
      <template v-if="targetId">
        <div class="ribbonmenu__title">{{ targetLabel || targetId }}</div>
        <button class="ribbonmenu__item" role="menuitem" @click="emit('hide', targetId!)">
          <NmIcon name="close" :size="13" /><span>隐藏此按钮</span>
        </button>
        <button class="ribbonmenu__item" role="menuitem" @click="emit('move', targetId!, 'up')">
          <NmIcon name="chevronUp" :size="13" /><span>上移一位</span>
        </button>
        <button class="ribbonmenu__item" role="menuitem" @click="emit('move', targetId!, 'down')">
          <NmIcon name="chevronDown" :size="13" /><span>下移一位</span>
        </button>
        <div class="ribbonmenu__sep" />
        <button class="ribbonmenu__item" role="menuitem" @click="emit('openSettings')">
          <NmIcon name="settings" :size="13" /><span>功能区设置…</span>
        </button>
      </template>

      <!-- 场景二：在空白处右键 -->
      <template v-else>
        <div class="ribbonmenu__title">功能区</div>
        <div class="ribbonmenu__sub">添加功能按钮</div>
        <div class="ribbonmenu__list">
          <button
            v-for="i in disabledItems"
            :key="i.id"
            class="ribbonmenu__item ribbonmenu__item--tight"
            role="menuitem"
            @click="emit('toggle', i.id)"
          >
            <NmIcon :name="i.icon" :size="13" /><span>{{ i.label }}</span>
            <NmIcon name="plus" :size="11" class="ribbonmenu__tail" />
          </button>
          <p v-if="!disabledItems.length" class="ribbonmenu__empty">所有按钮都已显示</p>
        </div>

        <div class="ribbonmenu__sep" />
        <div class="ribbonmenu__sub">功能区位置</div>
        <button
          v-for="p in POSITIONS"
          :key="p.id"
          class="ribbonmenu__item ribbonmenu__item--tight"
          role="menuitemradio"
          :aria-checked="position === p.id"
          @click="emit('setPosition', p.id)"
        >
          <NmIcon name="layout" :size="13" /><span>{{ p.label }}</span>
          <NmIcon v-if="position === p.id" name="check" :size="12" class="ribbonmenu__tail" />
        </button>

        <div class="ribbonmenu__sep" />
        <button class="ribbonmenu__item" role="menuitem" @click="emit('disableRibbon')">
          <NmIcon name="close" :size="13" /><span>隐藏功能区</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ribbonmenu__mask {
  position: fixed;
  inset: 0;
  z-index: 9400;
}
.ribbonmenu {
  position: fixed;
  z-index: 9401;
  max-height: 70vh;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.ribbonmenu__title {
  padding: 4px 9px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-3);
  text-transform: none;
}
.ribbonmenu__sub {
  padding: 4px 9px 2px;
  font-size: 10.5px;
  color: var(--fg-3);
}
.ribbonmenu__list {
  max-height: 220px;
  overflow-y: auto;
}
.ribbonmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.ribbonmenu__item--tight {
  padding: 5px 9px;
  font-size: 12px;
}
.ribbonmenu__item:hover {
  background: var(--bg-hover);
}
.ribbonmenu__tail {
  margin-left: auto;
  color: var(--fg-3);
}
.ribbonmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
.ribbonmenu__empty {
  margin: 2px 9px 6px;
  font-size: 11px;
  color: var(--fg-3);
}
</style>
