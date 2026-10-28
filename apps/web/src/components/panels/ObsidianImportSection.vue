<script setup lang="ts">
/**
 * Obsidian 仓库导入面板。
 *
 * 挂在「设置 → 导入」页签。流程分五步，每一步都把「正在做什么」明确告诉用户：
 *   1) 选择 Obsidian 仓库目录（桌面端原生对话框 / 网页端目录选择器兜底）
 *   2) 扫描：递归读取 .md 文件并保留**真实修改时间**
 *   3) 选项：语法转换开关、目标文件夹、冲突策略
 *   4) 导入：进度条 + 实时当前文件
 *   5) 报告：汇总数字 + 可搜索的逐文件表格（含每个文件的修改日期）
 */
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { formatDate, type ObsidianImportOptions, type ObsidianImportReport } from '@neomd/shared';
import {
  convertObsidianMarkdown,
  detectObsidianSyntax,
  getBridge,
  importObsidianVault,
  readObsidianVaultFromDir,
  readObsidianVaultFromFileList,
  shouldSkipPath,
  type ImportProgress,
  type ObsidianSourceFile,
} from '@neomd/core';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';

defineProps<{ compact?: boolean }>();

const app = useAppStore();
const settingsStore = useSettingsStore();

const bridge = getBridge();
const canPickDirectory = computed(() => Boolean(bridge?.dialog?.pickDirectory));

type Phase = 'idle' | 'scanning' | 'ready' | 'importing' | 'done';
const phase = ref<Phase>('idle');

/** 源仓库路径（桌面端显示真实目录；网页端显示所选文件夹名） */
const sourceDir = ref('');
/** 扫描到的源文件 */
const sourceFiles = ref<ObsidianSourceFile[]>([]);
/** 扫描/导入进度 */
const progress = ref<ImportProgress>({ done: 0, total: 0, currentPath: '' });
/** 错误提示 */
const errorText = ref('');
/** 导入报告 */
const report = ref<ObsidianImportReport | null>(null);

/** 导入选项：默认值即推荐值 */
const opts = ref<ObsidianImportOptions>({
  targetFolder: '',
  keepTimestamps: true,
  convertSyntax: true,
  convertEmbeds: true,
  convertComments: true,
  convertCallouts: true,
  convertHighlights: true,
  normalizeTasks: true,
  normalizeHardBreaks: true,
  skipConfigDirs: true,
  onConflict: 'rename',
});

/** 扫描时被跳过的文件统计（给用户一个「为什么少了文件」的解释） */
const skippedDuringScan = ref(0);

const markdownCount = computed(
  () => sourceFiles.value.filter((f) => /\.(md|markdown)$/i.test(f.relPath)).length,
);

const nonMarkdownCount = computed(() => sourceFiles.value.length - markdownCount.value);

/** 语法预检：抽样检测有多少文件需要转换，给用户心理预期 */
const syntaxPreview = computed(() => {
  const counter = new Map<string, number>();
  let hitFiles = 0;
  const sample = sourceFiles.value.filter((f) => /\.(md|markdown)$/i.test(f.relPath));
  for (const f of sample) {
    const hits = detectObsidianSyntax(f.content);
    if (hits.length) hitFiles += 1;
    for (const h of hits) counter.set(h, (counter.get(h) ?? 0) + 1);
  }
  const labelMap: Record<string, string> = {
    'hard-break': '硬换行',
    callout: 'Callout 标注块',
    comment: '%% 注释',
    highlight: '== 高亮',
    embed: '![[ ]] 嵌入',
    'embed-image': '图片嵌入',
    'embed-note': '笔记嵌入',
    'block-ref': '块引用',
    'block-id': '块 ID',
    'task-in-progress': '进行中任务',
    dataview: 'Dataview 查询',
    wikilink: 'Wikilink',
  };
  return {
    hitFiles,
    total: sample.length,
    items: [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, label: labelMap[key] ?? key, count })),
  };
});

const progressPercent = computed(() =>
  progress.value.total ? Math.round((progress.value.done / progress.value.total) * 100) : 0,
);

/* ------------------------------ 步骤 1+2：选择与扫描 ------------------------------ */

function resetAll(): void {
  phase.value = 'idle';
  sourceDir.value = '';
  sourceFiles.value = [];
  report.value = null;
  errorText.value = '';
  skippedDuringScan.value = 0;
  progress.value = { done: 0, total: 0, currentPath: '' };
}

