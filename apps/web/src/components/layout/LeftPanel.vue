<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { DocMeta, LeftPanelMode } from '@neomd/shared';
import type { SearchHit } from '@neomd/core';
import { relativeTime } from '@neomd/shared';
import { onTitlebarDblClick } from '@/composables/useDesktopWindow';
import ResizeHandle from './ResizeHandle.vue';
import { useLocalLayout } from '@/lib/local-layout';
import type { DocSortKey, VaultEntry } from '@/stores/app';

const props = defineProps<{
  docs: DocMeta[];
  activeDocId: string;
  showRecent: boolean;
  recentCount: number;
  view: LeftPanelMode;
  outlineContent: string;
  outlineHeadings: Array<{ level: number; text: string; offset: number }>;
  sortBy?: DocSortKey;
  folderOrder?: string[];
  customFolders?: string[];
  vaultName?: string;
  vaults?: VaultEntry[];
  searchHits?: SearchHit[];
  searchQuery?: string;
}>();

const emit = defineEmits<{
  open: [string];
  create: [];
  createFolder: [];
  outlineJump: [number];
  docMenu: [{ docId: string; x: number; y: number }];
  setView: [LeftPanelMode];
  setSort: [DocSortKey];
  reorderFolders: [string[]];
  moveDoc: [{ docId: string; folder: string }];
  switchVault: [string];
  createVault: [];
  openLocalVault: [];
  'update:searchQuery': [string];
  'rename': [string];
  'move-path': [string];
  'delete': [string];
  'show-in-folder': [string];
}>();

const filter = ref('');
const collapsed = ref<Set<string>>(new Set());
const menu = ref<{ docId: string; x: number; y: number } | null>(null);
const sortOpen = ref(false);
const vaultOpen = ref(false);
const layoutOpen = ref(false);
const draggingFolder = ref<string | null>(null);
const draggingDocId = ref<string | null>(null);
const dragOverFolder = ref<string | null>(null);

/**
 * 「大纲 + 文件列表」模式下大纲区的高度。
 * 只存本机 localStorage（见 lib/local-layout.ts），不写进 settings 云同步 —— 换了设备
 * 这个值本来也没有参考意义，用户明确要求不要同步传输。
 */
const { layout: localLayout, update: updateLocalLayout } = useLocalLayout();
const outlineHeight = computed(() => localLayout.value.outlineHeight);
const outlineBounds = { min: 150, max: 800, defaultValue: 320 };

/** 拖动分隔条时更新大纲区高度（同页其它组件共享同一份 localStorage 状态） */
function onOutlineHeight(value: number): void {
  updateLocalLayout({ outlineHeight: value });
}

const SORT_OPTIONS: Array<{ id: DocSortKey; label: string }> = [
  { id: 'updated-desc', label: '修改时间（从新到旧）' },
  { id: 'updated-asc', label: '修改时间（从旧到新）' },
  { id: 'created-desc', label: '创建时间（从新到旧）' },
  { id: 'created-asc', label: '创建时间（从旧到新）' },
  { id: 'title-asc', label: '文件名（A → Z）' },
  { id: 'title-desc', label: '文件名（Z → A）' },
];

const LAYOUT_OPTIONS: Array<{ id: LeftPanelMode; label: string; icon: string }> = [
  { id: 'files', label: '文件列表', icon: 'folder' },
  { id: 'outline', label: '大纲', icon: 'outline' },
  { id: 'both', label: '大纲 + 文件列表', icon: 'layers' },
];

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  doc?: DocMeta;
  children: Node[];
  depth: number;
}

/** 最近打开：按修改时间最新优先 */
const recent = computed(() =>
  [...props.docs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, props.recentCount)),
);

