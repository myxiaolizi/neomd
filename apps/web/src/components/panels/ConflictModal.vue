<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { useAppStore } from '@/stores/app';

const app = useAppStore();
const index = ref(0);

const conflict = computed(() => app.syncConflicts[index.value] ?? null);
const hasMany = computed(() => app.syncConflicts.length > 1);

function choose(choice: 'local' | 'remote' | 'merged'): void {
  const c = conflict.value;
  if (!c) return;
  void app.resolveConflict(c.docId, choice);
  index.value = Math.min(index.value, Math.max(0, app.syncConflicts.length - 1));
}

const preview = computed(() => {
  const c = conflict.value;
  if (!c) return { local: '', remote: '' };
  return { local: c.localMarkdown.slice(0, 1200), remote: c.remoteMarkdown.slice(0, 1200) };
});
</script>

<template>
  <NmModal
    :model-value="Boolean(conflict)"
    title="检测到文件冲突"
    :width="760"
    :closable="false"
    @update:model-value="() => undefined"
  >
    <div v-if="conflict" class="conflict">
      <p class="conflict__lead">
        《{{ conflict.path }}》在多处被同时修改，需要你选择保留哪一版。
        <span v-if="hasMany" class="conflict__count">（第 {{ index + 1 }} / {{ app.syncConflicts.length }} 个）</span>
      </p>

      <div class="conflict__grid">
        <section class="conflict__col">
          <header>本地版本</header>
          <pre class="conflict__pre">{{ preview.local }}</pre>
        </section>
        <section class="conflict__col">
          <header>远端版本</header>
          <pre class="conflict__pre">{{ preview.remote }}</pre>
        </section>
      </div>

      <p class="nm-hint">
        选择「保留本地」会把本地内容另存为一份冲突副本，不会丢失任何文字。
      </p>
    </div>
    <template #footer>
      <button class="nm-btn" @click="choose('remote')">
        <NmIcon name="cloud" :size="14" />
        使用远端
      </button>
      <button class="nm-btn nm-btn--primary" @click="choose('local')">
        <NmIcon name="restore" :size="14" />
        保留本地（另存副本）
      </button>
    </template>
  </NmModal>
</template>

<style scoped>
.conflict__lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
}
.conflict__count {
  color: var(--fg-3);
  font-size: 12px;
}
.conflict__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.conflict__col header {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 6px;
}
.conflict__pre {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 640px) {
  .conflict__grid {
    grid-template-columns: 1fr;
  }
}
</style>