/** 扫描进度回调：扫描阶段 done 可能为 0，用 total 表示已发现文件数 */
function onScanProgress(p: ImportProgress): void {
  progress.value = p;
}

async function pickAndScan(): Promise<void> {
  errorText.value = '';
  const currentBridge = bridge;
  if (!currentBridge?.dialog?.pickDirectory) {
    errorText.value = '当前环境不支持原生目录选择，请使用下方「选择文件夹」按钮。';
    return;
  }
  try {
    const dir = await currentBridge.dialog.pickDirectory();
    if (!dir) return; // 用户取消
    sourceDir.value = dir;
    phase.value = 'scanning';
    progress.value = { done: 0, total: 0, currentPath: '' };
    const files = await readObsidianVaultFromDir(currentBridge, dir, onScanProgress);
    sourceFiles.value = files;
    skippedDuringScan.value = 0;
    phase.value = 'ready';
  } catch (e) {
    phase.value = 'idle';
    errorText.value = `扫描失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 网页端兜底：<input webkitdirectory> 选整个文件夹 */
async function onWebFolderPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const list = input.files;
  if (!list || !list.length) return;
  errorText.value = '';
  try {
    phase.value = 'scanning';
    progress.value = { done: 0, total: list.length, currentPath: '' };
    // 取第一个文件的 webkitRelativePath 首段作为「仓库名」展示
    const first = list[0] as File & { webkitRelativePath?: string };
    const rootName = (first.webkitRelativePath ?? first.name).split('/')[0] ?? '所选文件夹';
    sourceDir.value = rootName;
    const files = await readObsidianVaultFromFileList(list, onScanProgress);
    sourceFiles.value = files;
    phase.value = 'ready';
  } catch (err) {
    phase.value = 'idle';
    errorText.value = `读取失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    input.value = '';
  }
}

/* ------------------------------ 步骤 4：导入 ------------------------------ */