/**
 * 全部文件：若开启「最近打开」，则隐藏最近打开中已出现的文档，
 * 避免同一文件在两个分组里重复出现。
 *
 * 1.1.7（需求 I）：`both`（大纲 + 文件列表）模式下**不渲染**「最近打开」分组，
 * 因此这里也不能再按它过滤 —— 否则被「最近打开」选中的那几篇文档会在
 * 全部文件里凭空消失（用户会以为文档丢了）。
 */
const filesForAll = computed(() => {
  if (!props.showRecent) return props.docs;
  if (props.view === 'both') return props.docs;
  const recentIds = new Set(recent.value.map((d) => d.docId));
  return props.docs.filter((d) => !recentIds.has(d.docId));
});

function compareDocNodes(a: Node, b: Node): number {
  const da = a.doc;
  const db = b.doc;
  if (!da || !db) return a.name.localeCompare(b.name, 'zh');
  switch (props.sortBy) {
    case 'title-asc':
      return da.title.localeCompare(db.title, 'zh');
    case 'title-desc':
      return db.title.localeCompare(da.title, 'zh');
    case 'created-desc':
      return (db.createdAt ?? db.updatedAt) - (da.createdAt ?? da.updatedAt);
    case 'created-asc':
      return (da.createdAt ?? da.updatedAt) - (db.createdAt ?? db.updatedAt);
    case 'updated-asc':
      return da.updatedAt - db.updatedAt;
    case 'updated-desc':
    default:
      return db.updatedAt - da.updatedAt;
  }
}

function compareDirNodes(a: Node, b: Node): number {
  const order = props.folderOrder ?? [];
  const ia = order.indexOf(a.path);
  const ib = order.indexOf(b.path);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.name.localeCompare(b.name, 'zh');
}

const treeForAll = computed<Node[]>(() => {
  const root: Node[] = [];
  const dirs = new Map<string, Node>();
  const keyword = filter.value.trim().toLowerCase();
  const ensureDir = (parts: string[]): Node[] => {
    let container = root;
    let acc = '';
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      acc = acc ? `${acc}/${part}` : part;
      let node = dirs.get(acc);
      if (!node) {
        node = { name: part, path: acc, isDir: true, children: [], depth: i };
        dirs.set(acc, node);
        container.push(node);
      }
      container = node.children;
    }
    return container;
  };

  for (const folder of props.customFolders ?? []) {
    if (!folder) continue;
    const parts = folder.split('/').filter(Boolean);
    if (parts.length) ensureDir(parts);
  }

  for (const doc of props.docs) {
    const segments = doc.path.split('/');
    segments.pop();
    if (segments.length) ensureDir(segments);
  }

  for (const doc of filesForAll.value) {
    if (keyword && !doc.path.toLowerCase().includes(keyword) && !doc.title.toLowerCase().includes(keyword)) continue;
    const segments = doc.path.split('/');
    segments.pop();
    ensureDir(segments).push({
      name: doc.path.split('/').pop() ?? doc.path,
      path: doc.path,
      isDir: false,
      doc,
      children: [],
      depth: segments.length,
    });
  }

  const sortNodes = (nodes: Node[]): void => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (a.isDir && b.isDir) return compareDirNodes(a, b);
      return compareDocNodes(a, b);
    });
    for (const n of nodes) if (n.children.length) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
});

