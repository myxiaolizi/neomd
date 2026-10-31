<script setup lang="ts">
/**
 * 内置插件面板（1.4.0 全量接线）。
 *
 * ## 1.3.1 的状态
 *
 * 本组件当时是**死代码**：全仓没有任何文件 `import` 它（`git grep PluginPanel`
 * 零命中）。后果是 26 款内置插件里，凡只声明 `panel: true` 的（出链 / 发布 /
 * 脚注 / 数据库 / 字数统计……）在宿主里**根本没有渲染路径** —— 插件中心能开能关，
 * 但用户看不到任何东西，主观感受就是「插件装了用不了」。
 *
 * ## 1.4.0 的定位
 *
 * 成为内置插件面板的**唯一渲染点**，由 `EditorPage` 以浮动面板承载：
 * - 面板清单来自 `BUILTIN_PLUGIN_CAPABILITY`（`@neomd/shared`），
 *   不再在这里维护第二份 `PANEL_META`，避免「清单有、面板没有」再次发生；
 * - 补齐此前缺失的 5 个面板：出链 / 发布 / 脚注视图 / 数据库 / 字数统计；
 * - 另补：页面预览 / 文件列表（跳转左侧栏）。
 *
 * 所有数据装配都调用 `@neomd/shared` 里**可单测的纯函数**
 * （`computeWordStats` / `extractFootnotes` / `aggregateProperties` /
 * `extractOutgoingLinks` / `buildLinkPreviews`），因此面板展示的内容与
 * `tools/re14-builtin-plugins.mjs` 验证的是同一份逻辑。
 *
 * 呈现方式刻意选择「独立浮动面板」而不是塞进右侧栏：右侧栏的区块枚举
 * （`RightPanelSection`）与堆叠/拖拽逻辑属另一个并行任务的文件，
 * 不在本任务写入范围内；浮动面板零耦合，也没有改动 1.3.1 已验证的布局代码。
 */
import { computed, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import { parseDoc } from '@neomd/core';
import type { DocMeta } from '@neomd/shared';
import {
  BUILTIN_PLUGIN_CAPABILITY,
  aggregateProperties,
  buildLinkPreviews,
  computeWordStats,
  extractFootnotes,
  extractOutgoingLinks,
  getBuiltinCapability,
  parseBookmarks,
  BOOKMARKS_STORE_KEY,
} from '@neomd/shared';
import { useAppStore } from '@/stores/app';
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
const emit = defineEmits<{
  'update:panel': [string];
  close: [];
  'open-doc': [string];
  publish: [];
  'open-left-panel': [mode: 'files' | 'outline' | 'both' | 'search'];
}>();

const app = useAppStore();

/** 千分位格式化（模板使用） */
function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN');
}

/* ------------------------- 面板清单（单一事实源） ------------------------- */

interface PanelOption {
  panel: string;
  title: string;
  icon: string;
  pluginId: string;
}

/**
 * 可渲染的面板列表。
 *
 * 直接由 `BUILTIN_PLUGIN_CAPABILITY` 派生：只有**声明了 panel 且状态不是
 * unavailable** 的插件才会出现在选择器里。新增插件时只要在能力表里写好
 * `panel`，这里自动出现，不会漏。
 */
const PANEL_OPTIONS = computed<PanelOption[]>(() =>
  BUILTIN_PLUGIN_CAPABILITY.filter((c) => Boolean(c.panel) && c.status !== 'unavailable').map((c) => ({
    panel: c.panel as string,
    title: c.panelTitle ?? (c.panel as string),
    icon: c.panelIcon ?? 'layers',
    pluginId: c.id,
  })),
);

/** 当前面板配置 */
const meta = computed<PanelOption>(
  () =>
    PANEL_OPTIONS.value.find((p) => p.panel === props.panel) ?? {
      panel: props.panel,
      title: getBuiltinCapability(props.panel)?.panelTitle ?? props.panel,
      icon: getBuiltinCapability(props.panel)?.panelIcon ?? 'layers',
      pluginId: props.panel,
    },
);

/** 当前插件在此版本的限制说明（部分可用时明说，不隐藏） */
const limitation = computed(() => {
  const cap = BUILTIN_PLUGIN_CAPABILITY.find((c) => c.panel === props.panel);
  return cap?.limitation ?? '';
});

