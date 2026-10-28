<script setup lang="ts">
/**
 * 后台 · 发布与分发（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 一个页面承载两件相关的事：
 *  1. **网页发布**：用户把文档发布成 `https://md.zhengl.vip/p/<slug>` 的静态页，这里可下线；
 *  2. **客户端分发**：对象存储 `mdadmin/releases/` 下的安装包清单（预签名地址下载）。
 *
 * 合并的理由：两者都是「对外分发物」，运营排查「用户拿到的链接/安装包是哪一版」时
 * 需要在同一个视野里看，分成两个页签反而要来回切。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApi, adminApiV2 } from '@/api/client';
import { formatBytes } from '@neomd/shared';
import { fmtTime } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const publishes = ref<Array<Record<string, unknown>>>([]);
const releases = ref<Array<{ key: string; size: number; lastModified: string; url: string }>>([]);
const search = ref('');
const loading = ref(false);
const releaseNote = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [pub, rel] = await Promise.all([
      adminApi.publishes({ page: 1, pageSize: 40, search: search.value.trim() || undefined }),
      adminApiV2.releases().catch((e: Error) => {
        // 对象存储未配置时 /releases 会带 message 返回空列表；这里兜住异常但不阻断发布列表
        releaseNote.value = `列举发布包失败：${e.message}`;
        return { files: [] };
      }),
    ]);
    publishes.value = pub.items;
    releases.value = rel.files;
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
        <p>网页发布的文档清单与客户端安装包。下线只撤销访问入口，源文档与历史版本不受影响。</p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <section class="adm-card" style="margin-bottom: 26px;">
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

    <section class="adm-card">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">客户端分发</h3>
          <p class="adm-card__sub">安装包存放在对象存储 <code>mdadmin/releases/</code>，通过预签名地址分发</p>
        </div>
      </div>
      <div class="adm-card__body" style="padding-top: 6px;">
        <p v-if="releaseNote" class="adm-note adm-note--warn" style="margin-bottom: 14px;">{{ releaseNote }}</p>
        <table class="adm-table adm-table--tight">
          <thead>
            <tr>
              <th>文件</th>
              <th class="adm-right" style="width: 120px;">大小</th>
              <th style="width: 170px;">更新时间</th>
              <th class="adm-right" style="width: 90px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in releases" :key="f.key">
              <td class="adm-mono">{{ f.key.replace('mdadmin/releases/', '') }}</td>
              <td class="adm-right adm-muted">{{ formatBytes(f.size) }}</td>
              <td class="adm-muted">{{ fmtTime(f.lastModified) }}</td>
              <td class="adm-right">
                <a class="adm-rowbtn" :href="f.url" target="_blank" rel="noopener">下载</a>
              </td>
            </tr>
            <tr v-if="!releases.length">
              <td colspan="4" class="adm-empty">暂无发布文件</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
