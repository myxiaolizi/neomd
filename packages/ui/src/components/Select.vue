<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

interface Option {
  label: string;
  value: string | number;
}

const props = defineProps<{
  modelValue: string | number;
  options: Option[];
  disabled?: boolean;
  size?: 'sm' | 'md';
}>();

const emit = defineEmits<{ 'update:modelValue': [string | number] }>();

const current = computed(() => props.options.find((o) => o.value === props.modelValue));

function onChange(e: Event): void {
  const raw = (e.target as HTMLSelectElement).value;
  const match = props.options.find((o) => String(o.value) === raw);
  emit('update:modelValue', match ? match.value : raw);
}
</script>

<template>
  <div class="select" :class="[`select--${size ?? 'md'}`, { 'is-disabled': disabled }]">
    <select :value="String(modelValue)" :disabled="disabled" @change="onChange">
      <option v-for="o in options" :key="String(o.value)" :value="String(o.value)">{{ o.label }}</option>
    </select>
    <Icon name="chevronDown" :size="14" class="select__arrow" />
    <span class="select__label">{{ current?.label }}</span>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 34px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-input);
  padding: 0 28px 0 10px;
  min-width: 110px;
}
.select--sm {
  height: 28px;
  font-size: 12px;
  min-width: 88px;
}
.select:hover {
  border-color: var(--border-strong);
}
.select.is-disabled {
  opacity: 0.55;
}
.select select {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border: none;
  background: none;
}
.select__label {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.select__arrow {
  position: absolute;
  right: 8px;
  color: var(--fg-3);
  pointer-events: none;
}
</style>