function toggleDir(path: string): void {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

function isCollapsed(path: string): boolean {
  return collapsed.value.has(path);
}

function onFolderDragStart(e: DragEvent, folderPath: string): void {
  draggingFolder.value = folderPath;
  draggingDocId.value = null;
  e.dataTransfer?.setData('text/plain', `folder:${folderPath}`);
}

function onDocDragStart(e: DragEvent, docId: string): void {
  draggingDocId.value = docId;
  draggingFolder.value = null;
  e.dataTransfer?.setData('text/plain', `doc:${docId}`);
}

function onFolderDragOver(e: DragEvent, targetPath: string): void {
  e.preventDefault();
  dragOverFolder.value = targetPath;
}

function onFolderDrop(e: DragEvent, targetPath: string): void {
  e.preventDefault();
  dragOverFolder.value = null;
  if (draggingDocId.value) {
    emit('moveDoc', { docId: draggingDocId.value, folder: targetPath });
    draggingDocId.value = null;
    return;
  }
  const src = draggingFolder.value;
  draggingFolder.value = null;
  if (!src || src === targetPath) return;
  const topDirs = treeForAll.value.filter((n) => n.isDir).map((n) => n.path);
  const list = [...new Set([...(props.folderOrder ?? []), ...topDirs])];
  const fromIdx = list.indexOf(src);
  const toIdx = list.indexOf(targetPath);
  if (fromIdx === -1 || toIdx === -1) return;
  list.splice(fromIdx, 1);
  list.splice(toIdx, 0, src);
  emit('reorderFolders', list);
}

function onDragEnd(): void {
  draggingFolder.value = null;
  draggingDocId.value = null;
  dragOverFolder.value = null;
}

function openMenu(e: MouseEvent, docId: string): void {
  e.preventDefault();
  e.stopPropagation();
  const x = e.clientX;
  const y = e.clientY;
  setTimeout(() => {
    menu.value = { docId, x, y };
  }, 0);
}

/** 文件右键菜单：重命名 与 移动路径 拆分为两个独立菜单项 */
const MENU = [
  { key: 'open', label: '打开', icon: 'file' },
  { key: 'rename', label: '重命名', icon: 'edit' },
  { key: 'move-path', label: '移动至文件夹…', icon: 'folder' },
  { sep: true },
  { key: 'copy-path', label: '复制路径', icon: 'copy' },
  { key: 'show-in-folder', label: '在文件夹中显示', icon: 'external' },
  { sep: true },
  { key: 'delete', label: '删除', icon: 'trash', danger: true },
] as Array<{ key?: string; label?: string; icon?: string; sep?: boolean; danger?: boolean }>;

function menuPos(m: { x: number; y: number }): { left: string; top: string } {
  const vw = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1200;
  const vh = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 800;
  return {
    left: `${Math.min(m.x, Math.max(8, vw - 200))}px`,
    top: `${Math.min(m.y, Math.max(8, vh - 280))}px`,
  };
}

function chooseAction(key: string): void {
  const m = menu.value;
  menu.value = null;
  if (!m) return;
  if (key === 'open') emit('open', m.docId);
  else if (key === 'rename') emit('rename', m.docId);
  else if (key === 'move-path') emit('move-path', m.docId);
  else if (key === 'delete') emit('delete', m.docId);
  else if (key === 'copy-path') {
    const doc = props.docs.find((d) => d.docId === m.docId);
    if (doc) void navigator.clipboard?.writeText(doc.path);
  } else if (key === 'show-in-folder') {
    emit('show-in-folder', m.docId);
  }
}

function onDocContext(e: MouseEvent, docId: string): void {
  openMenu(e, docId);
  emit('docMenu', { docId, x: e.clientX, y: e.clientY });
}

function toggleSearchView(): void {
  sortOpen.value = false;
  vaultOpen.value = false;
  layoutOpen.value = false;
  emit('setView', props.view === 'search' ? 'files' : 'search');
}

/* ---------------- 顶部合并搜索框（1.1.8） ---------------- */

/**
 * 提交搜索（回车或点搜索按钮）。
 *
 * 原来的交互是「先点一个放大镜按钮切到搜索视图，再在下面第二个输入框里打字」，
 * 两步且有两个输入框。现在合并成一个：这个输入框输入即过滤，回车/点按钮
 * 才把侧栏切到「搜索结果」视图（全库检索文件名 + 正文）。
 */
function submitSearch(): void {
  sortOpen.value = false;
  vaultOpen.value = false;
  layoutOpen.value = false;
  if (props.view !== 'search') emit('setView', 'search');
}

/** 聚焦搜索框时自动切到搜索视图，让用户输入即可看到结果 */
function onSearchFocus(): void {
  if (props.view !== 'search') emit('setView', 'search');
}

/** 清空搜索词并退回文件列表 */
function clearSearch(): void {
  emit('update:searchQuery', '');
  if (props.view === 'search') emit('setView', 'files');
}

/** 当前布局的中文名（用于下拉按钮的 title / 无障碍标签） */
const currentLayoutLabel = computed(() => {
  if (props.view === 'search') return '搜索';
  return LAYOUT_OPTIONS.find((o) => o.id === props.view)?.label ?? '文件列表';
});

/**
 * 布局按钮：左键点开下拉选择，而不是「点一下换一种」的循环切换。
 * 循环切换在三种布局之间来回跳，用户很难精确选到想要的那个。
 */
function toggleLayoutMenu(): void {
  layoutOpen.value = !layoutOpen.value;
  sortOpen.value = false;
  vaultOpen.value = false;
}

/** 从下拉里选中一种布局 */
function chooseLayout(id: LeftPanelMode): void {
  layoutOpen.value = false;
  emit('setView', id);
}

function chooseSort(id: DocSortKey): void {
  sortOpen.value = false;
  emit('setSort', id);
}

const layoutTitle = computed(() => `布局：${currentLayoutLabel.value}（点击选择）`);

function closeMenu(e?: MouseEvent): void {
  menu.value = null;
  if (e && !(e.target as HTMLElement | null)?.closest('.pop-anchor')) {
    sortOpen.value = false;
    vaultOpen.value = false;
    layoutOpen.value = false;
  }
}

onMounted(() => {
  window.addEventListener('mousedown', closeMenu);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', closeMenu);
});
</script>

<template>
  <aside class="leftpanel">
    <!--
      顶部工具栏（1.1.8 调整）：
      用户原话「现有仓库的位置作为搜索框与搜索按钮合并」——
      原来这里放的是仓库选择器，现在改为「输入框 + 内置搜索图标按钮」的合并搜索控件。
      仓库选择器已下移到页脚（原「设置」按钮的位置）。
    -->
    <div class="leftpanel__header pop-anchor nm-drag" @dblclick="onTitlebarDblClick($event)">
      <div class="leftsearch" role="search">
        <NmIcon name="search" :size="14" class="leftsearch__icon" />
        <input
          class="leftsearch__input"
          type="search"
          :value="searchQuery ?? ''"
          placeholder="搜索文件名与正文…"
          aria-label="搜索文件名与正文"
          @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
          @keydown.enter="submitSearch"
          @focus="onSearchFocus"
        />
        <button v-if="searchQuery" class="leftsearch__clear" title="清空" @click="clearSearch">
          <NmIcon name="close" :size="12" />
        </button>
        <button class="leftsearch__btn" title="搜索（回车）" aria-label="搜索" @click="submitSearch">
          <NmIcon name="search" :size="13" />
        </button>
      </div>

      <div class="leftpanel__tools">
        <!-- 布局：点击打开下拉，选择 文件列表 / 大纲 / 大纲+文件列表 -->
        <button
          class="act"
          :class="{ 'is-active': layoutOpen || view === 'outline' || view === 'both' }"
          :title="layoutTitle"
          aria-haspopup="menu"
          :aria-expanded="layoutOpen"
          @click="toggleLayoutMenu"
        >
          <NmIcon :name="view === 'outline' ? 'outline' : view === 'both' ? 'layers' : 'folder'" :size="15" />
        </button>

        <!-- 排序方式：在大纲时隐藏；图标用上下双箭头，不再用漏斗（漏斗语义是筛选） -->
        <button
          v-if="view !== 'outline'"
          class="act"
          :class="{ 'is-active': sortOpen }"
          title="排序方式"
          @click="sortOpen = !sortOpen; vaultOpen = false; layoutOpen = false"
        >
          <NmIcon name="sort" :size="15" />
        </button>

        <!-- 分隔符 -->
        <span class="tools-sep" />

        <!-- 新建子文件夹 -->
        <button class="act" title="新建子文件夹" @click="emit('createFolder')">
          <NmIcon name="folder" :size="15" />
        </button>

        <!-- 新建文件 -->
        <button class="act act--primary" title="新建文档 Ctrl+N" @click="emit('create')">
          <NmIcon name="plus" :size="15" />
        </button>
      </div>

      <!-- 布局下拉菜单：点选即切换，替代原来的「点一下循环换一种」 -->
      <div v-if="layoutOpen" class="popmenu popmenu--right" role="menu" @mousedown.stop>
        <div class="popmenu__title">侧栏布局</div>
        <button
          v-for="opt in LAYOUT_OPTIONS"
          :key="opt.id"
          class="popmenu__item"
          :class="{ 'is-active': view === opt.id }"
          role="menuitemradio"
          :aria-checked="view === opt.id"
          @click="chooseLayout(opt.id)"
        >
          <NmIcon :name="opt.icon" :size="13" />
          <span class="popmenu__text">{{ opt.label }}</span>
          <NmIcon v-if="view === opt.id" name="check" :size="12" />
        </button>
      </div>

      <!-- 排序下拉菜单 -->
      <div v-if="sortOpen && view !== 'outline'" class="popmenu popmenu--right" @mousedown.stop>
        <div class="popmenu__title">排序方式</div>
        <button
          v-for="opt in SORT_OPTIONS"
          :key="opt.id"
          class="popmenu__item"
          :class="{ 'is-active': (sortBy ?? 'updated-desc') === opt.id }"
          @click="chooseSort(opt.id)"
        >
          <span>{{ opt.label }}</span>
          <NmIcon v-if="(sortBy ?? 'updated-desc') === opt.id" name="check" :size="12" />
        </button>
      </div>
    </div>

    <!-- 搜索模式：整块单滚动区（输入框已合并到顶部，这里只显示结果） -->
    <div v-if="view === 'search'" class="leftpanel__body nm-scroll">
      <div class="group-label">搜索结果（{{ (searchHits ?? []).length }}）</div>
      <button
        v-for="hit in searchHits ?? []"
        :key="hit.docId"
        class="search-hit"
        :class="{ 'is-active': hit.docId === activeDocId }"
        @click="emit('open', hit.docId)"
      >
        <div class="search-hit__title">
          <NmIcon name="file" :size="13" />
          <span>{{ hit.title }}</span>
        </div>
        <p v-if="hit.snippet" class="search-hit__snippet">{{ hit.snippet }}</p>
      </button>
      <p v-if="!(searchQuery ?? '').trim()" class="empty-hint">输入关键词即可检索整个仓库的文件名与正文。</p>
      <p v-else-if="!(searchHits ?? []).length" class="empty-hint">未找到匹配的文档。</p>
    </div>

    <!--
      大纲 / 文件列表模式：两种区块各自独立滚动。
      「大纲 + 文件列表」时大纲区高度由本地拖拽决定（localStorage，不同步），
      中间的水平手柄可拖动调整两者占比，双击手柄恢复默认高度。
    -->
    <div v-else class="leftpanel__panes">
      <!-- 大纲 -->
      <div
        v-if="view === 'outline' || view === 'both'"
        class="leftpanel__pane nm-scroll"
        :class="{ 'leftpanel__pane--fixed': view === 'both' }"
        :style="view === 'both' ? { height: `${outlineHeight}px` } : undefined"
      >
        <div v-if="view === 'both'" class="group-label">大纲</div>
        <div class="outline-list">
          <button
            v-for="(h, i) in outlineHeadings"
            :key="i"
            class="outline-row"
            :class="`lv${h.level}`"
            :style="{ paddingLeft: `${8 + (h.level - 1) * 12}px` }"
            @click="emit('outlineJump', h.offset)"
          >
            <span class="outline-row__dot" />
            <span class="outline-row__text">{{ h.text || '（空标题）' }}</span>
          </button>
          <p v-if="!outlineHeadings.length" class="empty-hint">本篇还没有标题，用 Ctrl+1~6 快速设置。</p>
        </div>
      </div>

      <!-- 大纲与文件列表之间的水平分隔条（仅双区模式出现） -->
      <ResizeHandle
        v-if="view === 'both'"
        direction="horizontal"
        :value="outlineHeight"
        :min="outlineBounds.min"
        :max="outlineBounds.max"
        :default-value="outlineBounds.defaultValue"
        label="调整大纲高度"
        @update="onOutlineHeight"
      />

      <!-- 最近打开 + 全部文件 -->
      <div v-if="view === 'files' || view === 'both'" class="leftpanel__pane nm-scroll">
        <!-- 1.1.7（需求 I）：大纲 + 文件列表模式下不显示「最近打开」。
             该模式下上半屏是大纲、下半屏空间本就紧张，再插一段最近打开会挤压文件列表；
             用户在此模式下的意图是「看结构 + 找文件」，最近打开属于纯文件列表模式的辅助。 -->
        <template v-if="showRecent && recent.length && view !== 'both'">
          <div class="group-label">最近打开</div>
          <button
            v-for="doc in recent"
            :key="`r-${doc.docId}`"
            class="file-row"
            :class="{ 'is-active': doc.docId === activeDocId }"
            draggable="true"
            @dragstart="onDocDragStart($event, doc.docId)"
            @dragend="onDragEnd"
            @click="emit('open', doc.docId)"
            @contextmenu="onDocContext($event, doc.docId)"
          >
            <NmIcon name="clock" :size="13" />
            <span class="file-row__name">{{ doc.title }}</span>
            <span class="file-row__meta">{{ relativeTime(doc.updatedAt) }}</span>
          </button>
        </template>

        <div class="group-label">全部文件</div>
        <template v-for="node in treeForAll" :key="node.path">
          <button
            v-if="node.isDir"
            class="file-row file-row--dir"
            :class="{ 'is-dragover': dragOverFolder === node.path }"
            :style="{ paddingLeft: `${8 + node.depth * 12}px` }"
            draggable="true"
            title="可拖动调整文件夹顺序，或将文件拖入此文件夹"
            @dragstart="onFolderDragStart($event, node.path)"
            @dragover="onFolderDragOver($event, node.path)"
            @drop="onFolderDrop($event, node.path)"
            @dragend="onDragEnd"
            @click="toggleDir(node.path)"
          >
            <NmIcon :name="isCollapsed(node.path) ? 'chevronRight' : 'chevronDown'" :size="12" />
            <NmIcon name="folder" :size="13" />
            <span class="file-row__name">{{ node.name }}</span>
          </button>
          <template v-if="node.isDir && !isCollapsed(node.path)">
            <button
              v-for="child in node.children.filter((c) => !c.isDir)"
              :key="child.path"
              class="file-row"
              :class="{ 'is-active': child.doc?.docId === activeDocId }"
              :style="{ paddingLeft: `${22 + child.depth * 12}px` }"
              draggable="true"
              @dragstart="child.doc && onDocDragStart($event, child.doc.docId)"
              @dragend="onDragEnd"
              @click="child.doc && emit('open', child.doc.docId)"
              @contextmenu="child.doc && onDocContext($event, child.doc.docId)"
            >
              <NmIcon name="file" :size="13" />
              <span class="file-row__name">{{ child.doc?.title ?? child.name }}</span>
            </button>
          </template>
          <button
            v-if="!node.isDir"
            class="file-row"
            :class="{ 'is-active': node.doc?.docId === activeDocId }"
            :style="{ paddingLeft: `${10 + node.depth * 12}px` }"
            draggable="true"
            @dragstart="node.doc && onDocDragStart($event, node.doc.docId)"
            @dragend="onDragEnd"
            @click="node.doc && emit('open', node.doc.docId)"
            @contextmenu="node.doc && onDocContext($event, node.doc.docId)"
          >
            <NmIcon name="file" :size="13" />
            <span class="file-row__name">{{ node.doc?.title ?? node.name }}</span>
          </button>
        </template>
        <p v-if="!docs.length" class="empty-hint">仓库还是空的，点右上角 + 新建第一篇。</p>
        <p v-else-if="!filesForAll.length && !filter" class="empty-hint">
          全部文件已在上方「最近打开」中显示。
        </p>
      </div>
    </div>

    <!--
      页脚（1.1.8 调整）：
      用户原话「仓库移动到现在设置按钮的位置」——仓库选择器从顶部下移到这里；
      而「设置」按钮不再出现在界面上（只保留在用户头像菜单里），
      因此这个原来放设置按钮的位置正好让给仓库。
    -->
    <div class="leftpanel__foot">
      <div class="vaultpick vaultpick--foot">
        <button
          class="vaultpick__btn"
          title="切换或关联本地仓库"
          @click="vaultOpen = !vaultOpen; sortOpen = false; layoutOpen = false"
        >
          <NmIcon name="folder" :size="14" />
          <span class="vaultpick__name">{{ vaultName || 'Neo MD' }}</span>
          <NmIcon name="chevronDown" :size="11" />
        </button>
        <div v-if="vaultOpen" class="popmenu popmenu--up" @mousedown.stop>
          <div class="popmenu__title">切换仓库</div>
          <button
            v-for="v in vaults ?? []"
            :key="v.location"
            class="popmenu__item"
            :class="{ 'is-active': v.name === vaultName }"
            @click="vaultOpen = false; emit('switchVault', v.location)"
          >
            <NmIcon name="folder" :size="13" />
            <span class="popmenu__text">{{ v.name }}</span>
            <NmIcon v-if="v.name === vaultName" name="check" :size="12" />
          </button>
          <div class="popmenu__sep" />
          <button class="popmenu__item popmenu__item--accent" @click="vaultOpen = false; emit('openLocalVault')">
            <NmIcon name="folder" :size="13" />
            <span>关联本地文件夹…</span>
          </button>
          <button class="popmenu__item popmenu__item--accent" @click="vaultOpen = false; emit('createVault')">
            <NmIcon name="plus" :size="13" />
            <span>新建仓库…</span>
          </button>
        </div>
      </div>
      <slot name="footer" />
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="docmenu"
        :style="menuPos(menu)"
        @mousedown.stop
        @click.stop
      >
        <template v-for="(m, i) in MENU" :key="i">
          <div v-if="m.sep" class="docmenu__sep" />
          <button v-else class="docmenu__item" :class="{ 'is-danger': m.danger }" @click="chooseAction(m.key!)">
            <NmIcon :name="m.icon ?? 'more'" :size="13" />
            <span>{{ m.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.leftpanel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
.leftpanel__header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  /* 与右侧标题栏整体对齐：总高 40px（38px 工具栏 + 2px 顶部间隙），两侧不会一高一低。
     写死 40px 而非 var(--titlebar-h)：全局样式在 ≤820px 会把该变量改成 0px。 */
  height: 40px;
  min-height: 40px;
  padding: 2px 8px 0;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
/*
 * 合并搜索框（1.1.8）：输入框 + 内置搜索按钮，替代原来「放大镜按钮 + 第二个输入框」两步操作。
 * 左侧小图标只是视觉引导（不做点击），右侧按钮才是真正的提交入口。
 */
.leftsearch {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
  height: 26px;
  padding: 0 3px 0 8px;
  border-radius: 6px;
  background: var(--bg-hover);
  border: 1px solid transparent;
  transition: border-color 0.14s ease, background 0.14s ease;
}
.leftsearch:focus-within {
  background: var(--bg-input);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-weak);
}
.leftsearch__icon {
  color: var(--fg-3);
  flex: 0 0 auto;
}
.leftsearch__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
}
.leftsearch__input::placeholder {
  color: var(--fg-3);
}
/* 去掉 type="search" 在 WebKit 下的原生清除按钮，统一用我们自己的 */
.leftsearch__input::-webkit-search-cancel-button {
  display: none;
}
.leftsearch__clear {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.leftsearch__clear:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.leftsearch__btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.leftsearch__btn:hover {
  background: var(--accent-weak);
  color: var(--accent);
}
.vaultpick {
  position: relative;
  min-width: 0;
  flex: 1;
}
/* 页脚里的仓库选择器（1.1.8）：不再占满整行，与页脚右侧内容并排 */
.vaultpick--foot {
  flex: 0 1 auto;
  margin-right: auto;
}
.vaultpick__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
  background: var(--bg-hover);
}
.vaultpick__btn:hover {
  color: var(--accent);
}
.vaultpick__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.leftpanel__tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.tools-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 3px;
}
.act {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.act:hover,
.act.is-active {
  background: var(--bg-hover);
  color: var(--accent);
}
.act--primary {
  color: var(--accent);
}
.popmenu {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  z-index: 600;
  min-width: 196px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.popmenu--right {
  left: auto;
  right: 8px;
}
/*
 * 向上弹出（1.1.8）：仓库选择器已移到页脚，菜单若仍向下弹会被窗口下边缘裁掉，
 * 因此这里翻转到锚点上方。
 */
.popmenu--up {
  top: auto;
  bottom: calc(100% + 4px);
  left: 0;
}
.popmenu__title {
  padding: 4px 8px 6px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.popmenu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg);
  text-align: left;
}
.popmenu__item:hover {
  background: var(--bg-hover);
}
.popmenu__item.is-active {
  color: var(--accent);
  font-weight: 600;
}
.popmenu__item--accent {
  color: var(--accent);
  justify-content: flex-start;
}
.popmenu__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
/*
 * 旧的独立搜索输入块样式已废弃（1.1.8 合并到顶部 `.leftsearch`）。
 * 保留一段注释而不是直接删掉，是为了让后来者知道这里曾有一块 UI、不要误以为漏了样式。
 */
.leftpanel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 14px;
}
/* 大纲 / 文件列表的上下分区容器 */
.leftpanel__panes {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-bottom: 14px;
}
/* 单个区块：各自滚动，互不影响 */
.leftpanel__pane {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
/*
 * 双区模式下大纲区高度由拖拽决定（内联 height），
 * 必须 flex: 0 0 auto，否则会被 flex 收缩掉、拖动手感失效。
 */
.leftpanel__pane--fixed {
  flex: 0 0 auto;
  min-height: 60px;
}
.leftpanel__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.group-label {
  padding: 9px 12px 4px;
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
  padding: 5px 10px;
  font-size: 13px;
  color: var(--fg-2);
  text-align: left;
  line-height: 1.5;
  border-radius: 6px;
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
.file-row.is-dragover {
  outline: 1.5px dashed var(--accent);
  background: var(--accent-weak-2);
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
  cursor: grab;
}
.search-hit {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 7px 12px;
  text-align: left;
  border-radius: 6px;
}
.search-hit:hover {
  background: var(--bg-hover);
}
.search-hit.is-active {
  background: var(--bg-active);
}
.search-hit__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
}
.search-hit__snippet {
  margin: 0;
  font-size: 11.5px;
  color: var(--fg-3);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.outline-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
}
.outline-row:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.outline-row.lv1 {
  font-weight: 650;
  color: var(--fg);
}
.outline-row__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fg-3);
  flex: 0 0 auto;
}
.outline-row.lv1 .outline-row__dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
}
.outline-row__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-hint {
  margin: 8px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.docmenu {
  position: fixed;
  z-index: 9200;
  min-width: 185px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.docmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.docmenu__item:hover {
  background: var(--bg-hover);
}
.docmenu__item.is-danger {
  color: #d93025;
}
.docmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
</style>
