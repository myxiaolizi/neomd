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
/**
 * 本次列表里有多少条来自本地留痕 / 云端。
 *
 * 1.2.1 起不再有「本地 or 云端」的单一来源概念 —— 两者是**合并**展示的。
 * 这里只保留两个计数用于给用户一句准确的说明（以及排障时一眼看出哪一侧为空）。
 */
const localCount = ref(0);
const cloudCount = ref(0);
/** 加载过程中云端一侧是否失败（本地仍然可用，因此不算整体失败） */
const cloudFailed = ref(false);
const diff = ref<{ added: number; removed: number; lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> } | null>(null);

/**
 * 加载版本列表。
 *
 * ## 1.2.1 缺陷5 修复（这是「只能看到最近一版」最直接的一处成因）
 *
 * 旧实现是**二选一**：
 * ```ts
 * const local = await app.vault.listVersions(props.docId);
 * if (local.length) { versions.value = local; source.value = 'local'; }
 * else { versions.value = await app.listCloudVersions(props.docId); source.value = 'cloud'; }
 * ```
 * 只要本地 `.neomd/versions/` 里残留**任意 1 条**（用户曾开过「本地留痕」、
 * 桌面端老版本留下的快照、或从别处拷来的仓库），云端真实存在的 N 条历史就被
 * **整体忽略**，面板里只剩那 1 条 —— 用户看到的就是「改了很多次只有最近一版」。
 *
 * 现在统一走 `app.listDocVersions()`：本地 ∪ 云端 → 按内容身份（rev+hash）去重
 * → 按时间倒序。云端失败时降级为只显示本地（不再整体清空）。
 */
