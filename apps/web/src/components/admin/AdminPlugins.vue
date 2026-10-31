<script setup lang="ts">
/**
 * 后台 · 插件市场（1.4.0 增加编辑功能 + 20/页分页）。
 *
 * ## 1.4.0 的两处改造动机
 *
 * 1. **编辑**：1.3.1 及以前，管理员对社区插件只能「上架 / 下架」。遇到插件描述有错字、
 *    分类放错、代码有 bug 时只能让作者自己改（作者失联则无解），或者干脆下架。
 *    现在管理员可以直接修正元数据与代码，保存后**客户端市场立即生效**（无缓存层）。
 *
 * 2. **分页**：原实现硬编码 `plugins(1, 60, ...)` 一次拉 60 条且没有任何翻页 UI ——
 *    插件数超过 60 之后，第 61 条以后的管理员**永远看不到也管不了**。
 *    改为每页 20 条 + 真实 total + 页码跳转。
 *
 * ## 代码编辑的安全设计（前端这一侧）
 *
 * 前端做**即时语法预检**（只构造不执行 `new Function`），给管理员一个「还没提交就发现」
 * 的反馈；但**真正的强制校验在服务端**（`validatePluginCode`）—— 前端校验只是体验优化，
 * 任何绕过前端直接打接口的路径都会被服务端拒绝。二者规则保持一致：
 * 同样的 `export default` → `return` 规范化、同样的危险标识符黑名单。
 *
 * 注意：这里只管**市场上架状态**，不涉及用户本地已安装的插件。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { adminApiV2, type CommunityPluginDto } from '@/api/client';
import { formatCompactNumber } from '@neomd/shared';
import {
  fetchAdminPlugin,
  fetchAdminPlugins,
  saveAdminPlugin,
  type AdminPluginChange,
  type AdminPluginPatch,
} from './admin-api';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

/* ---------------- 1.4.0：每页 20 条（需求硬性要求） ---------------- */

const PAGE_SIZE = 20;

const items = ref<CommunityPluginDto[]>([]);
const search = ref('');
const loading = ref(false);
const page = ref(1);
const total = ref(0);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/**
 * 页码同步到 URL query（`?pluginPage=2`）。
 *
 * 为什么要做：后台经常被分享成「我点进这个链接看第 3 页的插件」，
 * 而纯组件状态在刷新/转发后就丢了。用 query 让页码可分享、可刷新保持。
 * 仅在非默认页时写入，保持 URL 干净。
 */
function syncPageToUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (page.value > 1) url.searchParams.set('pluginPage', String(page.value));
    else url.searchParams.delete('pluginPage');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* 隐私模式或非浏览器环境：忽略，不影响功能 */
  }
}

