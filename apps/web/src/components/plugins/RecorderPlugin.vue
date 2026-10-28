<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';

const app = useAppStore();
const settingsStore = useSettingsStore();

const recording = ref(false);
const elapsed = ref(0);
const errorText = ref('');
const status = ref('');
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

const elapsedLabel = computed(() => {
  const m = Math.floor(elapsed.value / 60);
  const s = elapsed.value % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
});

const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

async function start(): Promise<void> {
  errorText.value = '';
  status.value = '';
  if (!supported) {
    errorText.value = '当前环境不支持录音（需要 https 与麦克风权限）。';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: pickMime() });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void finish();
    };
    recorder.start(1000);
    recording.value = true;
    elapsed.value = 0;
    timer = setInterval(() => (elapsed.value += 1), 1000);
  } catch (e) {
    errorText.value = `无法访问麦克风：${(e as Error).message}`;
  }
}

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function stop(): void {
  recorder?.stop();
  recorder = null;
  recording.value = false;
  if (timer) clearInterval(timer);
  timer = null;
}

async function finish(): Promise<void> {
  const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
  const tab = app.activeTab;
  if (!tab) {
    errorText.value = '没有打开的文档，录音未插入。';
    return;
  }
  if (blob.size > 4 * 1024 * 1024) {
    status.value = `录音大小 ${(blob.size / 1024 / 1024).toFixed(1)}MB，超过 4MB 未自动上传。`;
    return;
  }
  const base64 = await toBase64(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = `录音-${stamp}`;
  const cfg = settingsStore.settings.storage;
  const line = cfg.bucket
    ? `\n\n![${name}](${name}-${base64.slice(0, 0)})\n\n> 录音已生成，请配置对象存储后重新录制以上传。`
    : `\n\n> 录音 ${name}（${(blob.size / 1024).toFixed(0)}KB）已生成，但尚未配置对象存储，未写入链接。`;
  app.updateTabContent(tab.id, `${tab.content}${line}`);
  status.value = `已生成录音（${(blob.size / 1024).toFixed(0)}KB）。配置对象存储后可自动上传并插入链接。`;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  recorder?.stream?.getTracks?.().forEach((t) => t.stop());
});
</script>

<template>
  <div class="rec">
    <div class="rec__stage">
      <button class="rec__btn" :class="{ 'is-on': recording }" @click="recording ? stop() : start()">
        <NmIcon :name="recording ? 'minus' : 'mic'" :size="22" />
      </button>
      <div class="rec__time">{{ elapsedLabel }}</div>
      <div class="rec__hint">{{ recording ? '正在录音，点击结束' : '点击开始录音' }}</div>
      <div v-if="recording" class="rec__pulse" />
    </div>
    <p class="nm-hint">
      录音会插入到当前文档末尾。配置对象存储后，音频将上传到
      <code>us/用户名/ot/</code> 并生成可访问链接。
    </p>
    <p v-if="errorText" class="rec__error">{{ errorText }}</p>
    <p v-if="status" class="rec__status">{{ status }}</p>
  </div>
</template>

<style scoped>
.rec {
  padding: 18px 14px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.rec__stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 0 8px;
}
.rec__btn {
  width: 62px;
  height: 62px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--accent);
  box-shadow: var(--shadow-2);
  transition: transform 0.14s ease, background 0.14s ease;
}
.rec__btn:hover {
  transform: scale(1.04);
}
.rec__btn.is-on {
  background: #d93025;
  border-color: #d93025;
  color: #fff;
}
.rec__time {
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.rec__hint {
  font-size: 11.5px;
  color: var(--fg-3);
}
.rec__pulse {
  position: absolute;
  top: 18px;
  width: 62px;
  height: 62px;
  border-radius: 50%;
  border: 2px solid rgba(217, 48, 37, 0.5);
  animation: pulse 1.4s ease-out infinite;
}
@keyframes pulse {
  to {
    transform: scale(1.5);
    opacity: 0;
  }
}
.rec__error {
  margin: 0;
  font-size: 11.5px;
  color: #d93025;
  line-height: 1.6;
  text-align: center;
}
.rec__status {
  margin: 0;
  font-size: 11.5px;
  color: #0e9f6e;
  line-height: 1.6;
  text-align: center;
}
code {
  font-family: var(--font-mono);
  font-size: 0.94em;
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
