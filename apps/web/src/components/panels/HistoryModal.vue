<script setup lang="ts">
import { ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { relativeTime, formatBytes, type VersionRecord } from '@neomd/shared';
import { detectRuntime } from '@neomd/core';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';

const props = defineProps<{ modelValue: boolean; docId: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const app = useAppStore();
const settingsStore = useSettingsStore();
const rt = detectRuntime();
const fallbackDevice = rt.platform === 'web' ? 'web' : settingsStore.settings.sync.deviceName?.trim() || (rt.platform === 'desktop' ? 'Windows-PC' : 'Android');
const versions = ref<VersionRecord[]>([]);
const selected = ref<VersionRecord | null>(null);
const preview = ref('');
const loading = ref(false);
/** 当前版本列表的来源：本地仓库 or 云端对象存储 */
const source = ref<'local' | 'cloud'>('local');
const diff = ref<{ added: number; removed: number; lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> } | null>(null);

/**
 * 加载版本列表。
 *
 * PC 端默认「本地只存最新版本」，因此本地 `.neomd/versions/` 往往是空的；
 * 此时回退到云端对象存储读取 `versions/<docId>/`，保证历史版本功能依旧可用。
 * 读取云端版本复用 app 里已构建好的 SyncEngine，避免重复拼装 S3 配置。
 */
async function load(): Promise<void> {
  if (!app.vault || !props.docId) return;
  loading.value = true;
  try {
    const local = await app.vault.listVersions(props.docId);
    if (local.length) {
      versions.value = local;
      source.value = 'local';
    } else {
      const remote = await app.listCloudVersions(props.docId);
      versions.value = remote;
      source.value = 'cloud';
    }
    selected.value = null;
    preview.value = '';
    diff.value = null;
  } catch {
    versions.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) void load();
  },
);

async function pick(v: VersionRecord): Promise<void> {
  if (!app.vault) return;
  selected.value = v;
  try {
    preview.value =
      source.value === 'cloud'
        ? await app.readCloudVersion(v.storageKey)
        : await app.vault.readVersion(v.storageKey);
    diff.value = computeDiff(app.activeTab?.content ?? '', preview.value);
  } catch (e) {
    preview.value = `读取失败：${(e as Error).message}`;
  }
}

function computeDiff(current: string, target: string): { added: number; removed: number; lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> } {
  const a = current.split('\n');
  const b = target.split('\n');
  const setA = new Map<string, number>();
  a.forEach((l, i) => setA.set(l, i));
  const setB = new Map<string, number>();
  b.forEach((l, i) => setB.set(l, i));

  const lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> = [];
  let added = 0;
  let removed = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const la = a[i];
    const lb = b[i];
    if (la === lb) {
      lines.push({ type: 'same', text: la ?? '' });
    } else {
      if (la !== undefined && !setB.has(la)) {
        lines.push({ type: 'del', text: la });
        removed += 1;
      }
      if (lb !== undefined && !setA.has(lb)) {
        lines.push({ type: 'add', text: lb });
        added += 1;
      } else if (la !== undefined && lb !== undefined) {
        lines.push({ type: 'del', text: la });
        lines.push({ type: 'add', text: lb });
        removed += 1;
        added += 1;
      }
    }
  }
  return { added, removed, lines: lines.slice(0, 600) };
}

async function restore(): Promise<void> {
  if (!app.vault || !selected.value) return;
  const ok = window.confirm('恢复此版本？当前内容会先保存为一个新版本。');
  if (!ok) return;
  try {
    await app.vault.restoreVersion(props.docId, selected.value.storageKey);
    const doc = await app.vault.read(props.docId);
    const tab = app.tabs.find((t) => t.docId === props.docId);
    if (tab) app.updateTabContent(tab.id, doc);
    await app.saveActiveTab();
    await load();
    app.notify('已恢复到选定版本', 'success');
  } catch (e) {
    app.notify(`恢复失败：${(e as Error).message}`, 'error');
  }
}
</script>

