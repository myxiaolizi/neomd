<script setup lang="ts">
import { NmIcon } from '@neomd/ui';

export interface LinkItem {
  docId: string | null;
  title: string;
  path?: string;
  anchor?: string;
  kind: 'wikilink' | 'markdown' | 'embed' | 'unlinked';
}

defineProps<{ incoming: LinkItem[]; outgoing: LinkItem[]; unlinked: LinkItem[] }>();
const emit = defineEmits<{ open: [string] }>();

const KIND_LABEL: Record<string, string> = {
  wikilink: '内链',
  markdown: '链接',
  embed: '嵌入',
  unlinked: '提及',
};
</script>

<template>
  <div class="links">
    <section class="links__group">
      <header class="links__head">
        <NmIcon name="link" :size="13" />
        <span>反向链接</span>
        <span class="links__count">{{ incoming.length }}</span>
      </header>
      <p v-if="!incoming.length" class="links__empty">还没有其他笔记引用本篇。</p>
      <button v-for="(l, i) in incoming" :key="`in-${i}`" class="link-row" @click="l.docId && emit('open', l.docId)">
        <NmIcon name="file" :size="12" />
        <span class="link-row__title">{{ l.title }}</span>
        <span class="link-row__kind">{{ KIND_LABEL[l.kind] ?? l.kind }}</span>
      </button>
    </section>

    <section class="links__group">
      <header class="links__head">
        <NmIcon name="external" :size="13" />
        <span>出链</span>
        <span class="links__count">{{ outgoing.length }}</span>
      </header>
      <p v-if="!outgoing.length" class="links__empty">本篇还没有指向其他内容。</p>
      <button v-for="(l, i) in outgoing" :key="`out-${i}`" class="link-row" @click="l.docId && emit('open', l.docId)">
        <NmIcon :name="l.kind === 'markdown' ? 'globe' : 'file'" :size="12" />
        <span class="link-row__title">{{ l.title }}</span>
        <span class="link-row__kind" :class="{ 'is-missing': !l.docId && l.kind !== 'markdown' }">
          {{ l.docId ? KIND_LABEL[l.kind] : l.kind === 'markdown' ? '外部' : '未创建' }}
        </span>
      </button>
    </section>

    <section v-if="unlinked.length" class="links__group">
      <header class="links__head">
        <NmIcon name="alert" :size="13" />
        <span>未链接提及</span>
        <span class="links__count">{{ unlinked.length }}</span>
      </header>
      <button v-for="(l, i) in unlinked" :key="`un-${i}`" class="link-row" @click="l.docId && emit('open', l.docId)">
        <NmIcon name="file" :size="12" />
        <span class="link-row__title">{{ l.title }}</span>
        <span class="link-row__kind">{{ KIND_LABEL.unlinked }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.links {
  padding: 4px 4px 20px;
}
.links__group {
  margin-bottom: 14px;
}
.links__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.links__count {
  margin-left: auto;
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
}
.links__empty {
  margin: 4px 12px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--fg-3);
}
.link-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
}
.link-row:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.link-row__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-row__kind {
  font-size: 10px;
  color: var(--fg-3);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.link-row__kind.is-missing {
  color: var(--orange);
  background: var(--orange-weak);
}
</style>