async function startImport(): Promise<void> {
  const vault = app.vault;
  if (!vault) {
    errorText.value = '仓库尚未就绪，请先打开一个 Neo MD 仓库后再导入。';
    return;
  }
  if (!markdownCount.value) {
    errorText.value = '所选目录中没有找到 Markdown 笔记（.md），无需导入。';
    return;
  }
  errorText.value = '';
  phase.value = 'importing';
  progress.value = { done: 0, total: markdownCount.value, currentPath: '' };

  try {
    const r = await importObsidianVault(vault, sourceFiles.value, opts.value, (p) => {
      progress.value = p;
    });
    report.value = r;
    phase.value = 'done';
    // 导入后刷新文件列表，让新笔记立刻出现在侧栏
    await app.refreshDocs();
    app.notify(`已导入 ${r.imported + r.converted} 篇笔记`, 'success', 2600);
  } catch (e) {
    phase.value = 'ready';
    errorText.value = `导入失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/* ------------------------------ 步骤 5：报告 ------------------------------ */

const reportKeyword = ref('');

const filteredReportFiles = computed(() => {
  const files = report.value?.files ?? [];
  const kw = reportKeyword.value.trim().toLowerCase();
  if (!kw) return files;
  return files.filter(
    (f) =>
      f.sourcePath.toLowerCase().includes(kw) ||
      f.targetPath.toLowerCase().includes(kw) ||
      f.status.toLowerCase().includes(kw),
  );
});

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  imported: { text: '已导入', cls: 'is-ok' },
  converted: { text: '已转换', cls: 'is-ok' },
  skipped: { text: '已跳过', cls: 'is-warn' },
  conflict: { text: '冲突', cls: 'is-warn' },
  failed: { text: '失败', cls: 'is-bad' },
};

const CONVERSION_LABEL: Record<string, string> = {
  'hard-break': '硬换行',
  callout: 'Callout',
  comment: '注释',
  highlight: '高亮',
  'embed-image': '图片嵌入',
  'embed-note': '笔记嵌入',
  'block-ref': '块引用',
  'block-id': '块 ID',
  'task-in-progress': '进行中任务',
  dataview: 'Dataview',
};

function conversionText(list: string[]): string {
  if (!list.length) return '—';
  return list.map((c) => CONVERSION_LABEL[c] ?? c).join('、');
}

/** 把转换结果导出为 CSV（用户可能想核对哪些文件被改写了） */
function exportReportCsv(): void {
  const r = report.value;
  if (!r) return;
  const header = ['源路径', '目标路径', '修改日期', '状态', '应用转换'];
  const rows = r.files.map((f) => [
    f.sourcePath,
    f.targetPath,
    formatDate(f.modifiedAt),
    STATUS_LABEL[f.status]?.text ?? f.status,
    conversionText(f.conversions),
  ]);
  const csv = [header, ...rows]
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  // 加 BOM，保证 Excel 打开中文不乱码
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `obsidian-import-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

void settingsStore;
void shouldSkipPath;
void convertObsidianMarkdown;
</script>

<template>
  <div class="obs" :class="{ 'is-compact': compact }">
    <!-- 步骤条 -->
    <ol class="obs-steps">
      <li :class="{ 'is-active': phase === 'idle', 'is-done': phase !== 'idle' }">1 选择目录</li>
      <li :class="{ 'is-active': phase === 'scanning', 'is-done': phase === 'ready' || phase === 'importing' || phase === 'done' }">2 扫描文件</li>
      <li :class="{ 'is-active': phase === 'ready', 'is-done': phase === 'importing' || phase === 'done' }">3 配置选项</li>
      <li :class="{ 'is-active': phase === 'importing', 'is-done': phase === 'done' }">4 执行导入</li>
      <li :class="{ 'is-active': phase === 'done' }">5 查看报告</li>
    </ol>

    <p v-if="errorText" class="obs-alert is-bad" role="alert">
      <NmIcon name="alert" :size="14" />
      <span>{{ errorText }}</span>
    </p>

    <!-- ---------------- 步骤 1：选择目录 ---------------- -->
    <section class="obs-card">
      <h4 class="obs-card__title">选择 Obsidian 仓库目录</h4>
      <p class="nm-hint">
        请选择 Obsidian 仓库的<strong>根目录</strong>（包含 <code>.obsidian</code> 文件夹的那一层）。
        导入时会自动跳过 <code>.obsidian</code>、<code>.trash</code>、<code>.git</code>、<code>node_modules</code> 等目录。
      </p>

      <div class="obs-row">
        <button
          v-if="canPickDirectory"
          type="button"
          class="nm-btn nm-btn--primary nm-btn--sm"
          :disabled="phase === 'scanning' || phase === 'importing'"
          title="打开系统目录选择对话框"
          @click="pickAndScan"
        >
          <NmIcon name="folderOpen" :size="14" />
          {{ phase === 'scanning' ? '扫描中…' : '选择 Obsidian 仓库目录' }}
        </button>

        <!-- 网页端兜底：目录选择器 -->
        <label v-else class="nm-btn nm-btn--primary nm-btn--sm obs-file-label" title="在浏览器中选择整个文件夹">
          <NmIcon name="folderOpen" :size="14" />
          选择文件夹
          <input type="file" webkitdirectory multiple hidden :disabled="phase === 'importing'" @change="onWebFolderPicked" />
        </label>

        <button
          v-if="sourceDir"
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="phase === 'importing'"
          title="重新选择目录"
          @click="resetAll"
        >
          重新选择
        </button>
      </div>

      <!-- 非桌面端说明 -->
      <p v-if="!canPickDirectory" class="nm-hint obs-warn-note">
        <NmIcon name="info" :size="13" />
        当前为网页 / 移动端环境，浏览器无法读取真实文件修改时间，只能用「最后修改时间」元数据近似替代。
        如需完整保留文件时间戳，请在 <strong>PC 客户端</strong> 中使用本功能。
      </p>

      <p v-if="sourceDir" class="obs-src">
        源目录：<code>{{ sourceDir }}</code>
      </p>
    </section>

    <!-- ---------------- 步骤 2：扫描结果 ---------------- -->
    <section v-if="phase === 'scanning'" class="obs-card">
      <h4 class="obs-card__title">正在扫描…</h4>
      <div class="obs-bar">
        <div class="obs-bar__fill" :style="{ width: `${progressPercent}%` }" />
      </div>
      <p class="nm-hint">
        已发现 <strong>{{ progress.total }}</strong> 个文件 · 当前：<code>{{ progress.currentPath || '—' }}</code>
      </p>
    </section>

    <section v-else-if="phase !== 'idle'" class="obs-card">
      <h4 class="obs-card__title">扫描结果</h4>
      <div class="obs-stats">
        <div class="obs-stat">
          <span>{{ markdownCount }}</span>
          <em>可导入的 Markdown 笔记</em>
        </div>
        <div class="obs-stat">
          <span>{{ nonMarkdownCount }}</span>
          <em>二进制资源（本版跳过）</em>
        </div>
        <div class="obs-stat">
          <span>{{ syntaxPreview.hitFiles }}</span>
          <em>含 Obsidian 专有语法</em>
        </div>
      </div>

      <div v-if="syntaxPreview.items.length" class="obs-syntax">
        <span class="obs-syntax__title">语法预检：</span>
        <span v-for="item in syntaxPreview.items" :key="item.key" class="obs-chip">
          {{ item.label }} {{ item.count }}
        </span>
      </div>
      <p v-if="syntaxPreview.hitFiles > 0" class="nm-hint">
        共 {{ syntaxPreview.total }} 篇笔记中检出 {{ syntaxPreview.hitFiles }} 篇含 Obsidian 专有语法，
        建议保持下方「转换 Obsidian 专有语法」开启，否则高亮、Callout、嵌入等会显示异常。
      </p>
    </section>

    <!-- ---------------- 步骤 3：选项（常驻显示，未扫描时仅禁用「开始导入」） ---------------- -->
    <section class="obs-card">
      <h4 class="obs-card__title">导入选项</h4>

      <div class="field">
        <label class="nm-label">导入到目标文件夹（留空 = 仓库根目录）</label>
        <input
          v-model="opts.targetFolder"
          class="nm-input"
          placeholder="例如：Obsidian 导入"
          :disabled="phase === 'importing' || phase === 'done'"
        />
        <p class="nm-hint">建议填一个新文件夹，便于一次性撤销；源路径的子目录结构会原样保留。</p>
      </div>

      <!-- 时间戳：用户明确要求的功能，单独突出 -->
      <div class="field field--row obs-highlight-field">
        <div>
          <label class="nm-label">
            <NmIcon name="clock" :size="13" />
            保留文件的修改日期
            <span class="obs-badge">推荐</span>
          </label>
          <p class="nm-hint">
            把源文件的真实修改时间写入 Neo MD，否则所有笔记都会显示为「刚刚创建」，
            按修改时间排序、最近打开、新近度推荐都会全部失真。
          </p>
        </div>
        <button
          type="button"
          class="obs-toggle"
          :class="{ 'is-on': opts.keepTimestamps }"
          :aria-pressed="opts.keepTimestamps"
          :title="opts.keepTimestamps ? '关闭后将使用导入时刻作为时间' : '开启后保留源文件真实修改时间'"
          :disabled="phase === 'importing' || phase === 'done'"
          @click="opts.keepTimestamps = !opts.keepTimestamps"
        >
          {{ opts.keepTimestamps ? '开启' : '关闭' }}
        </button>
      </div>

      <div class="field field--row">
        <div>
          <label class="nm-label">转换 Obsidian 专有语法</label>
          <p class="nm-hint">总开关。开启后按下方子项转换 callout、注释、高亮、嵌入等；关闭则原文导入。</p>
        </div>
        <button
          type="button"
          class="obs-toggle"
          :class="{ 'is-on': opts.convertSyntax }"
          :aria-pressed="opts.convertSyntax"
          :disabled="phase === 'importing' || phase === 'done'"
          @click="opts.convertSyntax = !opts.convertSyntax"
        >
          {{ opts.convertSyntax ? '开启' : '关闭' }}
        </button>
      </div>

      <div class="obs-subopts" :class="{ 'is-disabled': !opts.convertSyntax }">
        <label class="obs-check">
          <input v-model="opts.normalizeHardBreaks" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>硬换行规范化</strong>（Obsidian 单个换行即换行 → CommonMark 行尾两空格）</span>
        </label>
        <label class="obs-check">
          <input v-model="opts.convertCallouts" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>Callout 标注块</strong>（<code>&gt; [!note]</code> → 引用块 + 粗体标题）</span>
        </label>
        <label class="obs-check">
          <input v-model="opts.convertComments" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>注释转换</strong>（<code>%%注释%%</code> → HTML 注释，避免被当正文显示）</span>
        </label>
        <label class="obs-check">
          <input v-model="opts.convertHighlights" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>高亮</strong>（<code>==高亮==</code> → <code>&lt;mark&gt;</code>）</span>
        </label>
        <label class="obs-check">
          <input v-model="opts.convertEmbeds" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>嵌入转换</strong>（<code>![[图片]]</code> → 标准图片；嵌入笔记 → wikilink）</span>
        </label>
        <label class="obs-check">
          <input v-model="opts.normalizeTasks" type="checkbox" :disabled="!opts.convertSyntax" />
          <span><strong>任务列表规范化</strong>（<code>[/]</code> 进行中 → 标准 GFM 未勾选）</span>
        </label>
      </div>

      <div class="field">
        <label class="nm-label">同名笔记冲突处理</label>
        <div class="seg">
          <button
            type="button"
            class="seg__item"
            :class="{ 'is-active': opts.onConflict === 'rename' }"
            :disabled="phase === 'importing' || phase === 'done'"
            @click="opts.onConflict = 'rename'"
          >
            重命名保留两份
          </button>
          <button
            type="button"
            class="seg__item"
            :class="{ 'is-active': opts.onConflict === 'overwrite' }"
            :disabled="phase === 'importing' || phase === 'done'"
            @click="opts.onConflict = 'overwrite'"
          >
            覆盖已有笔记
          </button>
          <button
            type="button"
            class="seg__item"
            :class="{ 'is-active': opts.onConflict === 'skip' }"
            :disabled="phase === 'importing' || phase === 'done'"
            @click="opts.onConflict = 'skip'"
          >
            跳过同名笔记
          </button>
        </div>
        <p class="nm-hint">
          「重命名保留两份」会追加 (2)(3) 后缀，是最安全的选择；
          「覆盖」会刷新目标笔记的修改时间，源文件时间戳无法保留。
        </p>
      </div>

      <div class="obs-row">
        <button
          type="button"
          class="nm-btn nm-btn--primary"
          :disabled="phase === 'importing' || phase === 'scanning' || !markdownCount"
          :title="
            phase === 'idle' || phase === 'scanning'
              ? '请先选择并扫描 Obsidian 仓库目录'
              : !markdownCount
                ? '没有可导入的 Markdown 笔记'
                : '开始导入'
          "
          @click="startImport"
        >
          <NmIcon name="upload" :size="14" />
          {{ phase === 'importing' ? '导入中…' : `开始导入（${markdownCount} 篇）` }}
        </button>
        <span v-if="phase === 'idle'" class="nm-hint obs-inline-hint">请先在上方选择 Obsidian 仓库目录</span>
        <button
          v-if="phase === 'done'"
          type="button"
          class="nm-btn nm-btn--sm"
          title="再导入一次另一个仓库"
          @click="resetAll"
        >
          导入另一个仓库
        </button>
      </div>

      <div v-if="phase === 'importing'" class="obs-progress">
        <div class="obs-bar">
          <div class="obs-bar__fill" :style="{ width: `${progressPercent}%` }" />
        </div>
        <p class="nm-hint">
          {{ progress.done }} / {{ progress.total }}（{{ progressPercent }}%） · 正在处理
          <code>{{ progress.currentPath }}</code>
        </p>
      </div>
    </section>

    <!-- ---------------- 步骤 5：报告 ---------------- -->
    <section v-if="phase === 'done' && report" class="obs-card">
      <h4 class="obs-card__title">
        <NmIcon name="check" :size="15" />
        导入完成
      </h4>

      <div class="obs-stats">
        <div class="obs-stat is-primary">
          <span>{{ report.imported + report.converted }}</span>
          <em>成功导入</em>
        </div>
        <div class="obs-stat">
          <span>{{ report.converted }}</span>
          <em>其中做过语法转换</em>
        </div>
        <div class="obs-stat">
          <span>{{ report.skipped }}</span>
          <em>跳过（同名/无内容）</em>
        </div>
        <div class="obs-stat" :class="{ 'is-bad': report.failed > 0 }">
          <span>{{ report.failed }}</span>
          <em>失败</em>
        </div>
        <div class="obs-stat">
          <span>{{ (report.durationMs / 1000).toFixed(1) }}s</span>
          <em>总耗时</em>
        </div>
      </div>

      <p class="nm-hint">
        时间范围：{{ formatDate(report.startedAt) }} — {{ formatDate(report.finishedAt) }}。
        共扫描 {{ report.total }} 个可导入文件。
      </p>

      <details v-if="report.ignoredPaths.length" class="obs-ignored">
        <summary>已跳过 {{ report.ignoredPaths.length }} 个文件 / 配置项（点击展开）</summary>
        <ul>
          <li v-for="(p, i) in report.ignoredPaths.slice(0, 300)" :key="i">{{ p }}</li>
        </ul>
        <p v-if="report.ignoredPaths.length > 300" class="nm-hint">仅显示前 300 条。</p>
      </details>

      <div class="obs-report-head">
        <h5>逐文件明细（{{ filteredReportFiles.length }} / {{ report.files.length }}）</h5>
        <div class="obs-report-tools">
          <input
            v-model="reportKeyword"
            class="nm-input obs-search"
            type="search"
            placeholder="搜索路径或状态…"
            aria-label="搜索导入报告"
          />
          <button type="button" class="nm-btn nm-btn--sm" title="导出为 CSV 表格" @click="exportReportCsv">
            <NmIcon name="download" :size="13" />
            导出 CSV
          </button>
        </div>
      </div>

      <div class="obs-table-wrap">
        <table class="obs-table">
          <thead>
            <tr>
              <th>源路径</th>
              <th>目标路径</th>
              <th class="col-date">修改日期</th>
              <th>状态</th>
              <th>应用转换</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in filteredReportFiles" :key="f.sourcePath">
              <td class="col-path"><code>{{ f.sourcePath }}</code></td>
              <td class="col-path"><code>{{ f.targetPath }}</code></td>
              <!-- 用户明确要求：每个文件都要能看到修改日期 -->
              <td class="col-date">{{ f.modifiedAt > 0 ? formatDate(f.modifiedAt) : '—' }}</td>
              <td>
                <span class="obs-status" :class="STATUS_LABEL[f.status]?.cls">
                  {{ STATUS_LABEL[f.status]?.text ?? f.status }}
                </span>
                <span v-if="f.error" class="obs-err" :title="f.error">{{ f.error }}</span>
              </td>
              <td class="col-conv">{{ conversionText(f.conversions) }}</td>
            </tr>
            <tr v-if="!filteredReportFiles.length">
              <td colspan="5" class="obs-empty">没有匹配的记录。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.obs { display: flex; flex-direction: column; gap: 14px; }
.obs.is-compact { gap: 10px; }

/* 步骤条 */
.obs-steps { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 2px; padding: 0; list-style: none; counter-reset: step; }
.obs-steps li {
  padding: 4px 10px; border-radius: 999px; font-size: 11.5px;
  background: var(--bg-hover); color: var(--fg-3); border: 1px solid var(--border);
}
.obs-steps li.is-active { background: var(--accent-weak); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.obs-steps li.is-done { color: #16a34a; border-color: color-mix(in srgb, #16a34a 40%, var(--border)); }

.obs-card { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--bg-elevated); }
.obs-card__title {
  display: flex; align-items: center; gap: 7px;
  margin: 0 0 10px; font-size: 13.5px; font-weight: 700;
}
.obs-card__title .nm-icon { color: var(--accent); }

.obs-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.obs-inline-hint { margin: 0; }
.obs-file-label { cursor: pointer; }
.obs-src { margin: 8px 0 0; font-size: 12px; color: var(--fg-2); word-break: break-all; }
.obs-src code { background: var(--bg-hover); padding: 1px 6px; border-radius: 4px; font-family: var(--font-mono); }

.obs-alert {
  display: flex; align-items: flex-start; gap: 7px; margin: 0;
  padding: 9px 12px; border-radius: 9px; font-size: 12.5px; line-height: 1.6;
  background: rgba(217, 48, 37, 0.08); color: #d93025;
}
.obs-warn-note {
  display: flex; align-items: flex-start; gap: 7px; margin: 10px 0 0;
  padding: 8px 11px; border-radius: 8px; font-size: 12px;
  background: rgba(245, 158, 11, 0.1); color: #b45309;
}

/* 统计卡 */
.obs-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 12px; }
.obs-stat {
  padding: 11px 12px; border-radius: 9px; text-align: center;
  background: var(--bg-sidebar); border: 1px solid var(--border);
}
.obs-stat span { display: block; font-size: 19px; font-weight: 700; color: var(--accent); }
.obs-stat em { font-style: normal; font-size: 11px; color: var(--fg-3); }
.obs-stat.is-primary span { color: #16a34a; }
.obs-stat.is-bad span { color: #d93025; }

/* 语法预检 */
.obs-syntax { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; }
.obs-syntax__title { color: var(--fg-3); }
.obs-chip {
  padding: 2px 9px; border-radius: 999px; font-size: 11px;
  background: var(--accent-weak-2); color: var(--accent); border: 1px solid var(--border);
}

/* 选项 */
.obs-highlight-field {
  padding: 10px 12px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--accent-weak-2);
}
.obs-highlight-field .nm-label { display: inline-flex; align-items: center; gap: 5px; }
.obs-badge {
  margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 10px; font-weight: 700; background: var(--accent); color: #fff;
}
.obs-toggle {
  min-width: 62px; height: 28px; padding: 0 12px; border-radius: 14px;
  font-size: 12px; font-weight: 600; flex: 0 0 auto;
  background: var(--bg-hover); color: var(--fg-3); border: 1px solid var(--border);
}
.obs-toggle.is-on { background: var(--accent); border-color: var(--accent); color: #fff; }
.obs-toggle:disabled { opacity: 0.55; cursor: not-allowed; }

.obs-subopts { display: grid; gap: 7px; margin: 4px 0 14px; padding-left: 2px; }
.obs-subopts.is-disabled { opacity: 0.5; }
.obs-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--fg-2); line-height: 1.6; }
.obs-check input { margin-top: 3px; flex: 0 0 auto; }
.obs-check code { font-family: var(--font-mono); background: var(--bg-hover); padding: 0 4px; border-radius: 3px; }

.seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--bg-hover); border: 1px solid var(--border); flex-wrap: wrap; }
.seg__item { padding: 6px 11px; border-radius: 6px; font-size: 12.5px; color: var(--fg-2); }
.seg__item.is-active { background: var(--bg-elevated); color: var(--accent); font-weight: 600; box-shadow: var(--shadow-1); }
.seg__item:disabled { opacity: 0.55; cursor: not-allowed; }

