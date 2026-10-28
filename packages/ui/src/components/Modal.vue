<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    width?: number | string;
    closable?: boolean;
    /** 移动端底部抽屉呈现 */
    sheet?: boolean;
  }>(),
  { width: 520, closable: true, sheet: false },
);

const emit = defineEmits<{ 'update:modelValue': [boolean]; close: [] }>();

const root = ref<HTMLElement | null>(null);

function close(): void {
  emit('update:modelValue', false);
  emit('close');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.modelValue && props.closable) {
    e.stopPropagation();
    close();
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = v ? 'hidden' : '';
  },
);

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="modelValue" class="modal-mask" @mousedown.self="closable && close()">
        <div
          ref="root"
          class="modal"
          :class="{ 'modal--sheet': sheet }"
          :style="{ width: typeof width === 'number' ? `${width}px` : width }"
          role="dialog"
          aria-modal="true"
        >
          <header v-if="title || $slots.header" class="modal__head">
            <slot name="header">
              <h2 class="modal__title">{{ title }}</h2>
            </slot>
            <button v-if="closable" class="modal__close" type="button" aria-label="关闭" @click="close">
              <Icon name="close" :size="16" />
            </button>
          </header>
          <div class="modal__body nm-scroll">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal__foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 8000;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(6px);
  padding: 24px;
}
.modal {
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 12px;
  flex: 0 0 auto;
}
.modal__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.modal__close {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.modal__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.modal__body {
  padding: 4px 20px 18px;
  overflow-y: auto;
  flex: 1 1 auto;
  font-size: 13.5px;
  line-height: 1.65;
}
.modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  flex: 0 0 auto;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.16s ease;
}
.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.16s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal,
.modal-leave-to .modal {
  transform: translateY(8px) scale(0.985);
  opacity: 0;
}

@media (max-width: 640px) {
  .modal-mask {
    padding: 0;
    align-items: end;
  }
  .modal,
  .modal--sheet {
    width: 100% !important;
    max-width: 100%;
    max-height: 88vh;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .modal-enter-from .modal,
  .modal-leave-to .modal {
    transform: translateY(100%);
  }
}
</style>
