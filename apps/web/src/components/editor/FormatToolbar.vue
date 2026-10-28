<script setup lang="ts">
import { NmIcon } from '@neomd/ui';

const emit = defineEmits<{
  cmd: [string, string?];
}>();

const GROUPS: Array<Array<{ id: string; icon: string; title: string; arg?: string }>> = [
  [
    { id: 'undo', icon: 'restore', title: '撤销 Ctrl+Z' },
    { id: 'redo', icon: 'refresh', title: '重做 Ctrl+Shift+Z' },
  ],
  [
    { id: 'h1', icon: 'heading', title: '一级标题 Ctrl+1', arg: '1' },
    { id: 'h2', icon: 'heading', title: '二级标题 Ctrl+2', arg: '2' },
    { id: 'h3', icon: 'heading', title: '三级标题 Ctrl+3', arg: '3' },
  ],
  [
    { id: 'bold', icon: 'bold', title: '加粗 Ctrl+B' },
    { id: 'italic', icon: 'italic', title: '斜体 Ctrl+I' },
    { id: 'underline', icon: 'underline', title: '下划线 Ctrl+U' },
    { id: 'strike', icon: 'strike', title: '删除线 Ctrl+Shift+X' },
    { id: 'highlight', icon: 'highlighter', title: '高亮 Ctrl+Shift+H' },
    { id: 'code', icon: 'code', title: '行内代码 Ctrl+E' },
  ],
  [
    { id: 'ul', icon: 'list', title: '无序列表 Ctrl+Shift+8' },
    { id: 'ol', icon: 'outline', title: '有序列表 Ctrl+Shift+9' },
    { id: 'task', icon: 'check', title: '任务列表 Ctrl+Shift+T' },
    { id: 'quote', icon: 'quote', title: '引用 Ctrl+Shift+Q' },
  ],
  [
    { id: 'table', icon: 'table', title: '插入表格 Ctrl+Shift+M' },
    { id: 'link', icon: 'link', title: '插入链接 Ctrl+K' },
    { id: 'image', icon: 'image', title: '插入图片' },
    { id: 'codeblock', icon: 'codeBlock', title: '代码块 Ctrl+Shift+E' },
    { id: 'hr', icon: 'hr', title: '分隔线 Ctrl+Shift+-' },
  ],
];
</script>

<template>
  <div class="fmtbar">
    <template v-for="(group, gi) in GROUPS" :key="gi">
      <span v-if="gi > 0" class="fmtbar__sep" />
      <button
        v-for="b in group"
        :key="b.id"
        class="fmt"
        :title="b.title"
        @mousedown.prevent="emit('cmd', b.id, b.arg)"
      >
        <NmIcon :name="b.icon" :size="15" />
      </button>
    </template>
    <span class="fmtbar__sep" />
    <button class="fmt" title="更多命令 Ctrl+P" @mousedown.prevent="emit('cmd', 'palette')">
      <NmIcon name="more" :size="15" />
    </button>
  </div>
</template>

<style scoped>
.fmtbar {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
  overflow-x: auto;
  scrollbar-width: none;
}
.fmtbar::-webkit-scrollbar {
  display: none;
}
.fmt {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
  flex: 0 0 auto;
}
.fmt:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.fmtbar__sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 5px;
  flex: 0 0 auto;
}
</style>