<template>
  <NmModal :model-value="modelValue" title="版本历史" :width="820" @update:model-value="emit('update:modelValue', $event)">
    <div class="history">
      <div class="history__list nm-scroll">
        <div v-if="loading" class="history__empty">加载中…</div>
        <div v-else-if="!versions.length" class="history__empty">
          还没有历史版本。PC 端默认只在本地保留最新版本，历史版本保存在云端对象存储中——配置并登录对象存储后，保存过的版本会出现在这里。
        </div>
        <div v-else class="history__source" role="status">
          {{ source === 'cloud' ? '以下版本来自云端对象存储' : '以下版本来自本地留痕' }}
        </div>
        <button
          v-for="v in versions"
          :key="v.id"
          class="ver"
          :class="{ 'is-active': selected?.id === v.id }"
          @click="pick(v)"
        >
          <span class="ver__rev">v{{ v.rev }}</span>
          <span class="ver__meta">
            <span class="ver__time">{{ relativeTime(v.createdAt) }}</span>
            <span class="ver__size">{{ formatBytes(v.size) }}</span>
          </span>
          <span class="ver__origin">平台：{{ v.label || fallbackDevice }}</span>
        </button>
      </div>
      <div class="history__preview">
        <template v-if="selected">
          <div class="history__head">
            <span>与当前内容对比</span>
            <span class="diffstat">
              <em class="add">+{{ diff?.added ?? 0 }}</em>
              <em class="del">−{{ diff?.removed ?? 0 }}</em>
            </span>
          </div>
          <div class="history__code nm-scroll">
            <div v-for="(l, i) in diff?.lines ?? []" :key="i" class="dline" :class="`dline--${l.type}`">
              <span class="dline__sign">{{ l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ' }}</span>
              <span class="dline__text">{{ l.text || ' ' }}</span>
            </div>
          </div>
        </template>
        <div v-else class="history__empty">选择左侧任一版本查看差异</div>
      </div>
    </div>
    <template #footer>
      <button class="nm-btn" @click="emit('update:modelValue', false)">关闭</button>
      <button class="nm-btn nm-btn--primary" :disabled="!selected" @click="restore">
        <NmIcon name="restore" :size="14" />
        恢复此版本
      </button>
    </template>
  </NmModal>
</template>

<style scoped>
.history {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 14px;
  height: 48vh;
  margin: -4px -4px 0;
}
.history__list {
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding-right: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ver {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 7px;
  text-align: left;
  color: var(--fg);
  position: relative;
}
.ver:hover {
  background: var(--bg-hover);
}
.ver.is-active {
  background: var(--bg-active);
}
.ver__rev {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--accent);
  font-weight: 600;
}
.ver__meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-3);
}
.ver__origin {
  position: absolute;
  right: 10px;
  top: 9px;
  font-size: 10px;
  color: var(--fg-3);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.history__preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--fg-2);
  padding-bottom: 8px;
  flex: 0 0 auto;
}
.diffstat {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-style: normal;
}
.diffstat .add {
  color: #0e9f6e;
  font-style: normal;
}
.diffstat .del {
  color: #d93025;
  font-style: normal;
}
.history__code {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.65;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  padding: 8px 0;
}
.dline {
  display: flex;
  gap: 8px;
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-all;
}
.dline--add {
  background: rgba(14, 159, 110, 0.1);
}
.dline--del {
  background: rgba(217, 48, 37, 0.08);
}
.dline__sign {
  color: var(--fg-3);
  flex: 0 0 auto;
}
.dline--add .dline__sign {
  color: #0e9f6e;
}
.dline--del .dline__sign {
  color: #d93025;
}
.history__empty {
  color: var(--fg-3);
  font-size: 12.5px;
  padding: 20px 8px;
  line-height: 1.7;
}
@media (max-width: 700px) {
  .history {
    grid-template-columns: 1fr;
    height: auto;
  }
  .history__list {
    border-right: none;
    max-height: 30vh;
  }
  .history__code {
    max-height: 40vh;
  }
}
</style>
