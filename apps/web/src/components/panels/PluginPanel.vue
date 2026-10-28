<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, defineAsyncComponent, type Component } from 'vue';
import { NmIcon } from '@neomd/ui';
import { parseDoc, markdownToPlainText } from '@neomd/core';
import type { DocMeta } from '@neomd/shared';
import { getPlugin } from '@neomd/shared';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';
import OutlinePlugin from '@/components/plugins/OutlinePlugin.vue';
import TagsPlugin from '@/components/plugins/TagsPlugin.vue';
import LinksPlugin from '@/components/plugins/LinksPlugin.vue';
import PropertiesPlugin from '@/components/plugins/PropertiesPlugin.vue';
import BookmarksPlugin from '@/components/plugins/BookmarksPlugin.vue';
import DailyPlugin from '@/components/plugins/DailyPlugin.vue';
import RecoveryPlugin from '@/components/plugins/RecoveryPlugin.vue';
import GraphPlugin from '@/components/plugins/GraphPlugin.vue';
import SlidesPlugin from '@/components/plugins/SlidesPlugin.vue';
import WhiteboardPlugin from '@/components/plugins/WhiteboardPlugin.vue';
import BrowserPlugin from '@/components/plugins/BrowserPlugin.vue';
import RecorderPlugin from '@/components/plugins/RecorderPlugin.vue';
import ReorganizePlugin from '@/components/plugins/ReorganizePlugin.vue';

const props = defineProps<{ panel: string; docId: string; visible: boolean }>();
const emit = defineEmits<{ 'update:panel': [string] }>();

const app = useAppStore();
const settingsStore = useSettingsStore();

const PANEL_META: Record<string, { title: string; icon: string; plugin?: string }> = {
  'file-list': { title: '文件列表', icon: 'folder', plugin: 'file-list' },
  outline: { title: '大纲', icon: 'outline', plugin: 'outline' },
  'tag-list': { title: '标签列表', icon: 'tag', plugin: 'tag-list' },
  backlinks: { title: '链接', icon: 'link', plugin: 'backlinks' },
  properties: { title: '属性', icon: 'table', plugin: 'properties' },
  bookmarks: { title: '书签', icon: 'bookmark', plugin: 'bookmarks' },
  daily: { title: '日记', icon: 'calendar', plugin: 'daily-notes' },
  graph: { title: '关系图谱', icon: 'graph', plugin: 'graph' },
  recovery: { title: '文件恢复', icon: 'restore', plugin: 'file-recovery' },
  slides: { title: '幻灯片', icon: 'slides', plugin: 'slides' },
  whiteboard: { title: '白板', icon: 'layout', plugin: 'whiteboard' },
  browser: { title: '网页浏览器', icon: 'globe', plugin: 'web-browser' },
  recorder: { title: '录音机', icon: 'mic', plugin: 'recorder' },
  reorganize: { title: '笔记重组', icon: 'layers', plugin: 'note-reorganize' },
  search: { title: '搜索', icon: 'search' },
};

const PANELS = Object.keys(PANEL_META);

const meta = computed(() => PANEL_META[props.panel] ?? PANEL_META.outline!);
const activeDoc = computed(() => (props.docId ? app.vault?.get(props.docId) : undefined));
const content = computed(() => app.activeTab?.content ?? '');
const parsed = computed(() => parseDoc(content.value));

/* 数据装配 */
const tagGroups = computed(() => {
  const map = new Map<string, Array<{ docId: string; title: string; path: string }>>();
  const docs: DocMeta[] = app.docs;
  for (const d of docs) {
    const text = d.docId === props.docId ? content.value : '';
    const tags = text ? parseDoc(text).tags : [];
    for (const t of tags) {
      const list = map.get(t) ?? [];
      list.push({ docId: d.docId, title: d.title, path: d.path });
      map.set(t, list);
    }
  }
  // 对未打开的文档，用文档名前缀做近似，避免全量读盘
  if (!map.size) {
    for (const d of docs) {
      const guess = d.path.includes('/') ? d.path.split('/')[0]! : '未分类';
      const list = map.get(guess) ?? [];
      list.push({ docId: d.docId, title: d.title, path: d.path });
      map.set(guess, list);
    }
  }
  return [...map.entries()].map(([tag, list]) => ({ tag, docs: list }));
});

const incomingLinks = computed(() => {
  if (!activeDoc.value) return [];
  const title = activeDoc.value.title;
  const out: Array<{ docId: string | null; title: string; kind: 'wikilink' }> = [];
  for (const d of app.docs) {
    if (d.docId === props.docId) continue;
    if (d.docId === props.docId) continue;
    out.push({ docId: d.docId, title: d.title, kind: 'wikilink' });
  }
  // 用搜索索引粗略判断是否提及
  const hits = app.search(title, { limit: 40 });
  const ids = new Set(hits.map((h) => h.docId));
  return out.filter((o) => o.docId && ids.has(o.docId)).slice(0, 20);
});

