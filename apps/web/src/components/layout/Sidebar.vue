<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { DocMeta } from '@neomd/shared';
import { relativeTime } from '@neomd/shared';

const props = defineProps<{
  docs: DocMeta[];
  activeDocId: string;
  activePanel: string;
}>();

const emit = defineEmits<{
  open: [string];
  selectPanel: [string];
  create: [];
  commandPalette: [];
  settings: [];
  sync: [];
  history: [];
}>();

const filter = ref('');
const collapsed = ref<Set<string>>(new Set());

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  doc?: DocMeta;
  children: Node[];
  depth: number;
}

const tree = computed<Node[]>(() => {
  const root: Node[] = [];
  const dirs = new Map<string, Node>();
  const keyword = filter.value.trim().toLowerCase();

  const ensureDir = (parts: string[]): Node[] => {
    let container = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let node = dirs.get(acc);
      if (!node) {
        node = { name: part, path: acc, isDir: true, children: [], depth: parts.indexOf(part) };
        dirs.set(acc, node);
        container.push(node);
      }
      container = node.children;
    }
    return container;
  };

  for (const doc of props.docs) {
    if (keyword && !doc.path.toLowerCase().includes(keyword) && !doc.title.toLowerCase().includes(keyword)) continue;
    const segments = doc.path.split('/');
    const file = segments.pop() ?? doc.path;
    const container = ensureDir(segments);
    container.push({ name: file, path: doc.path, isDir: false, doc, children: [], depth: segments.length });
  }

  const sortNodes = (nodes: Node[]): void => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    for (const n of nodes) if (n.children.length) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
});

const recent = computed(() => [...props.docs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5));

function toggleDir(path: string): void {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

function isCollapsed(path: string): boolean {
  return collapsed.value.has(path);
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__head">
      <div class="sidebar__title">
        <NmIcon name="folderOpen" :size="15" />
        <span>仓库</span>
      </div>
      <div class="sidebar__actions">
        <button class="icon-btn" title="新建文档" @click="emit('create')"><NmIcon name="plus" :size="15" /></button>
        <button class="icon-btn" title="命令面板 Ctrl+P" @click="emit('commandPalette')">
          <NmIcon name="command" :size="15" />
        </button>
      </div>
    </div>

    <div class="sidebar__search">
      <NmIcon name="search" :size="14" />
      <input v-model="filter" placeholder="筛选文件" />
    </div>

    <div class="sidebar__body nm-scroll">
      <div v-if="recent.length" class="sidebar__section">
        <div class="section-label">最近打开</div>
        <button
          v-for="doc in recent"
          :key="`recent-${doc.docId}`"
          class="file-row file-row--recent"
          :class="{ 'is-active': doc.docId === activeDocId }"
          @click="emit('open', doc.docId)"
        >
          <NmIcon name="clock" :size="13" />
          <span class="file-row__name">{{ doc.title }}</span>
          <span class="file-row__meta">{{ relativeTime(doc.updatedAt) }}</span>
        </button>
      </div>

      <div class="sidebar__section">
        <div class="section-label">全部文件</div>
        <template v-for="node in tree" :key="node.path">
          <button
            v-if="node.isDir"
            class="file-row file-row--dir"
            :style="{ paddingLeft: `${8 + node.depth * 12}px` }"
            @click="toggleDir(node.path)"
          >
            <NmIcon :name="isCollapsed(node.path) ? 'chevronRight' : 'chevronDown'" :size="12" />
            <NmIcon name="folder" :size="13" />
            <span class="file-row__name">{{ node.name }}</span>
          </button>
          <template v-if="node.isDir && !isCollapsed(node.path)">
            <template v-for="child in node.children" :key="child.path">
              <button
                v-if="!child.isDir"
                class="file-row"
                :class="{ 'is-active': child.doc?.docId === activeDocId }"
                :style="{ paddingLeft: `${22 + child.depth * 12}px` }"
                @click="child.doc && emit('open', child.doc.docId)"
              >
                <NmIcon name="file" :size="13" />
                <span class="file-row__name">{{ child.doc?.title ?? child.name }}</span>
              </button>
              <button
                v-else
                class="file-row file-row--dir"
                :style="{ paddingLeft: `${8 + child.depth * 12}px` }"
                @click="toggleDir(child.path)"
              >
                <NmIcon :name="isCollapsed(child.path) ? 'chevronRight' : 'chevronDown'" :size="12" />
                <NmIcon name="folder" :size="13" />
                <span class="file-row__name">{{ child.name }}</span>
              </button>
            </template>
          </template>
          <button
            v-else
            class="file-row"
            :class="{ 'is-active': node.doc?.docId === activeDocId }"
            :style="{ paddingLeft: `${10 + node.depth * 12}px` }"
            @click="node.doc && emit('open', node.doc.docId)"
          >
            <NmIcon name="file" :size="13" />
            <span class="file-row__name">{{ node.doc?.title ?? node.name }}</span>
          </button>
        </template>
        <p v-if="!docs.length" class="sidebar__empty">仓库还是空的，点右上角 + 新建第一篇。</p>
      </div>
    </div>

    <div class="sidebar__foot">
      <button class="foot-btn" title="搜索全库 Ctrl+Shift+F" @click="emit('selectPanel', 'search')">
        <NmIcon name="search" :size="16" />
      </button>
      <button class="foot-btn" title="关系图谱" @click="emit('selectPanel', 'graph')">
        <NmIcon name="graph" :size="16" />
      </button>
      <button class="foot-btn" title="日记" @click="emit('selectPanel', 'daily')">
        <NmIcon name="calendar" :size="16" />
      </button>
      <button class="foot-btn" title="版本历史" @click="emit('history')">
        <NmIcon name="history" :size="16" />
      </button>
      <button class="foot-btn foot-btn--push" title="同步 Ctrl+S" @click="emit('sync')">
        <NmIcon name="sync" :size="16" />
      </button>
      <button class="foot-btn" title="设置" @click="emit('settings')">
        <NmIcon name="settings" :size="16" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  backdrop-filter: blur(14px);
}
.sidebar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 8px 14px;
  flex: 0 0 auto;
}
.sidebar__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.sidebar__actions {
  display: flex;
  gap: 2px;
}
.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.sidebar__search {
  margin: 0 10px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border-radius: 7px;
  background: var(--bg-hover);
  color: var(--fg-3);
  flex: 0 0 auto;
}
.sidebar__search input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 12.5px;
  color: var(--fg);
  min-width: 0;
}
.sidebar__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 12px;
}
.sidebar__section {
  margin-top: 6px;
}
.section-label {
  padding: 8px 14px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px 5px 10px;
  font-size: 13px;
  color: var(--fg-2);
  text-align: left;
  border-radius: 0;
  line-height: 1.5;
}
.file-row:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.file-row.is-active {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 550;
}
.file-row__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-row__meta {
  font-size: 10.5px;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.file-row--dir {
  font-weight: 550;
  color: var(--fg);
}
.sidebar__empty {
  margin: 16px 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.sidebar__foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.foot-btn {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.foot-btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.foot-btn--push {
  margin-left: auto;
}
</style>
