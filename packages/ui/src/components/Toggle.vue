<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

function toggle(): void {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="toggle"
    :class="{ 'is-on': modelValue, 'is-disabled': disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="toggle__knob" />
  </button>
</template>

<style scoped>
.toggle {
  position: relative;
  width: 40px;
  height: 22px;
  border-radius: 11px;
  background: rgba(120, 130, 145, 0.32);
  border: 1px solid transparent;
  transition: background 0.16s ease;
  flex: 0 0 auto;
  padding: 0;
}
.toggle.is-on {
  background: var(--accent);
}
.toggle.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.toggle__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1);
}
.toggle.is-on .toggle__knob {
  transform: translateX(18px);
}
</style>