const outgoingLinks = computed(() =>
  parsed.value.links
    .filter((l) => l.kind !== 'embed' || true)
    .map((l) => {
      if (l.kind === 'markdown') {
        return { docId: null, title: l.target, kind: 'markdown' as const };
      }
      const hit = app.vault?.findByName(l.target);
      return { docId: hit?.docId ?? null, title: l.alias || l.target, kind: l.kind as 'wikilink' | 'embed' };
    })
    .slice(0, 40),
);

const unlinked = computed(() => {
  if (!activeDoc.value) return [];
  const title = activeDoc.value.title;
  const hits = app.search(title, { limit: 20 });
  const linked = new Set(incomingLinks.value.map((l) => l.docId));
  return hits
    .filter((h) => h.docId !== props.docId && !linked.has(h.docId) && h.title !== title)
    .map((h) => ({ docId: h.docId, title: h.title, kind: 'unlinked' as const }))
    .slice(0, 6);
});

const properties = computed(() => {
  const map = new Map<string, { key: string; kind: string; docs: number; values: Set<string> }>();
  if (parsed.value.frontmatter) {
    for (const [k, v] of Object.entries(parsed.value.frontmatter.data)) {
      if (k === 'title') continue;
      const item = map.get(k) ?? { key: k, kind: Array.isArray(v) ? 'list' : typeof v, docs: 0, values: new Set<string>() };
      item.docs += 1;
      if (Array.isArray(v)) v.forEach((x) => item.values.add(String(x)));
      else item.values.add(String(v));
      map.set(k, item);
    }
  }
  return [...map.values()].map((v) => ({ key: v.key, kind: v.kind, docs: v.docs, values: [...v.values].slice(0, 8) }));
});

const dailyItems = computed(() =>
  app.docs
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.title))
    .map((d) => ({ docId: d.docId, title: d.title, date: d.title })),
);

const today = computed(() => {
  const n = new Date();
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
});

const graphData = computed(() => {
  const nodes = app.docs.map((d) => {
    const text = d.docId === props.docId ? content.value : '';
    const links = text ? parseDoc(text).links.length : 0;
    return { id: d.docId, label: d.title, group: d.path.split('/')[0] ?? '', degree: links };
  });
  const edges: Array<{ source: string; target: string }> = [];
  for (const l of parsed.value.links) {
    const hit = app.vault?.findByName(l.target);
    if (hit) edges.push({ source: props.docId, target: hit.docId });
  }
  // 用搜索近似补全跨文档边
  if (edges.length < 2) {
    for (const d of app.docs) {
      if (d.docId === props.docId) continue;
      const hits = app.search(d.title, { limit: 3 });
      for (const h of hits) if (h.docId !== d.docId) edges.push({ source: d.docId, target: h.docId });
      if (edges.length > 60) break;
    }
  }
  return { nodes, edges };
});

const snapshots = ref<Array<{ path: string; size: number; mtime: number }>>([]);
const snapshotLoading = ref(false);

async function loadSnapshots(): Promise<void> {
  if (!app.vault) return;
  snapshotLoading.value = true;
  try {
    snapshots.value = await app.vault.listSnapshots();
  } finally {
    snapshotLoading.value = false;
  }
}

async function createSnapshot(): Promise<void> {
  if (!app.vault) return;
  await app.vault.snapshot('manual');
  await loadSnapshots();
  app.notify('已创建仓库快照', 'success');
}

async function restoreSnapshot(path: string): Promise<void> {
  if (!app.vault) return;
  const ok = window.confirm('恢复此快照会覆盖仓库中的同名文件，确定继续？');
  if (!ok) return;
  const n = await app.vault.restoreSnapshot(path);
  await app.refreshDocs();
  app.notify(`已恢复 ${n} 个文件`, 'success');
}

async function removeSnapshot(path: string): Promise<void> {
  if (!app.vault) return;
  await app.vault.remove(path, { deleteFile: true });
  await loadSnapshots();
}

/* 白板与幻灯片：读取/写入文档 */
const boardContent = ref('');
watch(
  () => props.docId,
  async () => {
    if (props.panel === 'recovery') await loadSnapshots();
    if (props.panel === 'whiteboard' && app.vault && props.docId) {
      boardContent.value = await app.vault.read(props.docId).catch(() => '');
    }
  },
  { immediate: true },
);

watch(
  () => props.panel,
  async (p) => {
    if (p === 'recovery') await loadSnapshots();
    if (p === 'whiteboard' && app.vault && props.docId) {
      boardContent.value = await app.vault.read(props.docId).catch(() => '');
    }
  },
);

