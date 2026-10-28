<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NmIcon } from '@neomd/ui';
import { shareApi, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface Comment {
  id: number;
  authorName: string;
  body: string;
  createdAt: string;
  annotation?: { quote: string; selector: unknown } | null;
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const token = computed(() => String(route.params.token ?? ''));
const loading = ref(true);
const errorText = ref('');
const passwordRequired = ref(false);
const accessCodeInput = ref('');
const passwordError = ref('');

const title = ref('');
const html = ref('');
const allowComment = ref(true);
const createdAt = ref('');
const author = ref<{ username: string; nickname: string; avatarUrl: string | null } | null>(null);
const shareStyle = ref<{
  brandTitle?: string;
  brandSubtitle?: string;
  accentColor?: string;
  paperStyle?: 'white' | 'warm' | 'green' | 'dark';
  hideProductBrand?: boolean;
} | null>(null);
const comments = ref<Comment[]>([]);

const commentOpen = ref(false);
const authorName = ref('');
const body = ref('');
const submitting = ref(false);
const submitError = ref('');
const submitOk = ref(false);

const quote = ref('');
const selector = ref<unknown>(null);
const docRef = ref<HTMLElement | null>(null);
const floatingBtn = ref<{ x: number; y: number; text: string } | null>(null);

const headerBrandTitle = computed(() => {
  if (shareStyle.value?.brandTitle?.trim()) return shareStyle.value.brandTitle.trim();
  if (author.value?.nickname?.trim()) return `${author.value.nickname} 的知识分享`;
  return title.value || '文档分享';
});

const paperClass = computed(() => `paper--${shareStyle.value?.paperStyle || 'white'}`);

async function load(code?: string): Promise<void> {
  loading.value = true;
  errorText.value = '';
  passwordError.value = '';
  try {
    const data = await shareApi.getPublic(token.value, code);
    passwordRequired.value = false;
    title.value = data.title;
    // 分享页面的浏览器标题应为文件名称
    if (typeof document !== 'undefined' && data.title) {
      document.title = data.title;
    }
    html.value = data.html;
    allowComment.value = data.allowComment;
    createdAt.value = data.createdAt;
    author.value = data.author ?? null;
    shareStyle.value = data.shareStyle ?? null;
    comments.value = data.comments ?? [];
    void shareApi.view(token.value).catch(() => undefined);
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'SHARE_PASSWORD_REQUIRED' || e.code === 'SHARE_PASSWORD_INVALID')) {
      passwordRequired.value = true;
      if (e.code === 'SHARE_PASSWORD_INVALID') {
        passwordError.value = '访问密码不正确，请重新输入';
      }
    } else {
      errorText.value =
        e instanceof ApiError
          ? e.status === 404
            ? '这个分享链接不存在，或已被作者撤销。'
            : e.message
          : '加载失败，请稍后重试。';
    }
  } finally {
    loading.value = false;
  }
}

function submitPassword(): void {
  if (!accessCodeInput.value.trim()) {
    passwordError.value = '请输入访问密码';
    return;
  }
  void load(accessCodeInput.value.trim());
}

function selectionText(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  return sel.toString().trim().slice(0, 500);
}

function onDocMouseUp(): void {
  if (!allowComment.value) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      floatingBtn.value = null;
      return;
    }
    const text = sel.toString().trim().slice(0, 500);
    if (!text || !docRef.value || !docRef.value.contains(sel.anchorNode)) {
      floatingBtn.value = null;
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    floatingBtn.value = {
      x: Math.max(16, Math.min(window.innerWidth - 150, rect.left + rect.width / 2 - 60)),
      y: Math.max(12, rect.top - 42),
      text,
    };
  }, 20);
}

function openCommentWithSelection(): void {
  quote.value = floatingBtn.value?.text || selectionText();
  selector.value = quote.value ? { quote: quote.value } : null;
  floatingBtn.value = null;
  submitOk.value = false;
  submitError.value = '';
  commentOpen.value = true;
}

function openComment(): void {
  quote.value = selectionText();
  selector.value = quote.value ? { quote: quote.value } : null;
  submitOk.value = false;
  submitError.value = '';
  commentOpen.value = true;
}

