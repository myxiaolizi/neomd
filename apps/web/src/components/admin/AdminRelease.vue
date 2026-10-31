<script setup lang="ts">
/**
 * 后台 · 发布与分发（1.4.0 重做「客户端分发」区块）。
 *
 * 一个页面承载两件相关的事：
 *  1. **网页发布**：用户把文档发布成 `https://md.zhengl.vip/p/<slug>` 的静态页，这里可下线；
 *  2. **客户端分发**：安装包清单（当前版本 + 历史版本），含大小 / 时间 / 下载次数 / 可下载性。
 *
 * ## 1.4.0 为什么重做客户端分发
 *
 * 1.3.1 及以前这个区块只做了一件事：列出对象存储 `mdadmin/releases/` 下的对象。
 * 三个后果：
 *   - **看不见只在本地的那批文件**：`services/api/releases/` 里的历史 APK（1.1.8 及更早）
 *     从未上传 OSS，后台完全不显示，管理员会以为那些版本没发过；
 *   - **没有「当前版本」**：列表按修改时间倒序，但没有任何标记说明「哪个是现在该发的」；
 *   - **没有下载次数与可用性**：只有文件名/大小/时间，判断不了「这一版能不能下」。
 *
 * 现在这些信息全部来自 `/api/admin/releases`，而它**复用 download.js 的数据源**
 * （`DOWNLOAD_FILES` + `listHistoricalApks()`），因此后台看到的集合与客户端能下到的集合一致。
 *
 * ## 关于「可下载」这一列的语义（实测踩过的坑）
 *
 * 不能简单地用「OSS 上有 = 可下载」。两条分发链路规则不同：
 *   - **zip / exe**：302 跳到 OSS 预签名地址，客户端直连 → 只有 OSS 上有才可下载；
 *   - **APK**：由本服务直出（阿里云禁止 APK 经 OSS 端点公开分发）→ 只有**本地**
 *     `services/api/releases/` 有才可下载。
 * 所以页面上把「客户端可下载」与「OSS / 本地存在情况」分开显示，差异一眼可见。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApi } from '@/api/client';
import { formatBytes } from '@neomd/shared';
import { fmtTime } from './shared';
import {
  fetchAdminReleases,
  probeAdminRelease,
  type AdminReleaseFile,
  type AdminReleasesResult,
} from './admin-api';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const publishes = ref<Array<Record<string, unknown>>>([]);
const search = ref('');
const loading = ref(false);
const releaseNote = ref('');

/* ---------------- 客户端分发（1.4.0） ---------------- */

const releases = ref<AdminReleasesResult | null>(null);
const releaseLoading = ref(false);
const releaseFilter = ref<'all' | 'current' | 'history'>('all');
/** 只显示「有问题」的条目（不可下载 / 仅在 OSS 或仅在本地） */
const onlyIssues = ref(false);
const probed = ref<Record<string, { ok: boolean; text: string }>>({});
const probing = ref<string>('');

const currentVersion = computed(() => releases.value?.currentVersion ?? '');
const summary = computed(() => releases.value?.summary ?? null);

const visibleFiles = computed<AdminReleaseFile[]>(() => {
  const all = releases.value?.files ?? [];
  let list = all;
  if (releaseFilter.value === 'current') list = all.filter((f) => f.isCurrent);
  else if (releaseFilter.value === 'history') list = all.filter((f) => !f.isCurrent);
  if (onlyIssues.value) {
    list = list.filter((f) => !f.available || !f.downloadable || f.onOss !== f.onLocal);
  }
  return list;
});