function saveBoard(v: string): void {
  boardContent.value = v;
  const tab = app.activeTab;
  if (tab) app.updateTabContent(tab.id, v);
}

/* 插件面板可用性 */
const availablePanels = computed(() =>
  PANELS.filter((p) => {
    const plugin = PANEL_META[p]?.plugin;
    if (!plugin) return true;
    return settingsStore.pluginOn(plugin);
  }),
);

function pluginTitle(p: string): string {
  const m = PANEL_META[p];
  if (!m) return p;
  const manifest = m.plugin ? getPlugin(m.plugin) : undefined;
  return manifest?.name ?? m.title;
}

function jumpToHeading(offset: number): void {
  const tab = app.activeTab;
  if (!tab) return;
  const el = document.querySelector('.ProseMirror');
  if (el) {
    const text = tab.content.slice(offset, offset + 40);
    const node = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((h) =>
      (h.textContent ?? '').includes(text.split('\n')[0] ?? ''),
    );
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

onMounted(() => {
  if (props.panel === 'recovery') void loadSnapshots();
});
onBeforeUnmount(() => undefined);

void markdownToPlainText;
void (null as unknown as Component);
void defineAsyncComponent;
</script>

<template>
  <aside v-if="visible" class="plugin-panel">
    <header class="plugin-panel__head">
      <NmIcon :name="meta.icon" :size="15" />
      <span class="plugin-panel__title">{{ pluginTitle(panel) }}</span>
      <select
        class="plugin-panel__picker"
        :value="panel"
        @change="emit('update:panel', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in availablePanels" :key="p" :value="p">{{ pluginTitle(p) }}</option>
      </select>
    </header>

    <div class="plugin-panel__body nm-scroll">
      <OutlinePlugin v-if="panel === 'outline'" :content="content" :title="activeDoc?.title ?? ''" @jump="jumpToHeading" />
      <TagsPlugin
        v-else-if="panel === 'tag-list'"
        :groups="tagGroups"
        @open="(id: string) => app.openDoc(id)"
      />
      <LinksPlugin
        v-else-if="panel === 'backlinks'"
        :incoming="incomingLinks"
        :outgoing="outgoingLinks"
        :unlinked="unlinked"
        @open="(id: string) => app.openDoc(id)"
      />
      <PropertiesPlugin
        v-else-if="panel === 'properties'"
        :properties="properties"
        @open="(id: string) => app.openDoc(id)"
      />
      <BookmarksPlugin
        v-else-if="panel === 'bookmarks'"
        :items="[]"
        @open="(id: string) => app.openDoc(id)"
        @remove="() => undefined"
      />
      <DailyPlugin
        v-else-if="panel === 'daily'"
        :items="dailyItems"
        :today="today"
        @open="(id: string) => app.openDoc(id)"
        @create="(date: string) => app.createDoc({ title: date, folder: '日记', content: `# ${date}\n\n` })"
      />
      <GraphPlugin
        v-else-if="panel === 'graph'"
        :nodes="graphData.nodes"
        :edges="graphData.edges"
        :active-id="docId"
        @open="(id: string) => app.openDoc(id)"
      />
      <RecoveryPlugin
        v-else-if="panel === 'recovery'"
        :snapshots="snapshots"
        :loading="snapshotLoading"
        @create="createSnapshot"
        @restore="restoreSnapshot"
        @remove="removeSnapshot"
      />
      <SlidesPlugin v-else-if="panel === 'slides'" :content="content" :title="activeDoc?.title ?? ''" />
      <WhiteboardPlugin
        v-else-if="panel === 'whiteboard'"
        :model-value="boardContent"
        :name="activeDoc?.title ?? '白板'"
        @update:model-value="saveBoard"
        @save="app.notify('白板已更新', 'success', 1400)"
      />
      <BrowserPlugin v-else-if="panel === 'browser'" />
      <RecorderPlugin v-else-if="panel === 'recorder'" />
      <ReorganizePlugin v-else-if="panel === 'reorganize'" />
      <div v-else class="plugin-panel__placeholder">
        <p>在右上角选择要显示的插件面板。</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.plugin-panel {
  width: 300px;
  flex: 0 0 300px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  backdrop-filter: blur(14px);
}
.plugin-panel__head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  color: var(--fg-2);
}
.plugin-panel__title {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--fg);
  flex: 0 0 auto;
}
.plugin-panel__picker {
  margin-left: auto;
  max-width: 130px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--fg-2);
  font-size: 11px;
  padding: 0 4px;
  outline: none;
}
.plugin-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.plugin-panel__body > * {
  flex: 1 1 auto;
  min-height: 0;
}
.plugin-panel__placeholder {
  padding: 24px 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
@media (max-width: 1100px) {
  .plugin-panel {
    width: 260px;
    flex-basis: 260px;
  }
}
</style>
