<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number | string;
    stroke?: number;
    fill?: boolean;
  }>(),
  { size: 18, stroke: 1.7, fill: false },
);

const PATHS: Record<string, string> = {
  // 通用
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  chevronRight: 'm9 18 6-6-6-6',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm18 15-6-6-6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderOpen: 'M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1H7l-4 8V7z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  sync: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2 M21 3v6h-6 M3 21v-6h6',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  cloudCheck:
    'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z M9 14l2 2 4-4',
  cloudOff: 'M22.6 16.9A5 5 0 0 0 18 10h-1.26A8 8 0 0 0 5 9 M3 3l18 18',
  history: 'M3 3v5h5 M3.05 13A9 9 0 1 0 6 5.3L3 8 M12 7v5l4 2',
  trash: 'M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
  command: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  sparkles:
    'M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  layers: 'm12 2 9 5-9 5-9-5z M3 12l9 5 9-5 M3 17l9 5 9-5',
  tag: 'M20.6 13.4 12 22l-9-9V4h9z M7.5 7.5h.01',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  graph: 'M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M5 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10.5 9.5 6.5 15 M13.5 9.5 17.5 15',
  outline: 'M4 6h10 M4 12h16 M4 18h7',
  slides: 'M3 4h18v11H3z M8 20h8 M12 15v5',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  calendar: 'M3 5h18v16H3z M8 3v4 M16 3v4 M3 10h18',
  table: 'M3 5h18v14H3z M3 10h18 M9 5v14 M15 5v14',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3.5 3 14 0 18',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 12a7 7 0 0 0 14 0 M12 19v3',
  dice: 'M4 4h16v16H4z M8.5 8.5h.01 M15.5 8.5h.01 M12 12h.01 M8.5 15.5h.01 M15.5 15.5h.01',
  restore: 'M4 12a8 8 0 1 0 3-6.2 M4 4v5h5',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  columns: 'M3 4h18v16H3z M12 4v16',
  type: 'M4 7V5h16v2 M12 5v14 M9 19h6',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  image: 'M3 5h18v14H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  mail: 'M4 4h16v16H4z M4 6l8 6 8-6',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3m-3-3 2.5-2.5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  alert: 'M12 8v5 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  drag: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
  layout: 'M3 4h18v16H3z M3 9h18',
  panelRight: 'M3 4h18v16H3z M15 4v16',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  more: 'M12 6h.01 M12 12h.01 M12 18h.01',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  // 排序：上下双箭头（区别于漏斗形状的 filter）
  sort: 'M7 4v16 M3 8l4-4 4 4 M17 20V4 M21 16l-4 4-4-4',
  // 统计：柱状图
  chart: 'M3 3v18h18 M7 15v3 M12 10v8 M17 6v12',
  footnote: 'M4 19V5 M4 12h9 M9 5v14',
  quote: 'M9 11H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8a3 3 0 0 1-3 3 M20 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8a3 3 0 0 1-3 3',
  bold: 'M6 4h8a4 4 0 0 1 0 8H6z M6 12h9a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9 M14 20H5 M15 4 9 20',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4 M4 21h16',
  strike: 'M16 4H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H6 M4 12h16',
  highlighter: 'M9 11l-6 6v3h3l6-6 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z',
  code: 'm16 18 6-6-6-6 M8 6l-6 6 6 6',
  codeBlock: 'M4 4h16v16H4z M9 9l-2 3 2 3 M15 9l2 3-2 3',
  heading: 'M6 4v16 M18 4v16 M6 12h12',
  table2: 'M3 5h18v14H3z M3 10h18 M9 5v14',
  hr: 'M4 12h16',
  palette: 'M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 2-1.5 3-3.5 3H16a2 2 0 0 0-1.6 3.2c.4.6.1 1.8-2.4 1.8z M7.5 11h.01 M10 7.5h.01 M14.5 7.5h.01',
  width: 'M3 4v16 M21 4v16 M7 12h10 M7 12l2-2 M7 12l2 2 M17 12l-2-2 M17 12l-2 2',
  refresh: 'M23 4v6h-6 M1 20v-6h6 M3.5 9a9 9 0 0 1 14.9-3.4L23 10 M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  wifi: 'M5 12.5a10 10 0 0 1 14 0 M8.5 16a5.5 5.5 0 0 1 7 0 M12 19.5h.01 M1.5 9a15 15 0 0 1 21 0',
  copy: 'M9 9h11v11H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2 2 9.3l6.9-1z',
  creditCard: 'M2 6h20v13H2z M2 10h20 M6 15h4',
  coins: 'M9 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M15 20a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  gift: 'M20 12v9H4v-9 M2 8h20v4H2z M12 21V8 M12 8a3 3 0 1 0-3-3c0 2 1.5 3 3 3z M12 8a3 3 0 1 1 3-3c0 2-1.5 3-3 3z',
  ticket: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4z M9 6v10',
  server: 'M4 4h16v6H4z M4 14h16v6H4z M7 7h.01 M7 17h.01',
  bill: 'M4 3h16v18l-4-3-4 3-4-3-4 3z M8 8h8 M8 12h8',
  upload2: 'M12 17V5 M7 10l5-5 5 5 M4 21h16',
  refresh2: 'M21 2v6h-6 M3 22v-6h6 M3.5 9a9 9 0 0 1 15-3.3L21 8 M21 15a9 9 0 0 1-15 3.3L3 16',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M5.6 5.6l12.8 12.8',
  wallet: 'M20 7H4a2 2 0 0 0 0 4h16v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14 M17 13h.01',
  hdd: 'M3 12h18 M5 12l2-7h10l2 7 M6 16h.01 M10 16h.01 M5 19h14a2 2 0 0 0 2-2v-3H3v3a2 2 0 0 0 2 2z',
};

const d = computed(() => PATHS[props.name] ?? PATHS.info!);
const px = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <svg
    :width="px"
    :height="px"
    viewBox="0 0 24 24"
    :fill="fill ? 'currentColor' : 'none'"
    :stroke="fill ? 'none' : 'currentColor'"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="nm-icon"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.nm-icon {
  flex: 0 0 auto;
  display: block;
}
</style>