/** 版本号 → 该版本的产物条数（用于「历史版本」分组标签） */
const versionGroups = computed(() => {
  const m = new Map<string, number>();
  for (const f of releases.value?.files ?? []) {
    const v = f.version ?? '未知';
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
});

/** 来源标签：OSS / 本地 / 两者 */
function sourceLabel(f: AdminReleaseFile): { text: string; cls: string } {
  if (f.onOss && f.onLocal) return { text: 'OSS + 本地', cls: 'adm-badge--ok' };
  if (f.onOss) return { text: '仅 OSS', cls: 'adm-badge--warn' };
  if (f.onLocal) return { text: '仅本地', cls: 'adm-badge--warn' };
  return { text: '均无', cls: 'adm-badge--danger' };
}

function availableLabel(f: AdminReleaseFile): { text: string; cls: string } {
  if (!f.downloadable) return { text: '不可分发', cls: 'adm-badge--muted' };
  if (f.available) return { text: '可下载', cls: 'adm-badge--ok' };
  return { text: '不可下载', cls: 'adm-badge--danger' };
}

async function loadReleases(): Promise<void> {
  releaseLoading.value = true;
  try {
    releases.value = await fetchAdminReleases();
    if (releases.value.message) releaseNote.value = releases.value.message;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    releaseLoading.value = false;
  }
}

/** 真实 HEAD 探测某个安装包在客户端链路下是否可达 */
async function probe(file: string): Promise<void> {
  probing.value = file;
  try {
    const res = await probeAdminRelease(file);
    probed.value = {
      ...probed.value,
      [file]: {
        ok: res.reachable,
        text: res.reachable
          ? `可达 · HTTP ${res.status} · ${res.latencyMs}ms`
          : `不可达 · ${res.message}`,
      },
    };
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    probing.value = '';
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [pub] = await Promise.all([
      adminApi.publishes({ page: 1, pageSize: 40, search: search.value.trim() || undefined }),
      loadReleases(),
    ]);
    publishes.value = pub.items;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function revoke(id: number): Promise<void> {
  if (!window.confirm('下线该发布页面？下线后访客访问会返回 404，但源文档保留。')) return;
  try {
    await adminApi.revokePublish(id);
    await load();
    emit('notify', '发布页面已下线');
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="rel">
    <header class="adm-page-head">
      <div>
        <h2>发布与分发</h2>
        <p>
          网页发布的文档清单与客户端安装包。下线只撤销访问入口，源文档与历史版本不受影响。
          客户端分发区展示当前版本与全部历史版本，并区分产物在对象存储与本地磁盘的存在情况。
        </p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- ==================== 客户端分发（1.4.0） ==================== -->
    <section class="adm-card" style="margin-bottom: 26px;" data-testid="release-section">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">
            客户端分发
            <span v-if="currentVersion" class="rel__curver" data-testid="current-version">
              当前版本 v{{ currentVersion }}
            </span>
          </h3>
          <p class="adm-card__sub">
            当前版本号取自 <code>services/api/package.json</code>；清单与下载白名单复用
            <code>download.js</code> 的同一份数据源，不存在第二份硬编码清单。
          </p>
        </div>
        <div class="adm-toolbar" style="margin: 0;">
          <select v-model="releaseFilter" class="nm-input adm-toolbar__sel">
            <option value="all">全部（{{ summary?.total ?? 0 }}）</option>
            <option value="current">仅当前版本（{{ summary?.current ?? 0 }}）</option>
            <option value="history">仅历史版本（{{ summary?.history ?? 0 }}）</option>
          </select>
          <label class="rel__check">
            <input v-model="onlyIssues" type="checkbox" />
            只看异常
          </label>
        </div>
      </div>

      <div class="adm-card__body" style="padding-top: 6px;">
        <p v-if="releaseNote" class="adm-note adm-note--warn" style="margin-bottom: 14px;">{{ releaseNote }}</p>

        <!-- 汇总指标：一眼看出「有没有缺件」 -->
        <div v-if="summary" class="rel__metrics" data-testid="release-metrics">
          <span>可下载 <b>{{ summary.available }}</b> / {{ summary.total }}</span>
          <span>OSS <b>{{ summary.onOss }}</b></span>
          <span>本地 <b>{{ summary.onLocal }}</b></span>
          <span>两者都有 <b>{{ summary.both }}</b></span>
          <span :class="{ 'rel__warn': summary.ossOnly > 0 }">仅 OSS <b>{{ summary.ossOnly }}</b></span>
          <span :class="{ 'rel__warn': summary.localOnly > 0 }">仅本地 <b>{{ summary.localOnly }}</b></span>
          <span>累计下载 <b>{{ summary.totalDownloads }}</b></span>
        </div>

        <!-- 版本分布（历史版本一览） -->
        <div v-if="versionGroups.length" class="rel__versions">
          <span v-for="[v, n] in versionGroups" :key="v" class="rel__vchip" :class="{ 'is-cur': v === currentVersion }">
            v{{ v }}<i>{{ n }}</i>
          </span>
        </div>

        <table class="adm-table adm-table--tight">
          <thead>
            <tr>
              <th>文件</th>
              <th style="width: 92px;">版本</th>
              <th class="adm-right" style="width: 104px;">大小</th>
              <th style="width: 150px;">更新时间</th>
              <th class="adm-right" style="width: 88px;">下载次数</th>
              <th style="width: 110px;">存放位置</th>
              <th style="width: 96px;">可下载性</th>
              <th class="adm-right" style="width: 150px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in visibleFiles" :key="f.file" :class="{ 'rel__row--cur': f.isCurrent }">
              <td>
                <span class="adm-mono">{{ f.file }}</span>
                <span v-if="f.isCurrent" class="adm-badge adm-badge--accent rel__badge">当前</span>
                <span v-if="f.historical" class="adm-badge adm-badge--muted rel__badge">历史</span>
                <div v-if="f.note" class="rel__note">{{ f.note }}</div>
              </td>
              <td class="adm-mono adm-muted">{{ f.version ?? '—' }}</td>
              <td class="adm-right adm-muted">{{ f.size ? formatBytes(f.size) : '—' }}</td>
              <td class="adm-muted">{{ fmtTime(f.lastModified) }}</td>
              <td class="adm-right adm-muted">{{ f.downloads }}</td>
              <td>
                <span class="adm-badge" :class="sourceLabel(f).cls">{{ sourceLabel(f).text }}</span>
              </td>
              <td>
                <span class="adm-badge" :class="availableLabel(f).cls">{{ availableLabel(f).text }}</span>
              </td>
              <td class="adm-right">
                <button
                  class="adm-rowbtn"
                  :disabled="probing === f.file"
                  @click="probe(f.file)"
                >{{ probing === f.file ? '探测中…' : '探测' }}</button>
                <a
                  v-if="f.downloadable && f.url"
                  class="adm-rowbtn"
                  :href="f.url"
                  target="_blank"
                  rel="noopener"
                >下载</a>
                <span v-if="probed[f.file]" class="rel__probe" :class="{ 'is-ok': probed[f.file].ok }">
                  {{ probed[f.file].text }}
                </span>
              </td>
            </tr>
            <tr v-if="!visibleFiles.length">
              <td colspan="8" class="adm-empty">
                {{ releaseLoading ? '加载中…' : onlyIssues ? '没有异常条目' : '暂无发布文件' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ==================== 网页发布 ==================== -->
    <section class="adm-card">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">网页发布</h3>
          <p class="adm-card__sub">发布到 <code>/p/&lt;slug&gt;</code> 的静态页面</p>
        </div>
        <div class="adm-toolbar" style="margin: 0;">
          <input
            v-model="search"
            class="nm-input adm-toolbar__search"
            placeholder="搜索标题 / Slug / 用户名"
            @keyup.enter="load"
          />
          <button class="nm-btn nm-btn--sm nm-btn--primary" @click="load">搜索</button>
        </div>
      </div>
      <div class="adm-card__body" style="padding-top: 6px;">
        <table class="adm-table adm-table--tight">
          <thead>
            <tr>
              <th>标题</th>
              <th style="width: 180px;">Slug</th>
              <th style="width: 160px;">创建时间</th>
              <th style="width: 96px;">状态</th>
              <th class="adm-right" style="width: 180px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in publishes" :key="String(p.id)">
              <td class="adm-strong">{{ p.title }}</td>
              <td class="adm-mono adm-muted">{{ p.slug }}</td>
              <td class="adm-muted">{{ fmtTime(p.createdAt) }}</td>
              <td>
                <span class="adm-badge" :class="p.revokedAt ? 'adm-badge--danger' : 'adm-badge--ok'">
                  {{ p.revokedAt ? '已下线' : '在线' }}
                </span>
              </td>
              <td class="adm-right">
                <a
                  v-if="!p.revokedAt"
                  class="adm-rowbtn"
                  :href="String(p.url ?? `/p/${p.slug}`)"
                  target="_blank"
                  rel="noopener"
                >打开链接</a>
                <button v-if="!p.revokedAt" class="adm-rowbtn adm-rowbtn--danger" @click="revoke(Number(p.id))">
                  下线
                </button>
              </td>
            </tr>
            <tr v-if="!publishes.length">
              <td colspan="5" class="adm-empty">{{ loading ? '加载中…' : '暂无发布' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rel__curver {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 10px;
  border-radius: 10px;
  background: var(--adm-accent-weak);
  color: var(--adm-accent-deep);
  font-size: 11.5px;
  font-weight: 650;
  vertical-align: middle;
}
.rel__metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 4px 0 14px;
  padding: 10px 14px;
  border-radius: 10px;
  background: #f7f9fb;
  font-size: 12.5px;
  color: var(--adm-fg-2, #4b5563);
}
.rel__metrics b { color: var(--adm-fg, #1f2329); font-weight: 650; }
.rel__warn { color: #b45309; }
.rel__warn b { color: #b45309; }

.rel__versions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.rel__vchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 9px;
  background: #f1f3f5;
  color: #5b6472;
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
}
.rel__vchip i { font-style: normal; opacity: 0.6; }
.rel__vchip.is-cur { background: var(--adm-accent-weak); color: var(--adm-accent-deep); font-weight: 600; }

.rel__row--cur td { background: #f8fbff; }
.rel__badge { margin-left: 6px; font-size: 10px; }
.rel__note { margin-top: 3px; font-size: 11px; color: #8a9099; line-height: 1.5; }
.rel__probe { display: block; margin-top: 3px; font-size: 10.5px; color: #d93025; }
.rel__probe.is-ok { color: #0e9f6e; }
.rel__check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #4b5563; white-space: nowrap; }
</style>
