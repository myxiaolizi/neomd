<script setup lang="ts">
/**
 * 配置中心（1.1.7 新增）。
 *
 * 直接读写 `platform_config` 键值表。设计取向：
 * - **值统一按字符串编辑**，多层 JSON 由管理员自己格式化，服务端不做结构假设，
 *   因此新增配置项不需要发版；
 * - 敏感键（名称含 secret/password/token/key 等）值由服务端打码为 •••••• 回传，
 *   保存时原样提交会被服务端跳过，避免把占位符写进库；
 * - 保存即写审计日志（`admin.config.update`）。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV3, type AdminConfigItem } from '@/api/client';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

/** 编辑态：key -> 草稿值 */
interface DraftRow {
  key: string;
  value: string;
  sensitive: boolean;
  updatedAt: string | null;
  /** 是否被修改过（用于只提交变更项） */
  dirty: boolean;
}

const rows = ref<DraftRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const filter = ref('');

/** 常用配置项的中文说明，便于管理员理解 key 的业务含义 */
const KEY_HINTS: Record<string, string> = {
  credit_per_yuan: '充值换算：1 元兑换多少积分',
  model_prices: '各模型的计费单价（JSON）',
  payment_methods: '可用的支付方式（JSON 数组）',
  signup_grant_credits: '注册赠送积分',
  daily_grant_credits: '每日签到赠送积分',
  register_enabled: '是否开放注册（true / false）',
  upload_max_bytes: '单文件上传上限（字节）',
  ai_max_tokens: '单次 AI 请求的最大输出 token',
  knowledge_max_chunks: '知识库检索的最大片段数',
};

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((r) => r.key.toLowerCase().includes(q));
});

const dirtyCount = computed(() => rows.value.filter((r) => r.dirty).length);

function hintOf(key: string): string {
  return KEY_HINTS[key] ?? '';
}

function fmtTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApiV3.config();
    rows.value = res.items.map((item: AdminConfigItem) => ({
      key: item.key,
      value: item.value,
      sensitive: item.sensitive,
      updatedAt: item.updatedAt,
      dirty: false,
    }));
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

function onEdit(row: DraftRow, e: Event): void {
  row.value = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
  row.dirty = true;
}

/** 校验 JSON 类配置，避免把坏 JSON 存进库 */
function jsonError(row: DraftRow): string {
  const text = row.value.trim();
  if (!text) return '';
  if (!text.startsWith('{') && !text.startsWith('[')) return '';
  try {
    JSON.parse(text);
    return '';
  } catch (e) {
    return `JSON 格式错误：${(e as Error).message}`;
  }
}

const hasJsonError = computed(() => rows.value.some((r) => r.dirty && jsonError(r) !== ''));

async function save(): Promise<void> {
  const changed = rows.value.filter((r) => r.dirty);
  if (changed.length === 0) {
    emit('notify', '没有需要保存的改动');
    return;
  }
  if (hasJsonError.value) {
    emit('fail', '存在 JSON 格式错误的配置项，请修正后再保存');
    return;
  }
  saving.value = true;
  try {
    const res = await adminApiV3.saveConfig(changed.map((r) => ({ key: r.key, value: r.value })));
    // 打码项会被服务端跳过，因此以返回值判实际写入数
    emit('notify', `已保存 ${res.updated} 项配置${res.updated < changed.length ? `（${changed.length - res.updated} 项因未修改被跳过）` : ''}`);
    await load();
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    saving.value = false;
  }
}

function revert(): void {
  void load();
  emit('notify', '已放弃未保存的改动');
}

onMounted(load);

defineExpose({ reload: load });
</script>

<template>
  <div class="config">
    <div class="ctoolbar">
      <input v-model="filter" class="nm-input ctoolbar__search" placeholder="按配置键搜索" />
      <span class="ctoolbar__count">
        共 {{ rows.length }} 项<template v-if="dirtyCount"> · <b>{{ dirtyCount }} 项待保存</b></template>
      </span>
      <div class="ctoolbar__actions">
        <button class="nm-btn nm-btn--sm" :disabled="saving || !dirtyCount" @click="revert">放弃改动</button>
        <button class="nm-btn nm-btn--sm nm-btn--primary" :disabled="saving || !dirtyCount" @click="save">
          <NmIcon name="check" :size="13" />{{ saving ? '保存中…' : '保存配置' }}
        </button>
      </div>
    </div>

    <p class="chint">
      <NmIcon name="info" :size="13" />
      配置值统一按文本保存；JSON 类配置（如计费单价）保存前会做格式校验。
      敏感项显示为 <code>••••••</code>，不修改则不会被覆盖。
    </p>

    <div v-if="loading && !rows.length" class="empty">加载中…</div>
    <div v-else-if="!filtered.length" class="empty">没有匹配的配置项</div>

    <div v-else class="clist">
      <article v-for="row in filtered" :key="row.key" class="crow" :class="{ 'is-dirty': row.dirty }">
        <header class="crow__head">
          <div class="crow__id">
            <code>{{ row.key }}</code>
            <span v-if="row.sensitive" class="crow__badge">敏感</span>
            <span v-if="row.dirty" class="crow__badge crow__badge--dirty">未保存</span>
          </div>
          <span class="crow__time">更新于 {{ fmtTime(row.updatedAt) }}</span>
        </header>
        <p v-if="hintOf(row.key)" class="crow__hint">{{ hintOf(row.key) }}</p>
        <!-- 多行：JSON 类配置用 textarea，其余用单行输入 -->
        <textarea
          v-if="row.value.length > 80 || row.value.trim().startsWith('{') || row.value.trim().startsWith('[')"
          class="nm-input crow__area"
          rows="5"
          spellcheck="false"
          :value="row.value"
          @input="onEdit(row, $event)"
        />
        <input
          v-else
          class="nm-input crow__input"
          spellcheck="false"
          :value="row.value"
          @input="onEdit(row, $event)"
        />
        <p v-if="row.dirty && jsonError(row)" class="crow__err">{{ jsonError(row) }}</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.config { display: flex; flex-direction: column; gap: 14px; }

.ctoolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ctoolbar__search { max-width: 260px; }
.ctoolbar__count { font-size: 12px; color: var(--fg-3); }
.ctoolbar__count b { color: var(--accent); }
.ctoolbar__actions { margin-left: auto; display: inline-flex; gap: 8px; }

.chint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--accent-weak-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-2);
}
.chint code {
  font-family: var(--font-mono);
  padding: 0 4px;
  border-radius: 3px;
  background: var(--bg-hover);
}

.clist { display: flex; flex-direction: column; gap: 10px; }
.crow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  transition: border-color 0.14s ease;
}
.crow.is-dirty { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
.crow__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.crow__id { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.crow__id code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
.crow__badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--fg-3);
  white-space: nowrap;
}
.crow__badge--dirty { background: var(--accent-weak); color: var(--accent); }
.crow__time { font-size: 10.5px; color: var(--fg-3); white-space: nowrap; }
.crow__hint { margin: 0; font-size: 12px; color: var(--fg-3); line-height: 1.6; }
.crow__input { max-width: 620px; }
.crow__area {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  resize: vertical;
  min-height: 96px;
}
.crow__err { margin: 0; font-size: 12px; color: #d93025; }

.empty { text-align: center; color: var(--fg-3); padding: 32px 12px; font-size: 12.5px; }

@media (max-width: 1000px) {
  .ctoolbar__actions { margin-left: 0; width: 100%; }
  .crow__input { max-width: 100%; }
}
</style>
