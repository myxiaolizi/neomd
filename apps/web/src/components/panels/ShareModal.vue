<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { shareApi, publishApi, ApiError, type ShareItemDto } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';
import { SITE_URL } from '@/env';

const props = defineProps<{ modelValue: boolean; docId: string; title: string; content: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const auth = useAuthStore();
const app = useAppStore();
const settingsStore = useSettingsStore();

const mode = ref<'link' | 'publish'>('link');
const allowComment = ref(true);
const accessCode = ref('');
const expiresInDays = ref(0);
const busy = ref(false);
const errorText = ref('');
const resultUrl = ref('');
const myShares = ref<ShareItemDto[]>([]);
const copied = ref(false);

const linkUrl = computed(() => resultUrl.value || '');

async function loadShares(): Promise<void> {
  if (!auth.isLoggedIn) return;
  try {
    myShares.value = await shareApi.list();
  } catch {
    myShares.value = [];
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      resultUrl.value = '';
      errorText.value = '';
      copied.value = false;
      void loadShares();
    }
  },
);

async function createLink(): Promise<void> {
  if (!auth.isLoggedIn) {
    errorText.value = '分享链接需要登录后创建。';
    return;
  }
  busy.value = true;
  errorText.value = '';
  try {
    const res = await shareApi.create({
      docId: props.docId,
      title: props.title,
      markdown: props.content,
      mode: allowComment.value ? 'comment' : 'read',
      allowComment: allowComment.value,
      expiresInDays: expiresInDays.value || undefined,
      accessCode: accessCode.value.trim() || undefined,
      style: (settingsStore.settings.shareStyle as unknown as Record<string, unknown>) || undefined,
    });
    resultUrl.value = res.url;
    await loadShares();
  } catch (e) {
    errorText.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function publishWeb(): Promise<void> {
  if (!auth.isLoggedIn) {
    errorText.value = '发布需要登录后操作。';
    return;
  }
  busy.value = true;
  errorText.value = '';
  try {
    const res = await publishApi.create({ docId: props.docId, title: props.title, markdown: props.content });
    resultUrl.value = res.url;
  } catch (e) {
    errorText.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function revoke(id: number): Promise<void> {
  try {
    await shareApi.revoke(id);
    await loadShares();
    app.notify('已撤销分享', 'success');
  } catch (e) {
    app.notify(`撤销失败：${(e as Error).message}`, 'error');
  }
}

async function copy(): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(linkUrl.value);
    } else {
      const el = document.createElement('textarea');
      el.value = linkUrl.value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <NmModal :model-value="modelValue" title="分享与发布" :width="560" @update:model-value="emit('update:modelValue', $event)">
    <div class="share">
      <div class="seg">
        <button class="seg__item" :class="{ 'is-active': mode === 'link' }" @click="mode = 'link'">
          <NmIcon name="share" :size="14" /> 分享链接
        </button>
        <button class="seg__item" :class="{ 'is-active': mode === 'publish' }" @click="mode = 'publish'">
          <NmIcon name="globe" :size="14" /> 发布网页
        </button>
      </div>

      <template v-if="mode === 'link'">
        <p class="nm-hint">生成一个免登录链接，访客可阅读；开启评价后还能划词标注。</p>
        <div class="field field--row">
          <div>
            <label class="nm-label">允许访客评价与标注</label>
            <p class="nm-hint">关闭后链接只读</p>
          </div>
          <button class="toggle-btn" :class="{ 'is-on': allowComment }" @click="allowComment = !allowComment">
            {{ allowComment ? '开' : '关' }}
          </button>
        </div>
        <div class="field">
          <label class="nm-label">访问密码（留空表示免密公开访问）</label>
          <input
            v-model="accessCode"
            class="nm-input"
            maxlength="32"
            placeholder="例如：8866（可选，设置后访客需输入密码查看）"
          />
        </div>
        <div class="field">
          <label class="nm-label">有效期</label>
          <div class="seg seg--sm">
            <button
              v-for="d in [0, 1, 7, 30]"
              :key="d"
              class="seg__item"
              :class="{ 'is-active': expiresInDays === d }"
              @click="expiresInDays = d"
            >
              {{ d === 0 ? '长期' : `${d} 天` }}
            </button>
          </div>
        </div>
        <button class="nm-btn nm-btn--primary" :disabled="busy" @click="createLink">
          {{ busy ? '生成中…' : '生成分享链接' }}
        </button>
      </template>

      <template v-else>
        <p class="nm-hint">把文档渲染为静态网页并上传到对象存储，任何人都可以通过链接访问。</p>
        <div class="publish-info">
          <NmIcon name="globe" :size="15" />
          <span>发布地址形如 <code>{{ SITE_URL }}/p/&lt;slug&gt;</code></span>
        </div>
        <button class="nm-btn nm-btn--primary" :disabled="busy" @click="publishWeb">
          {{ busy ? '发布中…' : '发布为网页' }}
        </button>
      </template>

      <p v-if="errorText" class="error">{{ errorText }}</p>

      <div v-if="linkUrl" class="result">
        <label class="nm-label">链接</label>
        <div class="result__row">
          <input class="nm-input" :value="linkUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
          <button class="nm-btn" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <a class="result__open" :href="linkUrl" target="_blank" rel="noopener">
          在新窗口打开 <NmIcon name="external" :size="13" />
        </a>
      </div>

      <template v-if="auth.isLoggedIn && myShares.length">
        <div class="nm-divider" />
        <label class="nm-label">我的分享</label>
        <div class="shares nm-scroll">
          <div v-for="s in myShares" :key="s.id" class="share-row">
            <div class="share-row__body">
              <span class="share-row__title">{{ s.title }}</span>
              <span class="share-row__meta">{{ s.viewCount }} 次浏览 · {{ s.revokedAt ? '已撤销' : '有效' }}</span>
            </div>
            <a v-if="!s.revokedAt" class="share-row__open" :href="`/s/${s.token}`" target="_blank" rel="noopener">
              打开
            </a>
            <button v-if="!s.revokedAt" class="share-row__revoke" @click="revoke(s.id)">撤销</button>
          </div>
        </div>
      </template>

      <p v-if="!auth.isLoggedIn" class="nm-hint">
        当前未登录，分享与发布需要账号。也可以直接在本地把文档导出为 HTML 发送给对方。
      </p>
    </div>
    <template #footer>
      <button class="nm-btn" @click="emit('update:modelValue', false)">关闭</button>
    </template>
  </NmModal>
</template>

<style scoped>
.share {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  align-self: flex-start;
}
.seg--sm .seg__item {
  padding: 5px 10px;
  font-size: 12px;
}
.seg__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--fg-2);
}
.seg__item.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.field {
  margin: 0;
}
.field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.toggle-btn {
  min-width: 56px;
  height: 28px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 600;
  background: var(--bg-hover);
  color: var(--fg-3);
  border: 1px solid var(--border);
}
.toggle-btn.is-on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.publish-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-hover);
  font-size: 12.5px;
  color: var(--fg-2);
}
code {
  font-family: var(--font-mono);
  font-size: 0.94em;
}
.error {
  margin: 0;
  font-size: 12.5px;
  color: #d93025;
}
.result {
  margin-top: 4px;
  padding: 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
}
.result__row {
  display: flex;
  gap: 8px;
}
.result__open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
}
.shares {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}
.share-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
}
.share-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.share-row__title {
  font-size: 12.5px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-row__meta {
  font-size: 11px;
  color: var(--fg-3);
}
.share-row__open {
  font-size: 11.5px;
  color: var(--accent);
}
.share-row__revoke {
  font-size: 11.5px;
  color: #d93025;
}
</style>
