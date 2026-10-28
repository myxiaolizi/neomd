<script setup lang="ts">
/**
 * 后台 · 分享与评价（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 分享链接列表 + 行内展开的访客评价管理。
 * 「评价跟随分享内容」是这个页面的核心交互：展开某条分享即可在其下方
 * 查看该分享下的全部评论与划词标注，并直接隐藏/恢复，不用跳到另一个页面。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApi, adminApiV2 } from '@/api/client';
import { fmtTime } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

interface CommentRow {
  id: number;
  shareId: number;
  authorName: string;
  body: string;
  quote?: string;
  status: 'visible' | 'hidden';
  createdAt: string;
}

const shares = ref<Array<Record<string, unknown>>>([]);
const search = ref('');
const loading = ref(false);
const expandedId = ref<number | null>(null);
const commentsMap = ref<Record<number, CommentRow[]>>({});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApi.shares({ page: 1, pageSize: 40, search: search.value.trim() || undefined });
    shares.value = res.items;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function toggleComments(shareId: number): Promise<void> {
  if (expandedId.value === shareId) {
    expandedId.value = null;
    return;
  }
  expandedId.value = shareId;
  try {
    const res = await adminApiV2.shareComments(shareId);
    commentsMap.value = { ...commentsMap.value, [shareId]: res.items as CommentRow[] };
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function toggleComment(shareId: number, commentId: number, current: string): Promise<void> {
  try {
    const next = current === 'visible' ? 'hidden' : 'visible';
    await adminApi.setCommentStatus(commentId, next);
    const res = await adminApiV2.shareComments(shareId);
    commentsMap.value = { ...commentsMap.value, [shareId]: res.items as CommentRow[] };
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function revoke(id: number): Promise<void> {
  if (!window.confirm('撤销该分享链接？撤销后访客将无法访问，但数据保留。')) return;
  try {
    await adminApi.revokeShare(id);
    await load();
    emit('notify', '分享链接已撤销');
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="shr">
    <header class="adm-page-head">
      <div>
        <h2>分享与评价</h2>
        <p>点「查看/管理评价」即可在该分享内容下方直接查看访客评论与划词标注，并进行隐藏或恢复。</p>
      </div>
    </header>

    <div class="adm-toolbar">
      <input
        v-model="search"
        class="nm-input adm-toolbar__search"
        placeholder="搜索分享标题、Token 或用户名"
        @keyup.enter="load"
      />
      <button class="nm-btn nm-btn--sm nm-btn--primary" @click="load">搜索</button>
      <span class="adm-toolbar__spacer adm-toolbar__count">共 {{ shares.length }} 条</span>
    </div>

    <table class="adm-table">
      <thead>
        <tr>
          <th>分享文档标题</th>
          <th style="width: 130px;">所属用户</th>
          <th class="adm-right" style="width: 96px;">浏览量</th>
          <th style="width: 110px;">评价数</th>
          <th style="width: 160px;">创建时间</th>
          <th style="width: 96px;">状态</th>
          <th class="adm-right" style="width: 240px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="s in shares" :key="String(s.id)">
          <tr>
            <td class="adm-strong">{{ s.title }}</td>
            <td class="adm-muted">{{ s.username ?? s.userId }}</td>
            <td class="adm-right adm-muted">{{ s.viewCount }}</td>
            <td><span class="adm-badge adm-badge--accent">{{ s.commentCount ?? 0 }} 条</span></td>
            <td class="adm-muted">{{ fmtTime(s.createdAt) }}</td>
            <td>
              <span class="adm-badge" :class="s.revokedAt ? 'adm-badge--danger' : 'adm-badge--ok'">
                {{ s.revokedAt ? '已撤销' : '有效' }}
              </span>
            </td>
            <td class="adm-right">
              <a
                v-if="!s.revokedAt"
                class="adm-rowbtn"
                :href="String(s.url ?? `/s/${s.token}`)"
                target="_blank"
                rel="noopener"
              >打开链接</a>
              <button class="adm-rowbtn" @click="toggleComments(Number(s.id))">
                {{ expandedId === Number(s.id) ? '收起评价' : `管理评价(${s.commentCount ?? 0})` }}
              </button>
              <button v-if="!s.revokedAt" class="adm-rowbtn adm-rowbtn--danger" @click="revoke(Number(s.id))">撤销</button>
            </td>
          </tr>
          <tr v-if="expandedId === Number(s.id)">
            <td colspan="7" class="comments-cell">
              <div v-if="(commentsMap[Number(s.id)] ?? []).length" class="comments">
                <article v-for="c in commentsMap[Number(s.id)]" :key="c.id" class="comment">
                  <div class="comment__main">
                    <div class="comment__head">
                      <strong>{{ c.authorName }}</strong>
                      <span class="adm-muted" style="font-size: 11.5px;">{{ fmtTime(c.createdAt) }}</span>
                      <span class="adm-badge" :class="c.status === 'visible' ? 'adm-badge--ok' : 'adm-badge--muted'">
                        {{ c.status === 'visible' ? '显示中' : '已隐藏' }}
                      </span>
                    </div>
                    <blockquote v-if="c.quote" class="comment__quote">划词：「{{ c.quote }}」</blockquote>
                    <p class="comment__body">{{ c.body }}</p>
                  </div>
                  <button class="adm-rowbtn" @click="toggleComment(Number(s.id), c.id, c.status)">
                    {{ c.status === 'visible' ? '隐藏' : '恢复' }}
                  </button>
                </article>
              </div>
              <p v-else class="adm-muted" style="margin: 0; font-size: 12.5px;">该分享内容下暂无访客评价。</p>
            </td>
          </tr>
        </template>
        <tr v-if="!shares.length">
          <td colspan="7" class="adm-empty">{{ loading ? '加载中…' : '暂无分享' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.comments-cell { background: #fafbfc; padding: 14px 18px !important; }
.comments { display: grid; gap: 10px; }
.comment {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
}
.comment__main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.comment__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.comment__head strong { font-size: 12.5px; color: #1f2329; }
.comment__quote {
  margin: 3px 0;
  padding: 5px 9px;
  border-left: 3px solid #1677ff;
  background: rgba(22, 119, 255, 0.05);
  font-size: 12px;
  color: #4b5563;
  border-radius: 0 4px 4px 0;
}
.comment__body { margin: 0; font-size: 12.5px; line-height: 1.65; color: #1f2329; }
</style>