/* 进度条 */
.obs-progress { margin-top: 12px; }
.obs-bar { height: 6px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.obs-bar__fill { height: 100%; background: var(--accent); transition: width 0.18s ease; }

/* 报告 */
.obs-ignored { margin: 10px 0; font-size: 12px; }
.obs-ignored summary { cursor: pointer; color: var(--accent); }
.obs-ignored ul { margin: 8px 0 0; padding-left: 18px; max-height: 180px; overflow-y: auto; color: var(--fg-2); line-height: 1.7; }

.obs-report-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 14px 0 8px; }
.obs-report-head h5 { margin: 0; font-size: 13px; font-weight: 650; }
.obs-report-tools { display: flex; align-items: center; gap: 8px; }
.obs-search { width: 200px; height: 28px; font-size: 12px; }

.obs-table-wrap { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 9px; }
.obs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.obs-table th, .obs-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.obs-table th {
  position: sticky; top: 0; z-index: 1;
  background: var(--bg-sidebar); color: var(--fg-3); font-weight: 600; font-size: 11.5px;
  white-space: nowrap;
}
.obs-table tbody tr:hover { background: var(--bg-hover); }
.obs-table .col-path { max-width: 260px; }
.obs-table .col-path code {
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-2);
  word-break: break-all; background: none; padding: 0;
}
.obs-table .col-date { white-space: nowrap; font-family: var(--font-mono); font-size: 11px; color: var(--fg-2); }
.obs-table .col-conv { font-size: 11.5px; color: var(--fg-3); }
.obs-empty { text-align: center !important; color: var(--fg-3); padding: 18px !important; }

.obs-status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.obs-status.is-ok { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
.obs-status.is-warn { background: rgba(245, 158, 11, 0.14); color: #b45309; }
.obs-status.is-bad { background: rgba(217, 48, 37, 0.12); color: #d93025; }
.obs-err {
  display: block; margin-top: 2px; font-size: 11px; color: #d93025;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.field { margin-bottom: 14px; }
.field--row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.nm-hint { font-size: 11.5px; line-height: 1.65; color: var(--fg-3); margin: 4px 0 0; }

@media (max-width: 760px) {
  .obs-stats { grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); }
  .obs-table .col-path { max-width: 150px; }
  .obs-search { width: 130px; }
  .field--row { flex-direction: column; gap: 8px; }
}
</style>