const activeDoc = computed(() => (props.docId ? app.vault?.get(props.docId) : undefined));
const content = computed(() => app.activeTab?.content ?? '');
const parsed = computed(() => parseDoc(content.value));

/* ------------------------------ 数据装配 ------------------------------ */

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
  if (!map.size) {
    for (const d of docs) {
      const guess = d.path.includes('/') ? (d.path.split('/')[0] ?? '未分类') : '未分类';
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
    out.push({ docId: d.docId, title: d.title, kind: 'wikilink' });
  }
  const hits = app.search(title, { limit: 40 });
  const ids = new Set(hits.map((h) => h.docId));
  return out.filter((o) => o.docId && ids.has(o.docId)).slice(0, 20);
});

/** 出链：用共享纯函数解析（与验证脚本同源） */
const outgoingLinks = computed(() =>
  extractOutgoingLinks(content.value)
    .map((l) => {
      if (l.kind === 'markdown') {
        return { docId: null, title: l.alias || l.target, kind: 'markdown' as const };
      }
      const hit = app.vault?.findByName(l.target);
      return {
        docId: hit?.docId ?? null,
        title: l.alias || l.target,
        kind: (l.kind === 'embed' ? 'embed' : 'wikilink') as 'wikilink' | 'embed',
      };
    })
    .slice(0, 60),
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

/** 全库文档内容缓存（属性 / 数据库 / 页面预览面板按需加载） */
const docContents = ref<Array<{ title: string; content: string }>>([]);
const contentsLoading = ref(false);

async function loadDocContents(): Promise<void> {
  if (!app.vault || contentsLoading.value) return;
  contentsLoading.value = true;
  try {
    const docs = app.docs.slice(0, 300);
    const loaded: Array<{ title: string; content: string }> = [];
    for (const d of docs) {
      const text = d.docId === props.docId ? content.value : await app.vault.read(d.docId).catch(() => '');
      loaded.push({ title: d.title, content: text ?? '' });
    }
    docContents.value = loaded;
  } finally {
    contentsLoading.value = false;
  }
}

/** 属性表：共享纯函数聚合（当前文档优先，其余异步补齐） */
const properties = computed(() => {
  const source = docContents.value.length
    ? docContents.value
    : [{ title: activeDoc.value?.title ?? '', content: content.value }];
  return aggregateProperties(source);
});

/** 数据库视图：与属性同源，按取值丰富度排序 */
const databaseColumns = computed(() =>
  [...properties.value].sort((a, b) => b.values.length - a.values.length).slice(0, 12),
);
const databaseRows = computed(() =>
  docContents.value.slice(0, 200).map((d) => {
    const fm = aggregateProperties([d]);
    const row: Record<string, string> = { __title: d.title };
    for (const p of fm) row[p.key] = p.values.join('、');
    return row;
  }),
);

/** 字数统计：共享纯函数 */
const wordStats = computed(() => computeWordStats(content.value));

/** 脚注：共享纯函数 */
const footnotes = computed(() => extractFootnotes(content.value));

/** 页面预览：共享纯函数 + 仓库解析 */
const linkPreviews = computed(() =>
  buildLinkPreviews(content.value, (target) => {
    const hit = app.vault?.findByName(target);
    if (!hit) return null;
    const doc = docContents.value.find((d) => d.title === hit.title);
    return { title: hit.title, content: doc?.content ?? '' };
  }),
);

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 书签：读本地存储（真实数据，不再是写死的空数组） */
const bookmarks = ref(parseBookmarks(safeRead(BOOKMARKS_STORE_KEY)));

/**
 * 适配 `BookmarksPlugin.vue` 的展示形状。
 *
 * 共享注册表里的书签只有 `{id, docId, title, addedAt}`（跨端存储用的最小集），
 * 而视图组件要 `groupName` / `createdAt` 才能分组与显示相对时间 —— 在这里做一次
 * 适配，而不是把视图的字段强加给存储层（存储层要能被 Node 脚本复用）。
 */
const bookmarkGroups = computed(() =>
  bookmarks.value.map((b) => ({
    id: b.id,
    docId: b.docId || null,
    title: b.title,
    groupName: '已收藏',
    createdAt: b.addedAt,
  })),
);

/** 当前文档是否已收藏 */
const currentBookmarked = computed(() => bookmarks.value.some((b) => b.docId === props.docId));

function removeBookmark(id: string): void {
  const next = bookmarks.value.filter((b) => b.id !== id);
  bookmarks.value = next;
  try {
    localStorage.setItem(BOOKMARKS_STORE_KEY, JSON.stringify(next));
  } catch {
    /* 配额错误忽略 */
  }
  app.notify('已移除书签', 'success', 1500);
}

const dailyItems = computed(() =>
  app.docs
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d.title))
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

