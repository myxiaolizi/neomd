<script setup lang="ts">
/**
 * 后台 · AI 供应商（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 这一页只管**连接凭证与调度**：
 *  - 供应商的连接凭证（Base URL / 平台密钥）、调度优先级；
 *  - 客户端「我的 AI 供应商（自带 Key）」列表的展示配置（申请地址、说明、排序）。
 *
 * 模型列表、每模型设置与系统提示词在「平台模型配置」页（AdminAiModels.vue），
 * 两页刻意分开：改密钥风险高，改模型参数是高频运营动作，混在一起容易误改。
 *
 * 注意：前台**不再有「是否开通」概念**（1.1.9）。这里的 enabled 只表示
 * 「是否参与平台代付调度」，前台完全看不到，也不影响用户自带 Key 使用供应商。
 */
import { onMounted, ref } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { adminApiV2, aiProvidersApi } from '@/api/client';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

interface ProviderRow {
  provider: string;
  name: string;
  isCustom?: boolean;
  baseUrl: string;
  enabled: boolean;
  priority?: number;
  apiKeySet: boolean;
  models: string[];
  updatedAt?: string;
  signupUrl?: string;
  docsUrl?: string;
  note?: string;
  sortOrder?: number;
}

/** 展示配置的编辑态（含默认值，供「恢复默认」） */
interface MetaRow {
  provider: string;
  name: string;
  enabled: boolean;
  signupUrl: string;
  docsUrl: string;
  note: string;
  sortOrder: number;
  modelCount: number;
  apiKeySet: boolean;
  defaults: { signupUrl: string; docsUrl: string; note: string; sortOrder: number };
  dirty?: boolean;
}

interface EditState {
  isNew?: boolean;
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  priority: number;
  modelsStr: string;
  signupUrl: string;
  note: string;
  sortOrder: number;
}

const providers = ref<ProviderRow[]>([]);
const metaRows = ref<MetaRow[]>([]);
const loading = ref(false);
const metaLoading = ref(false);
const metaSaving = ref(false);
const edit = ref<EditState | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    providers.value = (await adminApiV2.ai()).providers as ProviderRow[];
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

/** 拉取展示配置（含默认值，供「恢复默认」使用） */
async function loadMeta(): Promise<void> {
  metaLoading.value = true;
  try {
    const res = await aiProvidersApi.meta();
    metaRows.value = res.providers.map((item) => ({
      provider: item.provider,
      name: item.name,
      enabled: item.enabled,
      signupUrl: item.signupUrl ?? '',
      docsUrl: item.docsUrl ?? '',
      note: item.note ?? '',
      sortOrder: Number(item.sortOrder ?? 100),
      modelCount: Number(item.modelCount ?? 0),
      apiKeySet: Boolean(item.apiKeySet),
      defaults: item.defaults,
      dirty: false,
    }));
  } catch (e) {
    emit('fail', `加载供应商列表配置失败：${(e as Error).message}`);
  } finally {
    metaLoading.value = false;
  }
}

/** 单行恢复默认值（仅改表单，仍需点保存） */
function resetMetaRow(row: MetaRow): void {
  row.signupUrl = row.defaults.signupUrl;
  row.docsUrl = row.defaults.docsUrl;
  row.note = row.defaults.note;
  row.sortOrder = row.defaults.sortOrder;
  row.dirty = true;
}

/** 批量保存展示配置：只提交有改动的行 */
async function saveMeta(): Promise<void> {
  const changed = metaRows.value.filter((row) => row.dirty);
  if (changed.length === 0) {
    emit('notify', '没有需要保存的修改');
    return;
  }
  metaSaving.value = true;
  try {
    await aiProvidersApi.saveMeta(
      changed.map((row) => ({
        provider: row.provider,
        enabled: row.enabled,
        signupUrl: row.signupUrl.trim(),
        docsUrl: row.docsUrl.trim(),
        note: row.note.trim(),
        sortOrder: Number(row.sortOrder) || 100,
      })),
    );
    emit('notify', `已保存 ${changed.length} 个供应商的展示配置，前台设置页下次打开即生效`);
    // 重新拉一次拿到服务端归一化后的值（空串会回落到默认值）
    await loadMeta();
    await load();
  } catch (e) {
    emit('fail', `保存失败：${(e as Error).message}`);
  } finally {
    metaSaving.value = false;
  }
}

function openEdit(p: ProviderRow): void {
  edit.value = {
    isNew: false,
    provider: p.provider,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    enabled: p.enabled,
    priority: p.priority ?? 100,
    modelsStr: (p.models ?? []).join(', '),
    signupUrl: p.signupUrl ?? '',
    note: p.note ?? '',
    sortOrder: p.sortOrder ?? 100,
  };
}

function openNew(): void {
  edit.value = {
    isNew: true,
    provider: '',
    name: '',
    baseUrl: 'https://',
    apiKey: '',
    enabled: true,
    priority: 100,
    modelsStr: '',
    signupUrl: '',
    note: '',
    sortOrder: 80,
  };
}