async function submit(): Promise<void> {
  if (!authorName.value.trim() || !body.value.trim()) {
    submitError.value = '请填写昵称与评论内容';
    return;
  }
  submitting.value = true;
  submitError.value = '';
  try {
    await shareApi.addComment(token.value, {
      authorName: authorName.value.trim().slice(0, 40),
      body: body.value.trim().slice(0, 2000),
      annotation: quote.value ? { quote: quote.value, selector: selector.value } : null,
    });
    body.value = '';
    quote.value = '';
    submitOk.value = true;
    await load(accessCodeInput.value.trim() || undefined);
    setTimeout(() => (commentOpen.value = false), 800);
  } catch (e) {
    submitError.value = e instanceof ApiError ? e.message : '提交失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

onMounted(() => {
  document.addEventListener('mouseup', onDocMouseUp);
  void load();
});

onBeforeUnmount(() => {
  document.removeEventListener('mouseup', onDocMouseUp);
});
</script>

<template>
  <div class="share-page" :class="paperClass">
    <header class="share-nav">
      <div class="brand">
        <span v-if="author?.avatarUrl" class="brand__avatar">
          <img :src="author.avatarUrl" alt="" />
        </span>
        <span v-else class="mark">{{ headerBrandTitle.slice(0, 1).toUpperCase() }}</span>
        <div class="brand__titles">
          <strong>{{ headerBrandTitle }}</strong>
          <span v-if="shareStyle?.brandSubtitle" class="brand__sub">{{ shareStyle.brandSubtitle }}</span>
        </div>
      </div>
      <div class="share-nav__right">
        <span v-if="createdAt" class="share-nav__meta">{{ formatTime(createdAt) }}</span>
        <button v-if="allowComment && !passwordRequired && !errorText" class="nm-btn nm-btn--primary nm-btn--sm" @click="openComment">
          <NmIcon name="edit" :size="13" />
          写评论
        </button>
      </div>
    </header>

    <main class="share-main">
      <div v-if="loading" class="share-state">正在加载文档…</div>

      <!-- 密码验证框 -->
      <div v-else-if="passwordRequired" class="share-passbox">
        <div class="passcard">
          <NmIcon name="lock" :size="28" />
          <h2>该分享受访问密码保护</h2>
          <p>请输入作者设置的访问密码以查看文档内容。</p>
          <input
            v-model="accessCodeInput"
            type="password"
            class="nm-input"
            placeholder="输入访问密码…"
            autofocus
            @keyup.enter="submitPassword"
          />
          <p v-if="passwordError" class="passcard__err">{{ passwordError }}</p>
          <button class="nm-btn nm-btn--primary" style="width: 100%; margin-top: 10px;" @click="submitPassword">
            验证并查看文档
          </button>
        </div>
      </div>

      <div v-else-if="errorText" class="share-state">
        <NmIcon name="alert" :size="26" />
        <p>{{ errorText }}</p>
      </div>

      <template v-else>
        <article class="share-doc">
          <header class="share-doc__head">
            <h1 class="share-doc__title">{{ title }}</h1>
            <div v-if="allowComment" class="share-doc__tip">
              <NmIcon name="info" :size="13" />
              鼠标划选正文任意一段文字，即可对该段文字发表划词评论
            </div>
          </header>
          <div ref="docRef" class="nm-content share-doc__body" v-html="html" />
        </article>

        <section class="share-comments">
          <header class="share-comments__head">
            <h2>读者评论与划词批注<span class="count">{{ comments.length }}</span></h2>
            <button v-if="allowComment" class="nm-btn nm-btn--primary nm-btn--sm" @click="openComment">
              <NmIcon name="edit" :size="13" />
              发表评论
            </button>
            <span v-else class="share-comments__off">作者已关闭评论</span>
          </header>

          <p v-if="!comments.length" class="share-comments__empty">还没有评论，选中上方正文段落即可针对特定文字发表见解。</p>

          <div v-for="c in comments" :key="c.id" class="comment">
            <div class="comment__avatar">{{ c.authorName.slice(0, 1).toUpperCase() }}</div>
            <div class="comment__body">
              <div class="comment__head">
                <span class="comment__name">{{ c.authorName }}</span>
                <span class="comment__time">{{ formatTime(c.createdAt) }}</span>
              </div>
              <blockquote v-if="c.annotation?.quote" class="comment__quote">
                引用原文：「{{ c.annotation.quote }}」
              </blockquote>
              <p class="comment__text">{{ c.body }}</p>
            </div>
          </div>
        </section>
      </template>
    </main>

    <!-- 选中一段文字时浮现的快捷「评论此段文字」按钮 -->
    <Teleport to="body">
      <button
        v-if="floatingBtn"
        class="selection-pop"
        :style="{ left: `${floatingBtn.x}px`, top: `${floatingBtn.y}px` }"
        @mousedown.prevent.stop="openCommentWithSelection"
      >
        <NmIcon name="edit" :size="13" />
        <span>评论所选文字</span>
      </button>
    </Teleport>

    <footer v-if="!shareStyle?.hideProductBrand" class="share-foot">
      由 <button class="link" @click="router.push('/')">Neo MD</button> 提供技术支持
    </footer>

    <Teleport to="body">
      <div v-if="commentOpen" class="sheet-mask" @mousedown.self="commentOpen = false">
        <div class="sheet">
          <header class="sheet__head">
            <h3>{{ quote ? '对所选文字发表评论' : '发表评论' }}</h3>
            <button class="sheet__close" @click="commentOpen = false"><NmIcon name="close" :size="16" /></button>
          </header>
          <div class="sheet__body">
            <blockquote v-if="quote" class="sheet__quote">
              <strong>所选原文：</strong>「{{ quote }}」
            </blockquote>
            <label class="nm-label">您的昵称</label>
            <input v-model="authorName" class="nm-input" maxlength="40" placeholder="例如：读者 / 同事" />
            <label class="nm-label mt">评论内容</label>
            <textarea v-model="body" class="nm-input" rows="4" maxlength="2000" placeholder="写下您的想法或批注意见…" />
            <p v-if="submitError" class="sheet__error">{{ submitError }}</p>
            <p v-if="submitOk" class="sheet__ok">已提交评论</p>
          </div>
          <footer class="sheet__foot">
            <button class="nm-btn" @click="commentOpen = false">取消</button>
            <button class="nm-btn nm-btn--primary" :disabled="submitting" @click="submit">
              {{ submitting ? '提交中…' : '提交评论' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.share-page {
  min-height: 100%;
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
  display: flex;
  flex-direction: column;
}
.share-page.paper--warm {
  background: #fbf8f1;
}
.share-page.paper--warm .share-doc {
  background: #fffdf7;
}
.share-page.paper--green {
  background: #e8f5e9;
}
.share-page.paper--green .share-doc {
  background: #f1f8f2;
  color: #1b3a24;
}
.share-page.paper--dark {
  background: #111318;
  color: #e5e7eb;
}
.share-page.paper--dark .share-doc,
.share-page.paper--dark .share-comments {
  background: #181b22;
  border-color: #2a2f3a;
  color: #e5e7eb;
}
.share-nav {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: var(--fg);
}
.brand__avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
}
.brand__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.brand__titles {
  display: flex;
  flex-direction: column;
}
.brand__sub {
  font-size: 11px;
  color: var(--fg-3);
}
.mark {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}
.share-nav__right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.share-nav__meta {
  font-size: 11.5px;
  color: var(--fg-3);
}
.share-main {
  flex: 1;
  width: 100%;
  max-width: 840px;
  margin: 0 auto;
  padding: 32px 22px 60px;
}
.share-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 80px 20px;
  color: var(--fg-3);
  font-size: 13.5px;
  text-align: center;
}
.share-passbox {
  display: grid;
  place-items: center;
  padding: 60px 16px;
}
.passcard {
  width: 100%;
  max-width: 380px;
  padding: 28px 24px;
  border-radius: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  text-align: center;
}
.passcard h2 {
  margin: 12px 0 6px;
  font-size: 17px;
}
.passcard p {
  margin: 0 0 16px;
  font-size: 12.5px;
  color: var(--fg-3);
}
.passcard__err {
  color: #d93025 !important;
  margin-top: 8px !important;
}
.share-doc {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 32px 34px 40px;
  box-shadow: var(--shadow-1);
}
.share-doc__title {
  margin: 0 0 8px;
  font-size: 26px;
  letter-spacing: -0.02em;
  line-height: 1.3;
}
.share-doc__tip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--accent);
  background: var(--accent-weak-2);
  padding: 4px 10px;
  border-radius: 6px;
  margin-bottom: 14px;
}
.share-doc__body {
  padding-top: 8px;
}
.selection-pop {
  position: fixed;
  z-index: 9500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: 0 6px 20px rgba(22, 119, 255, 0.36);
}
.share-comments {
  margin-top: 26px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px 24px 24px;
}
.share-comments__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.share-comments__head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  flex: 1;
}
.count {
  margin-left: 8px;
  font-size: 11.5px;
  color: var(--fg-3);
}
.share-comments__off,
.share-comments__empty {
  font-size: 12.5px;
  color: var(--fg-3);
}
.comment {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.comment__avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  flex: 0 0 auto;
}
.comment__body {
  flex: 1;
  min-width: 0;
}
.comment__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.comment__name {
  font-size: 13px;
  font-weight: 600;
}
.comment__time {
  font-size: 11px;
  color: var(--fg-3);
}
.comment__quote {
  margin: 4px 0 6px;
  padding: 6px 10px;
  border-left: 3px solid var(--accent);
  background: var(--accent-weak-2);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--fg-2);
}
.comment__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
}
.share-foot {
  text-align: center;
  padding: 18px;
  font-size: 12px;
  color: var(--fg-3);
}
.link {
  color: var(--accent);
  font-weight: 600;
}
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(15, 23, 42, 0.44);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: 20px;
}
.sheet {
  width: 100%;
  max-width: 460px;
  border-radius: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.sheet__head h3 {
  margin: 0;
  font-size: 15px;
}
.sheet__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
}
.sheet__body {
  padding: 16px 18px;
}
.sheet__quote {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-left: 3px solid var(--accent);
  background: var(--accent-weak-2);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--fg-2);
}
.mt {
  margin-top: 12px;
}
.sheet__error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #d93025;
}
.sheet__ok {
  margin: 8px 0 0;
  font-size: 12px;
  color: #16a34a;
}
.sheet__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-sidebar);
}
</style>
