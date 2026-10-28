<script setup lang="ts">
import { ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { markdownToPlainText } from '@neomd/core';
import { useAppStore } from '@/stores/app';

const app = useAppStore();
const url = ref('https://example.com');
const current = ref('');
const loading = ref(false);
const errorText = ref('');
const extracted = ref('');
const frameKey = ref(0);

const QUICK = [
  { name: '百度', url: 'https://www.baidu.com' },
  { name: '维基百科', url: 'https://zh.wikipedia.org' },
  { name: 'MDN', url: 'https://developer.mozilla.org' },
  { name: 'GitHub', url: 'https://github.com' },
];

function go(target?: string): void {
  const next = (target ?? url.value).trim();
  if (!next) return;
  const withScheme = /^https?:\/\//.test(next) ? next : `https://${next}`;
  url.value = withScheme;
  current.value = withScheme;
  errorText.value = '';
  extracted.value = '';
  loading.value = true;
  frameKey.value += 1;
  setTimeout(() => (loading.value = false), 900);
}

async function extract(): Promise<void> {
  errorText.value = '';
  try {
    const frame = document.querySelector<HTMLIFrameElement>('.browser__frame');
    const doc = frame?.contentDocument;
    const text = doc?.body?.innerText ?? '';
    if (!text.trim()) {
      errorText.value = '该站点禁止嵌入，无法读取正文。可复制链接后在桌面端浏览器插件中打开。';
      return;
    }
    extracted.value = text.slice(0, 4000);
  } catch {
    errorText.value = '受同源策略限制，无法读取页面内容。';
  }
}

function insertAsNote(): void {
  if (!extracted.value) return;
  const title = current.value.replace(/^https?:\/\//, '').split('/')[0] ?? '网页摘录';
  const body = `# ${title}\n\n> 来源：${current.value}\n\n${extracted.value}`;
  void app.createDoc({ title: `网页摘录-${title}`, content: body });
  void markdownToPlainText;
}
</script>

<template>
  <div class="browser">
    <div class="browser__bar">
      <NmIcon name="globe" :size="13" />
      <input v-model="url" class="browser__input" placeholder="输入网址后回车" @keyup.enter="go()" />
      <button class="tool" title="打开" @click="go()"><NmIcon name="chevronRight" :size="14" /></button>
    </div>
    <div class="browser__quick">
      <button v-for="q in QUICK" :key="q.url" class="chip" @click="go(q.url)">{{ q.name }}</button>
    </div>
    <div class="browser__stage">
      <iframe
        v-if="current"
        :key="frameKey"
        class="browser__frame"
        :src="current"
        referrerpolicy="no-referrer"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      />
      <div v-else class="browser__empty">
        <NmIcon name="globe" :size="22" />
        <p>输入网址即可内嵌浏览</p>
        <span>多数站点会通过 X-Frame-Options 拒绝嵌入，此时可在桌面端用系统浏览器打开。</span>
      </div>
      <div v-if="loading" class="browser__loading">加载中…</div>
    </div>
    <div class="browser__foot">
      <button class="nm-btn nm-btn--sm" :disabled="!current" @click="extract">提取正文</button>
      <button class="nm-btn nm-btn--sm nm-btn--primary" :disabled="!extracted" @click="insertAsNote">存为笔记</button>
    </div>
    <p v-if="errorText" class="browser__error">{{ errorText }}</p>
    <pre v-if="extracted" class="browser__extract nm-scroll">{{ extracted }}</pre>
  </div>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.browser__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-3);
  flex: 0 0 auto;
}
.browser__input {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  font-size: 11.5px;
  color: var(--fg);
  outline: none;
  min-width: 0;
}
.browser__input:focus {
  border-color: var(--accent);
}
.tool {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.tool:hover {
  background: var(--bg-hover);
}
.browser__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  flex: 0 0 auto;
}
.chip {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--fg-2);
}
.chip:hover {
  background: var(--accent-weak);
  color: var(--accent);
}
.browser__stage {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.browser__frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.browser__empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px;
  text-align: center;
  color: var(--fg-3);
}
.browser__empty p {
  margin: 0;
  font-size: 12.5px;
  color: var(--fg-2);
}
.browser__empty span {
  font-size: 11px;
  line-height: 1.7;
}
.browser__loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--bg);
  font-size: 12px;
  color: var(--fg-3);
}
.browser__foot {
  display: flex;
  gap: 6px;
  padding: 7px 8px;
  flex: 0 0 auto;
}
.browser__error {
  margin: 0;
  padding: 0 10px 8px;
  font-size: 11px;
  color: #d93025;
  line-height: 1.6;
}
.browser__extract {
  margin: 0 8px 10px;
  max-height: 160px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--bg-hover);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