async function save(): Promise<void> {
  if (!edit.value) return;
  const providerId = edit.value.provider.trim();
  if (!providerId) {
    emit('fail', '请填写供应商唯一标识（如 openrouter）');
    return;
  }
  const models = edit.value.modelsStr
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body: Record<string, unknown> = {
    name: edit.value.name.trim() || providerId,
    baseUrl: edit.value.baseUrl.trim(),
    enabled: edit.value.enabled,
    priority: Number(edit.value.priority) || 100,
    models,
    signupUrl: edit.value.signupUrl.trim(),
    note: edit.value.note.trim(),
    sortOrder: Number(edit.value.sortOrder) || 100,
  };
  // 空字符串表示「保持原密钥不变」，绝不能把空值提交上去清掉密钥
  if (edit.value.apiKey) body.apiKey = edit.value.apiKey;
  try {
    await adminApiV2.saveAi(providerId, body);
    edit.value = null;
    await Promise.all([load(), loadMeta()]);
    emit('notify', 'AI 供应商配置已保存');
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

async function removeCustom(p: ProviderRow): Promise<void> {
  if (!p.isCustom) return;
  if (!window.confirm(`确认删除自定义供应商「${p.name} (${p.provider})」？`)) return;
  try {
    await adminApiV2.deleteAi(p.provider);
    await Promise.all([load(), loadMeta()]);
    emit('notify', `已删除自定义供应商「${p.name}」`);
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

onMounted(async () => {
  await Promise.all([load(), loadMeta()]);
});

defineExpose({ reload: async () => { await Promise.all([load(), loadMeta()]); } });
</script>

<template>
  <div class="aip">
    <header class="adm-page-head">
      <div>
        <h2>AI 供应商</h2>
        <p>
          管理供应商连接凭证与调度优先级（数字越小越优先，如 10 优先于 100）。支持新增自定义 [OI] 兼容供应商。
          开启「平台代付」并配置平台密钥后，该供应商下的模型才能被用户用平台积分调用。
        </p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm nm-btn--primary" @click="openNew">
          <NmIcon name="plus" :size="13" />新增供应商
        </button>
      </div>
    </header>

    <p class="adm-note">
      <NmIcon name="info" :size="14" />
      <span>
        前台<strong>只读展示可用供应商与模型</strong>，不展示任何启用状态徽章：用户自带 Key 时，
        无论这里是否启用代付，供应商都可正常选择使用。这里的开关只决定<strong>平台代付渠道是否参与调度</strong>。
        模型列表与每模型参数请到「平台模型配置」页。
      </span>
    </p>

    <table class="adm-table">
      <thead>
        <tr>
          <th>供应商</th>
          <th style="width: 96px;">优先级</th>
          <th>Base URL</th>
          <th style="width: 110px;">平台密钥</th>
          <th style="width: 130px;">代付调度</th>
          <th>支持模型</th>
          <th class="adm-right" style="width: 180px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in providers" :key="p.provider">
          <td>
            <span class="adm-strong">{{ p.name }}</span>
            <span class="adm-mono adm-muted" style="margin-left: 6px;">({{ p.provider }})</span>
            <span v-if="p.isCustom" class="adm-badge" style="margin-left: 6px;">自定义</span>
          </td>
          <td><span class="adm-badge adm-badge--accent">{{ p.priority ?? 100 }}</span></td>
          <td class="adm-mono adm-muted">{{ p.baseUrl }}</td>
          <td>
            <span class="adm-badge" :class="p.apiKeySet ? 'adm-badge--ok' : 'adm-badge--warn'">
              {{ p.apiKeySet ? '已配置' : '未配置' }}
            </span>
          </td>
          <td>
            <span class="adm-badge" :class="p.enabled ? 'adm-badge--ok' : 'adm-badge--muted'">
              {{ p.enabled ? '参与调度' : '不参与' }}
            </span>
          </td>
          <td class="adm-muted">{{ (p.models ?? []).slice(0, 4).join(', ') || '—' }}</td>
          <td class="adm-right">
            <button class="adm-rowbtn" @click="openEdit(p)">编辑供应商</button>
            <button v-if="p.isCustom" class="adm-rowbtn adm-rowbtn--danger" @click="removeCustom(p)">删除</button>
          </td>
        </tr>
        <tr v-if="!providers.length">
          <td colspan="7" class="adm-empty">{{ loading ? '加载中…' : '暂无供应商' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 客户端供应商列表展示配置 -->
    <section class="adm-card" style="margin-top: 26px;">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">客户端供应商列表配置</h3>
          <p class="adm-card__sub">
            配置前台「我的 AI 供应商（自带 Key）」列表的申请 Key 地址、说明文案与展示顺序。
            申请地址留空表示恢复内置默认值。
          </p>
        </div>
        <div class="adm-page-actions">
          <button
            class="nm-btn nm-btn--sm nm-btn--primary"
            :disabled="metaSaving || !metaRows.some((r) => r.dirty)"
            @click="saveMeta"
          >
            <NmIcon name="check" :size="13" />{{ metaSaving ? '保存中…' : '保存列表配置' }}
          </button>
        </div>
      </div>
      <div class="adm-card__body" style="padding-top: 6px;">
        <p v-if="metaLoading" class="adm-muted" style="font-size: 12.5px;">正在加载…</p>
        <table v-else class="adm-table adm-table--tight">
          <thead>
            <tr>
              <th style="width: 170px;">供应商</th>
              <th>申请地址（signupUrl）</th>
              <th>说明文案（note）</th>
              <th style="width: 110px;">展示排序</th>
              <th class="adm-right" style="width: 110px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in metaRows" :key="row.provider">
              <td>
                <div class="adm-strong">{{ row.name }}</div>
                <div class="adm-mono adm-muted" style="font-size: 11px;">{{ row.provider }}</div>
                <div class="adm-muted" style="font-size: 11px;">{{ row.modelCount }} 个模型</div>
              </td>
              <td>
                <input
                  v-model="row.signupUrl"
                  class="nm-input adm-mono"
                  :placeholder="row.defaults.signupUrl || 'https://…'"
                  aria-label="申请 Key 地址"
                  @input="row.dirty = true"
                />
                <div class="adm-muted" style="font-size: 11px; margin-top: 3px;">
                  默认：{{ row.defaults.signupUrl || '（无）' }}
                </div>
              </td>
              <td>
                <input
                  v-model="row.note"
                  class="nm-input"
                  :placeholder="row.defaults.note || '（使用内置说明）'"
                  aria-label="说明文案"
                  @input="row.dirty = true"
                />
              </td>
              <td>
                <input
                  v-model.number="row.sortOrder"
                  class="nm-input adm-mono"
                  type="number"
                  min="1"
                  max="9999"
                  aria-label="展示排序"
                  @input="row.dirty = true"
                />
              </td>
              <td class="adm-right">
                <button class="adm-rowbtn" title="恢复该行的内置默认值（仍需点保存）" @click="resetMetaRow(row)">
                  恢复默认
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <NmModal
      :model-value="Boolean(edit)"
      :title="edit?.isNew ? '新增 AI 供应商' : `配置供应商：${edit?.name ?? ''}`"
      :width="560"
      @update:model-value="edit = null"
    >
      <div v-if="edit">
        <template v-if="edit.isNew">
          <label class="nm-label">供应商唯一标识（英文/数字/短横线，如 openrouter）</label>
          <input v-model="edit.provider" class="nm-input adm-mono" placeholder="openrouter" />
        </template>
        <label class="nm-label" :class="{ mt: edit.isNew }">供应商名称</label>
        <input v-model="edit.name" class="nm-input" placeholder="例如：OpenRouter" />
        <label class="nm-label mt">Base URL（[OI] 兼容接口地址）</label>
        <input v-model="edit.baseUrl" class="nm-input adm-mono" placeholder="https://api.example.com/v1" />
        <label class="nm-label mt">平台统一 API Key（留空保持原密钥不变）</label>
        <input v-model="edit.apiKey" class="nm-input" type="password" placeholder="sk-…" />
        <div class="two-col mt">
          <div>
            <label class="nm-label">调度优先级（越小越优先）</label>
            <input v-model.number="edit.priority" class="nm-input" type="number" min="1" max="9999" />
          </div>
          <div>
            <label class="nm-label">客户端展示排序（升序）</label>
            <input v-model.number="edit.sortOrder" class="nm-input" type="number" min="1" max="9999" />
          </div>
        </div>
        <label class="nm-label mt">申请 Key 地址（signupUrl，可选）</label>
        <input v-model="edit.signupUrl" class="nm-input adm-mono" placeholder="https://…" />
        <label class="nm-label mt">说明文案（note，可选）</label>
        <input v-model="edit.note" class="nm-input" placeholder="[OI] 兼容接口说明…" />
        <label class="nm-label mt">该供应商支持的模型列表（逗号分隔）</label>
        <input v-model="edit.modelsStr" class="nm-input adm-mono" placeholder="deepseek-chat, mimo-v2.6-flash" />
        <label class="nm-label mt">参与平台代付调度（仅影响扣积分通道，不影响用户自带 Key）</label>
        <button class="toggle-btn" :class="{ 'is-on': edit.enabled }" @click="edit.enabled = !edit.enabled">
          {{ edit.enabled ? '参与调度' : '不参与' }}
        </button>
      </div>
      <template #footer>
        <button class="nm-btn" @click="edit = null">取消</button>
        <button class="nm-btn nm-btn--primary" @click="save">保存</button>
      </template>
    </NmModal>
  </div>
</template>

<style scoped>
.mt { margin-top: 14px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.toggle-btn {
  min-width: 88px;
  height: 30px;
  padding: 0 14px;
  border-radius: 15px;
  font-size: 12px;
  font-weight: 600;
  background: #f1f3f5;
  color: #6b7280;
  border: 1px solid #e5e7eb;
}
.toggle-btn.is-on { background: #1677ff; border-color: #1677ff; color: #fff; }
</style>