async function load(): Promise<void> {
  if (!app.vault || !props.docId) return;
  loading.value = true;
  cloudFailed.value = false;
  try {
    const local = await app.vault.listVersions(props.docId).catch(() => []);
    let cloud: VersionRecord[] = [];
    try {
      cloud = await app.listCloudVersions(props.docId);
    } catch {
      // 离线 / 未登录 / 对象存储不可用：本地留痕依然要能看、能回滚
      cloudFailed.value = true;
    }
    localCount.value = local.length;
    cloudCount.value = cloud.length;
    versions.value = app.mergeVersions(local, cloud, props.docId);
    selected.value = null;
    preview.value = '';
    diff.value = null;
  } catch {
    versions.value = [];
    localCount.value = 0;
    cloudCount.value = 0;
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

/**
 * 选中某个版本并预览差异。
 *
 * 1.2.1：读取统一交给 `app.readVersionContent()` —— 它按 key 形态
 * （`.neomd/` 前缀 = 本地，其余 = 云端对象键）路由到正确的读取器。
 * 旧实现按全局 `source` 二选一，合并列表后必然读错一半。
 */
async function pick(v: VersionRecord): Promise<void> {
  if (!app.vault) return;
  selected.value = v;
  try {
    preview.value = await app.readVersionContent(v);
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

/**
 * 恢复到选中版本。
 *
 * ## 1.2.1 修复：必须按 key 形态读取，并且真的写回磁盘 + 编辑器
 *
 * 旧实现直接 `app.vault.restoreVersion(props.docId, selected.value.storageKey)`。
 * 而合并列表里多数 key 是**云端对象键**（`versions/<docId>/<ts>-<rev>-<hash>.md`
 * 或完整前缀形式），本地适配器读不到它 —— 实测报错：
 *   `文件不存在: mdadmin/neomd/users/admin/vaults/<vid>/versions/<docId>/...md`
 * 也就是说：只要本地留痕非空（旧逻辑只显示本地），或在合并列表里点了云端那条，
 * **「恢复此版本」100% 失败**。
 *
 * 现在的步骤：
 *  1. `app.readVersionContent()` 按 key 形态取到正文（本地 / 云端都对）；
 *  2. `vault.save(docId, 正文, 'restore')` → 写磁盘文件、递增 rev、
 *     并把「恢复前的当前内容」也归档一版（用户误点还能再恢复回来）；
 *  3. 刷新 store 的文档列表，并把正文同步进已打开的标签页（否则编辑器仍显示旧内容，
 *     用户会以为恢复没生效）；
 *  4. 重新 `load()` 让列表反映刚产生的新版本。
 */
async function restore(): Promise<void> {
  if (!app.vault || !selected.value) return;
  const target = selected.value;
  const ok = window.confirm('恢复此版本？当前内容会先保存为一个新版本。');
  if (!ok) return;
  try {
    /*
     * 先落盘编辑器里可能存在的未保存改动。
     *
     * 顺序很重要：`vault.save(..., 'restore')` 归档的是**磁盘上的当前内容**，
     * 若标签页里有还没保存的编辑，直接恢复会把它们**静默丢弃**（连历史里都没有）。
     * 先 saveActiveTab() 让 UI 里的最新内容成为「当前内容」，它就会被正常归档，
     * 恢复动作也就变成了可逆的一步。
     */
    const tab = app.tabs.find((t) => t.docId === props.docId);
    if (tab?.dirty) await app.saveActiveTab();
    /*
     * 归档「恢复前的当前内容」，让恢复动作本身也可回溯。
     *
     * ## 为什么必须显式做
     *
     * `vault.save(..., 'restore')` 只在 `keepLocalVersions === true` 时写本地快照
     * （PC 端默认关闭），它**不会**往云端归档 —— 云端归档一直是由
     * `saveActiveTab()` 里的 `archiveVersionToCloud()` 负责的。
     * 而这条恢复路径绕过了 `saveActiveTab`，于是：
     *  - 确认框承诺「当前内容会先保存为一个新版本」；
     *  - 实际当前内容**没有进任何历史** —— 用户误点恢复后就永久失去了那一段正文。
     *
     * 这里补上一次云端归档，与 `saveActiveTab` 的行为对齐。
     * 失败不阻断恢复（`archiveVersionToCloud` 内部已 catch 并记日志），
     * 因为「用户明确点下的恢复」优先级更高。
     */
    const currentMeta = app.vault.get(props.docId);
    const currentContent = await app.vault.read(props.docId).catch(() => '');
    const content = await app.readVersionContent(target);
    if (currentContent && currentContent !== content) {
      await app.archiveVersionToCloud(props.docId, Math.max(1, currentMeta?.rev ?? 1), currentContent);
    }
    await app.vault.save(props.docId, content, 'restore');
    await app.refreshDocs();
    // 正文同步进标签页：不刷新编辑器内容的话，用户看到的是「什么都没发生」
    if (tab) {
      app.updateTabContent(tab.id, content);
      // 磁盘已经是这一版了，标签页不再有「未保存改动」，否则下次自动保存
      // 会把它当成新编辑再写一遍（多出一个无意义的版本）
      tab.dirty = false;
    }
    await load();
    app.notify(`已恢复到 ${relativeTime(target.createdAt)} 的版本`, 'success');
  } catch (e) {
    app.notify(`恢复失败：${(e as Error).message}`, 'error', 4200);
  }
}
</script>

<template>
  <NmModal :model-value="modelValue" title="版本历史" :width="820" @update:model-value="emit('update:modelValue', $event)">
    <div class="history">
      <div class="history__list nm-scroll">
        <div v-if="loading" class="history__empty">加载中…</div>
        <div v-else-if="!versions.length" class="history__empty">
          还没有历史版本。每次保存都会把「保存前的正文」归档到云端对象存储（本地留痕开启时同时存本地），保存并同步后即可在这里回滚。
        </div>
        <div v-else class="history__source" role="status">
          共 {{ versions.length }} 个版本（本地 {{ localCount }} · 云端 {{ cloudCount }}<template v-if="cloudFailed">，云端暂不可用</template>），按时间倒序
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
          <span class="ver__origin">{{ v.label || fallbackDevice }}</span>
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
