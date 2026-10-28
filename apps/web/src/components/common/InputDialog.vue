<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { useAppStore } from '@/stores/app';

const app = useAppStore();
const value = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

watch(
  () => app.inputDialog.open,
  async (open) => {
    if (!open) return;
    value.value = app.inputDialog.value;
    await nextTick();
    inputEl.value?.focus();
    inputEl.value?.select();
  },
);

function cancel(): void {
  app.submitInput(null);
}

function confirm(): void {
  app.submitInput(value.value);
}
</script>

<template>
  <NmModal
    :model-value="app.inputDialog.open"
    :title="app.inputDialog.title"
    :width="440"
    @update:model-value="(v: boolean) => !v && cancel()"
  >
    <div class="dlg">
      <label v-if="app.inputDialog.label" class="nm-label">{{ app.inputDialog.label }}</label>
      <input
        ref="inputEl"
        v-model="value"
        class="nm-input"
        :placeholder="app.inputDialog.placeholder"
        @keyup.enter="confirm"
        @keyup.esc="cancel"
      />
    </div>
    <template #footer>
      <button class="nm-btn" @click="cancel">取消</button>
      <button class="nm-btn nm-btn--primary" @click="confirm">
        <NmIcon name="check" :size="14" />
        确定
      </button>
    </template>
  </NmModal>
</template>

<style scoped>
.dlg {
  padding: 4px 0 6px;
}
</style>