/* --------------------------- 快照（文件恢复面板） --------------------------- */

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

/* ------------------------------ 白板 / 幻灯片 ------------------------------ */

const boardContent = ref('');

async function loadBoard(): Promise<void> {
  if (props.panel !== 'whiteboard' || !app.vault || !props.docId) return;
  boardContent.value = await app.vault.read(props.docId).catch(() => '');
}

/** 需要全库正文的面板 */
function needsDocContents(panel: string): boolean {
  return panel === 'properties' || panel === 'database' || panel === 'page-preview';
}

watch(
  () => props.docId,
  async () => {
    if (props.panel === 'recovery') await loadSnapshots();
    await loadBoard();
  },
  { immediate: true },
);

watch(
  () => props.panel,
  async (p) => {
    if (p === 'recovery') await loadSnapshots();
    await loadBoard();
    if (needsDocContents(p)) void loadDocContents();
  },
);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    if (props.panel === 'recovery') void loadSnapshots();
    if (needsDocContents(props.panel)) void loadDocContents();
  },
);

function saveBoard(v: string): void {
  boardContent.value = v;
  const tab = app.activeTab;
  if (tab) app.updateTabContent(tab.id, v);
}

/* ------------------------------ 大纲跳转 ------------------------------ */

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

/** 切换到某个面板（选择器变化） */
function onPick(e: Event): void {
  emit('update:panel', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <!-- 1.4.0：独立浮动面板（不占用右侧栏 / 不改 RightPanelSection 联合类型） -->
  <div v-if="visible" class="plugin-panel" :data-plugin-panel="panel">
    <header class="plugin-panel__head">
      <NmIcon :name="meta.icon" :size="15" />
      <span class="plugin-panel__title">{{ meta.title }}</span>
      <select class="plugin-panel__picker" :value="panel" title="切换插件面板" @change="onPick">
        <option v-for="p in PANEL_OPTIONS" :key="p.panel" :value="p.panel">{{ p.title }}</option>
      </select>
      <button class="plugin-panel__close" title="关闭插件面板" @click="emit('close')">
        <NmIcon name="close" :size="13" />
      </button>
    </header>

    <!-- 部分可用的插件：把限制**明说**，而不是让用户自己撞墙 -->
    <p v-if="limitation" class="plugin-panel__limit">
      <NmIcon name="info" :size="12" />
      <span>{{ limitation }}</span>
    </p>

    <div class="plugin-panel__body nm-scroll">
      <OutlinePlugin
        v-if="panel === 'outline'"
        :content="content"
        :title="activeDoc?.title ?? ''"
        @jump="jumpToHeading"
      />

      <TagsPlugin v-else-if="panel === 'tag-list'" :groups="tagGroups" @open="(id: string) => emit('open-doc', id)" />

      <LinksPlugin
        v-else-if="panel === 'backlinks'"
        :incoming="incomingLinks"
        :outgoing="outgoingLinks"
        :unlinked="unlinked"
        @open="(id: string) => emit('open-doc', id)"
      />

      <!-- 1.4.0 新增：出链面板（manifest 早就声明了 panel，但此前没有渲染分支） -->
      <div v-else-if="panel === 'outgoing-links'" class="pp-list" data-pp="outgoing-links">
        <p v-if="!outgoingLinks.length" class="pp-empty">当前文档没有出链（`[[目标]]` 或 Markdown 链接）。</p>
        <ul v-else>
          <li v-for="(l, i) in outgoingLinks" :key="`${l.title}-${i}`">
            <button class="pp-row" :class="{ 'is-muted': !l.docId }" @click="l.docId && emit('open-doc', l.docId)">
              <NmIcon :name="l.kind === 'markdown' ? 'external' : 'link'" :size="12" />
              <span>{{ l.title }}</span>
              <em v-if="!l.docId">未找到目标</em>
            </button>
          </li>
        </ul>
      </div>

      <PropertiesPlugin
        v-else-if="panel === 'properties'"
        :properties="properties"
        @open="(id: string) => emit('open-doc', id)"
      />

      <!-- 1.4.0 新增：数据库视图（frontmatter 聚合表） -->
      <div v-else-if="panel === 'database'" class="pp-table" data-pp="database">
        <p v-if="contentsLoading" class="pp-empty">正在读取仓库 frontmatter…</p>
        <p v-else-if="!databaseColumns.length" class="pp-empty">
          仓库里还没有 frontmatter 属性。给笔记加上属性头后，这里会自动聚合成表格。
        </p>
        <div v-else class="pp-table__wrap nm-scroll">
          <table>
            <thead>
              <tr>
                <th>文档</th>
                <th v-for="c in databaseColumns" :key="c.key">{{ c.key }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in databaseRows" :key="row.__title">
                <td class="pp-table__title">{{ row.__title }}</td>
                <td v-for="c in databaseColumns" :key="c.key">{{ row[c.key] ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <BookmarksPlugin
        v-else-if="panel === 'bookmarks'"
        :items="bookmarkGroups"
        @open="(id: string) => emit('open-doc', id)"
        @remove="removeBookmark"
      />

      <DailyPlugin
        v-else-if="panel === 'daily'"
        :items="dailyItems"
        :today="today"
        @open="(id: string) => emit('open-doc', id)"
        @create="(date: string) => app.createDoc({ title: date, folder: '日记', content: `# ${date}\n\n` })"
      />

      <GraphPlugin
        v-else-if="panel === 'graph'"
        :nodes="graphData.nodes"
        :edges="graphData.edges"
        :active-id="docId"
        @open="(id: string) => emit('open-doc', id)"
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

      <!-- 1.4.0 新增：字数统计 -->
      <div v-else-if="panel === 'word-count'" class="pp-stats" data-pp="word-count">
        <div class="pp-stat"><span>{{ formatNumber(wordStats.chars) }}</span><em>字符（含空白）</em></div>
        <div class="pp-stat"><span>{{ formatNumber(wordStats.charsNoSpace) }}</span><em>字符（不含空白）</em></div>
        <div class="pp-stat"><span>{{ formatNumber(wordStats.words) }}</span><em>词数（中文按字）</em></div>
        <div class="pp-stat"><span>{{ formatNumber(wordStats.cjk) }}</span><em>中日韩字符</em></div>
        <div class="pp-stat"><span>{{ formatNumber(wordStats.lines) }}</span><em>行数</em></div>
        <div class="pp-stat"><span>{{ formatNumber(wordStats.textLines) }}</span><em>非空行</em></div>
        <div class="pp-stat"><span>{{ wordStats.readingMinutes }}</span><em>预计阅读（分钟）</em></div>
      </div>

      <!-- 1.4.0 新增：脚注视图 -->
      <div v-else-if="panel === 'footnote-view'" class="pp-list" data-pp="footnote-view">
        <p v-if="!footnotes.length" class="pp-empty">当前文档没有脚注。用 `[^1]` 引用、`[^1]: 内容` 定义。</p>
        <ul v-else>
          <li v-for="f in footnotes" :key="f.label">
            <div class="pp-foot">
              <span class="pp-foot__label">[^{{ f.label }}]</span>
              <span class="pp-foot__text" :class="{ 'is-warn': !f.text }">
                {{ f.text || '（只有引用，没有定义 —— 悬空脚注）' }}
              </span>
              <em class="pp-foot__ref">{{ f.refCount }} 次引用</em>
            </div>
          </li>
        </ul>
      </div>

      <!-- 1.4.0 新增：页面预览（面板形态；行内悬停浮层未接入，已在限制里说明） -->
      <div v-else-if="panel === 'page-preview'" class="pp-list" data-pp="page-preview">
        <p v-if="!linkPreviews.length" class="pp-empty">当前文档没有 Wikilink，没有可预览的目标。</p>
        <ul v-else>
          <li v-for="p in linkPreviews" :key="p.target">
            <div class="pp-preview">
              <strong :class="{ 'is-muted': !p.exists }">{{ p.title }}</strong>
              <p>{{ p.excerpt || (p.exists ? '（目标文档没有正文段落）' : '目标笔记不存在') }}</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- 1.4.0 新增：发布面板（复用 EditorPage 的分享弹窗，不重复实现） -->
      <div v-else-if="panel === 'publish'" class="pp-list" data-pp="publish">
        <p class="pp-note">把当前文档发布为可分享的静态页面。</p>
        <button class="nm-btn nm-btn--primary nm-btn--sm" @click="emit('publish')">打开发布 / 分享面板</button>
        <p class="pp-note">当前文档：{{ activeDoc?.title ?? '（未打开）' }}</p>
      </div>

      <!-- 1.4.0 新增：文件列表（本质是左侧栏，给一个直达入口而不是假面板） -->
      <div v-else-if="panel === 'file-list'" class="pp-list" data-pp="file-list">
        <p class="pp-note">文件树在左侧栏展示，这里提供直达入口。</p>
        <button class="nm-btn nm-btn--sm" @click="emit('open-left-panel', 'files')">在左侧栏打开文件列表</button>
        <button class="nm-btn nm-btn--sm" @click="emit('open-left-panel', 'both')">文件列表 + 大纲</button>
      </div>

      <div v-else class="plugin-panel__placeholder">
        <p>该插件面板在当前版本不可用。</p>
      </div>
    </div>

    <!-- 书签状态条：让「当前文档是否已收藏」一眼可见 -->
    <footer v-if="panel === 'bookmarks'" class="plugin-panel__foot">
      <span>{{ currentBookmarked ? '当前文档已收藏' : '当前文档未收藏' }}</span>
    </footer>
  </div>
</template>

<style scoped>
.plugin-panel {
  position: fixed;
  right: 16px;
  top: 92px;
  bottom: 24px;
  width: 340px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-elevated, var(--bg-sidebar));
  box-shadow: 0 12px 40px rgb(0 0 0 / 22%);
  overflow: hidden;
}
.plugin-panel__head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 8px 9px 12px;
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
  max-width: 118px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--fg-2);
  font-size: 11px;
  padding: 0 4px;
  outline: none;
}
.plugin-panel__close {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-3);
  cursor: pointer;
}
.plugin-panel__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.plugin-panel__limit {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  padding: 8px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg-3);
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
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
.plugin-panel__foot {
  flex: 0 0 auto;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--fg-3);
}