/** 从 URL query 恢复页码（刷新不丢） */
function readPageFromUrl(): number {
  try {
    const raw = new URL(window.location.href).searchParams.get('pluginPage');
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * 翻页后回到顶部。
 *
 * 后台内容区是 `.adm-body` 这个独立滚动容器（不是 window），因此必须先找它。
 * 找不到时回退到 window，保证在任何布局下都能回到顶部。
 */
function scrollToTop(): void {
  const scroller = document.querySelector('.adm-body');
  if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminPlugins(page.value, PAGE_SIZE, search.value.trim());
    items.value = res.items;
    total.value = res.total;
    // 数据变少导致当前页超界时（例如删除了最后一页的唯一一条），自动退到最后一页
    if (items.value.length === 0 && page.value > 1 && total.value > 0) {
      page.value = totalPages.value;
      return load();
    }
    syncPageToUrl();
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function applyFilter(): Promise<void> {
  page.value = 1;
  await load();
}

async function gotoPage(p: number): Promise<void> {
  const next = Math.min(totalPages.value, Math.max(1, p));
  if (next === page.value) return;
  page.value = next;
  await load();
  scrollToTop();
}

async function setStatus(id: number, status: 'published' | 'pending' | 'rejected' | 'disabled'): Promise<void> {
  try {
    await adminApiV2.setPluginStatus(id, status);
    await load();
    emit('notify', '插件状态已更新');
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

function statusLabel(s: string): { text: string; variant: string } {
  switch (s) {
    case 'published':
      return { text: '已上架', variant: 'ok' };
    case 'pending':
      return { text: '待审核', variant: 'warn' };
    case 'rejected':
      return { text: '已驳回', variant: 'danger' };
    default:
      return { text: '已下架', variant: 'muted' };
  }
}

const CATEGORIES: Array<{ id: CommunityPluginDto['category']; label: string }> = [
  { id: 'core', label: '核心' },
  { id: 'navigation', label: '导航' },
  { id: 'writing', label: '写作' },
  { id: 'data', label: '数据' },
  { id: 'visual', label: '视觉' },
  { id: 'collab', label: '协作' },
];

/* ================================================================== */
/* 编辑弹窗                                                            */
/* ================================================================== */

const editOpen = ref(false);
const editLoading = ref(false);
const editSaving = ref(false);
const editing = ref<CommunityPluginDto | null>(null);
/** 服务端这份数据的原始快照，用于「未保存修改」判断与 diff 提示 */
const pristine = ref('');

const form = ref({
  name: '',
  version: '',
  category: 'writing' as CommunityPluginDto['category'],
  icon: '',
  description: '',
  tagsText: '',
  readmeMd: '',
  codeJs: '',
});

/** 前端即时校验的问题列表（空 = 可提交） */
const issues = computed<string[]>(() => {
  const out: string[] = [];
  if (!form.value.name.trim()) out.push('插件名称不能为空');
  if (form.value.name.length > 80) out.push('插件名称最多 80 个字符');
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(form.value.version.trim())) {
    out.push('版本号格式不正确（示例：1.2.0）');
  }
  if (form.value.description.trim().length < 2) out.push('插件简介至少 2 个字符');
  if (form.value.description.length > 500) out.push('插件简介最多 500 个字符');
  const tags = parseTags(form.value.tagsText);
  if (tags.length > 8) out.push('标签最多 8 个');
  if (tags.some((t) => t.length > 24)) out.push('单个标签最多 24 个字符');
  if (form.value.codeJs.trim().length < 10) out.push('插件代码至少 10 个字符');
  // 代码语法预检：与服务端同一个「规范化 + 只构造不执行」规则
  else {
    const codeIssue = precheckCode(form.value.codeJs);
    if (codeIssue) out.push(codeIssue);
  }
  return out;
});

const dirty = computed(() => JSON.stringify(form.value) !== pristine.value);

/** 标签输入：支持中英文逗号、顿号、分号分隔，去重保序 */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? '').split(/[,，、;；\n]/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 与服务端 `normalizePluginSource` 完全一致的规范化。
 *
 * 规则必须一致，否则会出现「前端预检通过、服务端拒绝」这种最令人困惑的分歧。
 * 逻辑：有 `export default` 就把（第一处）换成 `return`；没有则视为函数体原样提交。
 */
function normalizeSource(codeJs: string): string {
  const src = String(codeJs ?? '').replace(/^\uFEFF/, '');
  if (!/\bexport\s+default\b/.test(src)) return src;
  const cleaned = src.replace(/^\s*export\s+default\s+/m, 'return ');
  return cleaned.replace(/\bexport\s+default\s+/, 'return ');
}

/** 与服务端一致的危险标识符黑名单（拦误操作，不是沙箱） */
const DENY_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /\brequire\s*\(/, reason: '不允许使用 require()（插件在浏览器中运行，没有 CommonJS 环境）' },
  { re: /\bprocess\s*\.\s*(binding|dlopen|mainModule|exit)\b/, reason: '不允许访问 Node 进程内部对象' },
  { re: /\bchild_process\b/, reason: '不允许引用 child_process' },
  { re: /\bglobalThis\s*\.\s*process\s*\.\s*env\b/, reason: '不允许读取服务端环境变量' },
];

/** 语法预检：返回问题描述，无问题返回 null */
function precheckCode(codeJs: string): string | null {
  for (const rule of DENY_RULES) {
    if (rule.re.test(codeJs)) return `代码校验：${rule.reason}`;
  }
  try {
    // 只构造不执行：构造函数会完整解析函数体，语法错误在此抛出
    // eslint-disable-next-line no-new-func
    new Function(normalizeSource(codeJs));
    return null;
  } catch (e) {
    return `代码语法错误：${(e as Error).message}`;
  }
}

async function openEdit(pl: CommunityPluginDto): Promise<void> {
  editOpen.value = true;
  editLoading.value = true;
  editing.value = pl;
  try {
    // 以服务端最新值为准：列表可能是几分钟前拉的，期间作者可能已改过
    const { plugin } = await fetchAdminPlugin(pl.id);
    editing.value = plugin;
    form.value = {
      name: plugin.name,
      version: plugin.version,
      category: plugin.category,
      icon: plugin.icon,
      description: plugin.description,
      tagsText: (plugin as CommunityPluginDto & { tags?: string[] }).tags?.join('，') ?? '',
      readmeMd: plugin.readmeMd ?? '',
      codeJs: plugin.codeJs ?? '',
    };
    pristine.value = JSON.stringify(form.value);
  } catch (e) {
    emit('fail', (e as Error).message);
    editOpen.value = false;
  } finally {
    editLoading.value = false;
  }
}

function closeEdit(): void {
  if (editSaving.value) return;
  if (dirty.value && !window.confirm('有未保存的修改，确认放弃？')) return;
  editOpen.value = false;
}

/**
 * 弹窗被「X / Esc / 点遮罩」关闭后的收尾。
 *
 * NmModal 的 `close` 事件是在它**已经把自己关掉之后**才发出的，
 * 因此这条路径没法拦截「有未保存修改」。这里的处理是：
 * 关闭后清空编辑态并提示一次，让管理员知道改动没保存 ——
 * 想避免误关请用弹窗底部的「关闭」按钮（那个有确认）。
 */
function onModalClosed(): void {
  const hadUnsaved = dirty.value && !editSaving.value;
  editing.value = null;
  lastChangeSummary.value = [];
  savedAt.value = '';
  if (hadUnsaved) emit('notify', '已放弃未保存的插件修改');
}

/** 把表单整理成「只含有变化的字段」的 patch（未改的字段不提交，避免无意义写入） */
function buildPatch(): AdminPluginPatch {
  const patch: AdminPluginPatch = {};
  const p = editing.value;
  if (!p) return patch;
  const tags = parseTags(form.value.tagsText);
  const origTags = (p as CommunityPluginDto & { tags?: string[] }).tags ?? [];
  if (form.value.name.trim() !== p.name) patch.name = form.value.name.trim();
  if (form.value.version.trim() !== p.version) patch.version = form.value.version.trim();
  if (form.value.category !== p.category) patch.category = form.value.category;
  if (form.value.icon !== p.icon) patch.icon = form.value.icon;
  if (form.value.description.trim() !== p.description) patch.description = form.value.description.trim();
  if (form.value.readmeMd !== (p.readmeMd ?? '')) patch.readmeMd = form.value.readmeMd;
  if (form.value.codeJs !== (p.codeJs ?? '')) patch.codeJs = form.value.codeJs;
  if (JSON.stringify(tags) !== JSON.stringify(origTags)) patch.tags = tags;
  return patch;
}

/** 变更摘要（保存成功后展示，让管理员确认「到底改了什么」） */
const lastChangeSummary = ref<string[]>([]);
const savedAt = ref<string>('');

function describeChanges(changes: Record<string, AdminPluginChange>): string[] {
  const label: Record<string, string> = {
    name: '名称',
    version: '版本',
    category: '分类',
    icon: '图标',
    description: '描述',
    readmeMd: 'README',
    codeJs: '代码',
    tags: '标签',
    status: '状态',
  };
  const out: string[] = [];
  for (const [key, val] of Object.entries(changes)) {
    const name = label[key] ?? key;
    if ('lengthBefore' in val) {
      out.push(`${name}：${val.lengthBefore} → ${val.lengthAfter} 字符`);
    } else if (key === 'tags') {
      out.push(`${name}：${JSON.stringify(val.before)} → ${JSON.stringify(val.after)}`);
    } else {
      const before = String(val.before ?? '').slice(0, 24);
      const after = String(val.after ?? '').slice(0, 24);
      out.push(`${name}：「${before}」→「${after}」`);
    }
  }
  return out;
}

async function submitEdit(): Promise<void> {
  if (!editing.value || issues.value.length > 0) return;
  const patch = buildPatch();
  if (Object.keys(patch).length === 0) {
    emit('notify', '没有检测到修改，未提交');
    return;
  }
  editSaving.value = true;
  try {
    const res = await saveAdminPlugin(editing.value.id, patch);
    editing.value = res.plugin;
    form.value = {
      name: res.plugin.name,
      version: res.plugin.version,
      category: res.plugin.category,
      icon: res.plugin.icon,
      description: res.plugin.description,
      tagsText: (res.plugin as CommunityPluginDto & { tags?: string[] }).tags?.join('，') ?? '',
      readmeMd: res.plugin.readmeMd ?? '',
      codeJs: res.plugin.codeJs ?? '',
    };
    pristine.value = JSON.stringify(form.value);
    lastChangeSummary.value = describeChanges(res.changes ?? {});
    savedAt.value = new Date().toLocaleTimeString('zh-CN');
    await load();
    emit(
      'notify',
      `插件「${res.plugin.name}」已保存并生效（客户端市场立即可见）${lastChangeSummary.value.length ? `：${lastChangeSummary.value.join('；')}` : ''}`,
    );
    // 保存成功但保持弹窗打开，让管理员看到变更摘要；由用户主动关闭
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    editSaving.value = false;
  }
}

/* ---------------- 生命周期 ---------------- */

// 搜索框清空时自动回到第 1 页（避免停在第 3 页但结果只有 1 页的困惑）
watch(search, (v) => {
  if (!v.trim() && page.value !== 1) {
    page.value = 1;
    void load();
  }
});

onMounted(async () => {
  page.value = readPageFromUrl();
  await load();
});

defineExpose({ reload: load });
</script>

<template>
  <div class="plg">
    <header class="adm-page-head">
      <div>
        <h2>插件市场</h2>
        <p>
          管理社区开发者在插件开放平台发布的扩展插件：审核上下架，或直接编辑元数据与代码（保存后客户端市场立即生效）。
          这里只影响市场可见性，不影响用户本地已安装的插件。
        </p>
      </div>
    </header>

    <div class="adm-toolbar">
      <input
        v-model="search"
        class="nm-input adm-toolbar__search"
        placeholder="搜索插件名称、ID 或作者"
        @keyup.enter="applyFilter"
      />
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="applyFilter">搜索</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">
        共 {{ total }} 款 · 第 {{ page }} / {{ totalPages }} 页
      </span>
    </div>

    <table class="adm-table">
      <thead>
        <tr>
          <th>插件名称</th>
          <th style="width: 170px;">标识 (ID)</th>
          <th style="width: 120px;">作者</th>
          <th style="width: 80px;">版本</th>
          <th style="width: 90px;">分类</th>
          <th class="adm-right" style="width: 130px;">安装 / 获赞</th>
          <th style="width: 96px;">状态</th>
          <th class="adm-right" style="width: 170px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pl in items" :key="pl.id">
          <td class="adm-strong">
            {{ pl.name }}
            <span
              v-for="t in (pl as CommunityPluginDto & { tags?: string[] }).tags ?? []"
              :key="t"
              class="plg__tag"
            >{{ t }}</span>
          </td>
          <td class="adm-mono adm-muted">{{ pl.pluginId }}</td>
          <td class="adm-muted">{{ pl.authorName }}</td>
          <td class="adm-mono">v{{ pl.version }}</td>
          <td class="adm-muted">{{ CATEGORIES.find((c) => c.id === pl.category)?.label ?? pl.category }}</td>
          <td class="adm-right adm-muted">
            {{ formatCompactNumber(pl.downloads) }} / ★ {{ formatCompactNumber(pl.stars) }}
          </td>
          <td>
            <span class="adm-badge" :class="`adm-badge--${statusLabel(pl.status).variant}`">
              {{ statusLabel(pl.status).text }}
            </span>
          </td>
          <td class="adm-right">
            <button class="adm-rowbtn" data-testid="plugin-edit" @click="openEdit(pl)">编辑</button>
            <button
              v-if="pl.status !== 'published'"
              class="adm-rowbtn"
              @click="setStatus(pl.id, 'published')"
            >上架</button>
            <button
              v-else
              class="adm-rowbtn adm-rowbtn--danger"
              @click="setStatus(pl.id, 'disabled')"
            >下架</button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="8" class="adm-empty">{{ loading ? '加载中…' : '暂无社区插件' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 1.4.0：20/页分页（上一页 / 页码 / 下一页 + 总数） -->
    <div v-if="totalPages > 1" class="adm-pager" data-testid="plugin-pager">
      <button class="nm-btn nm-btn--sm" :disabled="page <= 1 || loading" @click="gotoPage(page - 1)">
        <NmIcon name="chevronLeft" :size="12" />上一页
      </button>
      <select
        class="nm-input adm-toolbar__sel adm-pager__sel"
        :value="page"
        :disabled="loading"
        @change="gotoPage(Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="p in totalPages" :key="p" :value="p">第 {{ p }} 页</option>
      </select>
      <button class="nm-btn nm-btn--sm" :disabled="page >= totalPages || loading" @click="gotoPage(page + 1)">
        下一页<NmIcon name="chevronRight" :size="12" />
      </button>
      <span class="adm-muted plg__pagerinfo">
        每页 {{ PAGE_SIZE }} 条 · 共 {{ total }} 条 · 本页 {{ items.length }} 条
      </span>
    </div>

    <!-- ======================== 编辑弹窗 ======================== -->
    <NmModal v-model="editOpen" title="编辑插件" :width="920" @close="onModalClosed">
      <div v-if="editLoading" class="plg__editload">正在读取插件最新内容…</div>
      <div v-else-if="editing" class="plg__edit">
        <p class="adm-note">
          <strong>{{ editing.pluginId }}</strong> · 作者 {{ editing.authorName }} ·
          当前状态 {{ statusLabel(editing.status).text }} · 更新于 {{ editing.updatedAt || '—' }}
        </p>

        <div class="plg__grid">
          <label class="adm-field">
            <span class="nm-label">插件名称</span>
            <input v-model="form.name" class="nm-input" data-testid="edit-name" maxlength="80" />
          </label>
          <label class="adm-field">
            <span class="nm-label">版本号</span>
            <input v-model="form.version" class="nm-input" data-testid="edit-version" maxlength="32" placeholder="1.2.0" />
          </label>
          <label class="adm-field">
            <span class="nm-label">分类</span>
            <select v-model="form.category" class="nm-input" data-testid="edit-category">
              <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}（{{ c.id }}）</option>
            </select>
          </label>
          <label class="adm-field">
            <span class="nm-label">图标</span>
            <input v-model="form.icon" class="nm-input" maxlength="255" />
          </label>
        </div>

        <label class="adm-field">
          <span class="nm-label">标签（逗号分隔，最多 8 个）</span>
          <input v-model="form.tagsText" class="nm-input" data-testid="edit-tags" placeholder="写作，效率，导出" />
        </label>

        <label class="adm-field">
          <span class="nm-label">插件简介（{{ form.description.length }} / 500）</span>
          <textarea
            v-model="form.description"
            class="nm-input plg__ta"
            rows="2"
            maxlength="500"
            data-testid="edit-description"
          />
        </label>

        <label class="adm-field">
          <span class="nm-label">README（Markdown）</span>
          <textarea v-model="form.readmeMd" class="nm-input plg__ta plg__ta--md" rows="5" data-testid="edit-readme" />
        </label>

        <label class="adm-field">
          <span class="nm-label">
            插件代码（JavaScript）
            <span class="adm-muted">· {{ form.codeJs.length }} 字符 · 保存前会做语法校验</span>
          </span>
          <textarea
            v-model="form.codeJs"
            class="nm-input plg__ta plg__code"
            rows="12"
            spellcheck="false"
            data-testid="edit-code"
          />
        </label>

        <!-- 校验结果：有问题就列出来并禁用保存 -->
        <div v-if="issues.length" class="adm-note adm-note--warn" data-testid="edit-issues">
          <strong>无法保存，请先修正：</strong>
          <ul class="plg__issues">
            <li v-for="(it, i) in issues" :key="i">{{ it }}</li>
          </ul>
        </div>
        <div v-else class="adm-note" data-testid="edit-ok">
          校验通过 · 保存后客户端市场立即可见
        </div>

        <!-- 保存成功反馈：变更摘要 -->
        <div v-if="lastChangeSummary.length" class="adm-note plg__saved" data-testid="edit-saved">
          <strong>已保存生效（{{ savedAt }}）：</strong>
          <ul class="plg__issues">
            <li v-for="(c, i) in lastChangeSummary" :key="i">{{ c }}</li>
          </ul>
        </div>
      </div>

      <template #footer>
        <span v-if="dirty" class="adm-muted plg__dirty">有未保存的修改</span>
        <button class="nm-btn" :disabled="editSaving" @click="closeEdit">关闭</button>
        <button
          class="nm-btn nm-btn--primary"
          :disabled="editSaving || editLoading || issues.length > 0 || !dirty"
          data-testid="edit-save"
          @click="submitEdit"
        >
          {{ editSaving ? '保存中…' : '保存' }}
        </button>
      </template>
    </NmModal>
  </div>
</template>

<style scoped>
.plg__tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 8px;
  background: #eef2f7;
  color: #5b6472;
  font-size: 10.5px;
  font-weight: 500;
  vertical-align: middle;
}
.plg__pagerinfo { margin-left: 6px; font-size: 12px; }
.adm-pager__sel { width: 118px; max-width: 118px; }

.plg__edit { display: flex; flex-direction: column; gap: 14px; }
.plg__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.plg__ta { resize: vertical; font-family: inherit; line-height: 1.6; }
.plg__ta--md { font-family: var(--font-mono, ui-monospace, Consolas, monospace); font-size: 12px; }
.plg__code {
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 12px;
  line-height: 1.55;
  tab-size: 2;
  background: #fbfcfd;
}
.plg__issues { margin: 6px 0 0; padding-left: 18px; }
.plg__issues li { margin: 2px 0; font-size: 12.5px; }
.plg__saved { background: rgba(14, 159, 110, 0.08); border-color: rgba(14, 159, 110, 0.25); }
.plg__dirty { margin-right: auto; font-size: 12px; }
.plg__editload { padding: 26px 0; text-align: center; color: #6b7280; font-size: 13px; }

@media (max-width: 800px) {
  .plg__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
