<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { useAppStore } from '@/stores/app';

const app = useAppStore();

const target = ref('');
const selected = ref<Set<string>>(new Set());
const preview = ref('');
const busy = ref(false);
const message = ref('');

const docs = computed(() => app.docs);

function toggle(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
  preview.value = impactedPreview();
}

function impactedPreview(): string {
  if (!selected.value.size) return '';
  const names = [...selected.value].map((id) => app.docTitle(id)).filter(Boolean);
  return names.map((n) => `[[${n}]]`).join('、');
}

async function apply(): Promise<void> {
  if (!selected.value.size || !target.value.trim()) return;
  busy.value = true;
  message.value = '';
  try {
    const folder = target.value.trim().replace(/^\/+|\/+$/g, '');
    let moved = 0;
    for (const id of selected.value) {
      const doc = app.docs.find((d) => d.docId === id);
      if (!doc) continue;
      const name = doc.path.split('/').pop() ?? `${doc.title}.md`;
      await app.renameDoc(id, folder ? `${folder}/${name}` : name);
      moved += 1;
    }
    message.value = `已移动 ${moved} 篇文档到「${folder || '根目录'}」，相关引用已自动更新。`;
    selected.value = new Set();
    preview.value = '';
  } catch (e) {
    message.value = `操作失败：${(e as Error).message}`;
  } finally {
    busy.value = false;
  }
}

const folders = computed(() => app.vault?.folders() ?? []);
</script>

<template>
  <div class="reorg">
    <p class="nm-hint">批量移动或重命名笔记，仓库内的 [[双链]] 与相对链接会自动重写。</p>

    <label class="nm-label">目标文件夹</label>
    <input v-model="target" class="nm-input" list="folder-list" placeholder="例如 项目/2026" />
    <datalist id="folder-list">
      <option v-for="f in folders" :key="f" :value="f" />
    </datalist>
    <p class="nm-hint">留空表示移到仓库根目录。</p>

    <label class="nm-label mt">选择文档（{{ selected.size }} / {{ docs.length }}）</label>
    <div class="reorg__list nm-scroll">
      <label v-for="d in docs" :key="d.docId" class="reorg__row">
        <input type="checkbox" :checked="selected.has(d.docId)" @change="toggle(d.docId)" />
        <span class="reorg__title">{{ d.title }}</span>
        <span class="reorg__path">{{ d.path }}</span>
      </label>
      <p v-if="!docs.length" class="reorg__empty">仓库里还没有文档。</p>
    </div>

    <p v-if="preview" class="nm-hint">将被重写的引用：{{ preview }}</p>
    <p v-if="message" class="reorg__msg">{{ message }}</p>

    <button class="nm-btn nm-btn--primary" :disabled="busy || !selected.size || !target.trim()" @click="apply">
      <NmIcon name="layers" :size="14" />
      {{ busy ? '处理中…' : '执行移动' }}
    </button>
  </div>
</template>

<style scoped>
.reorg {
  padding: 10px 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mt {
  margin-top: 12px;
}
.reorg__list {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  margin-bottom: 8px;
}
.reorg__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border-radius: 5px;
  cursor: pointer;
}
.reorg__row:hover {
  background: var(--bg-hover);
}
.reorg__row input {
  accent-color: var(--accent);
}
.reorg__title {
  font-size: 12.5px;
  flex: 0 0 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reorg__path {
  font-size: 10.5px;
  color: var(--fg-3);
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reorg__empty {
  padding: 12px 6px;
  font-size: 12px;
  color: var(--fg-3);
}
.reorg__msg {
  margin: 4px 0;
  font-size: 11.5px;
  color: #0e9f6e;
  line-height: 1.6;
}
</style>