/* ---- 新面板的通用样式（全部 scoped，不影响 1.3.1 的正文样式） ---- */
.pp-list {
  padding: 8px 10px 16px;
  font-size: 12px;
}
.pp-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pp-empty {
  margin: 8px 2px;
  color: var(--fg-3);
  font-size: 11.5px;
  line-height: 1.7;
}
.pp-note {
  margin: 6px 2px;
  color: var(--fg-3);
  font-size: 11.5px;
  line-height: 1.7;
}
.pp-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pp-row:hover {
  background: var(--bg-hover);
}
.pp-row em {
  margin-left: auto;
  font-style: normal;
  font-size: 10.5px;
  color: var(--fg-3);
}
.pp-row.is-muted {
  color: var(--fg-3);
  cursor: default;
}
.pp-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px;
}
.pp-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
}
.pp-stat span {
  font-size: 16px;
  font-weight: 650;
  color: var(--fg);
}
.pp-stat em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--fg-3);
}
.pp-foot {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 6px 2px;
  border-bottom: 1px dashed var(--border);
}
.pp-foot__label {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--fg-3);
}
.pp-foot__text {
  flex: 1 1 auto;
  color: var(--fg-2);
  line-height: 1.6;
}
.pp-foot__text.is-warn {
  color: #c2410c;
}
.pp-foot__ref {
  font-style: normal;
  font-size: 10.5px;
  color: var(--fg-3);
}
.pp-preview {
  padding: 7px 2px;
  border-bottom: 1px dashed var(--border);
}
.pp-preview strong {
  font-size: 12px;
  color: var(--fg);
}
.pp-preview strong.is-muted {
  color: var(--fg-3);
}
.pp-preview p {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--fg-3);
}
.pp-table {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px;
}
.pp-table__wrap {
  overflow: auto;
  min-height: 0;
}
.pp-table table {
  border-collapse: collapse;
  font-size: 11.5px;
  width: 100%;
}
.pp-table th,
.pp-table td {
  border: 1px solid var(--border);
  padding: 4px 7px;
  text-align: left;
  white-space: nowrap;
  color: var(--fg-2);
}
.pp-table th {
  background: var(--bg-sidebar);
  font-weight: 600;
  color: var(--fg);
}
.pp-table__title {
  font-weight: 600;
  color: var(--fg);
}
@media (max-width: 1100px) {
  .plugin-panel {
    width: 300px;
    right: 8px;
  }
}
</style>
