<script setup lang="ts">
/**
 * 后台 · 平台模型配置（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 这是「平台付费（扣积分）」的**唯一治理入口**，与「我的 AI 供应商（自带 Key）」
 * 彻底分离：这里管的是用户能用哪些模型、每个模型的参数上限、单价与系统提示词。
 *
 * 关键优先级（服务端 resolveModelSetting 实现，此处只展示结果）：
 *   模型级设置 > 供应商兜底系统提示词 > 内置默认值
 * 表格最后一列「提示词来源」就是让人一眼看出当前生效的是哪一层 ——
 * 运营最常犯的错是「在供应商级填了提示词，却在模型级留了旧值，导致改了没效果」。
 *
 * 绝不暴露 baseUrl / apiKey：接口本身就不返回，这里也没有对应字段。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { platformModelsApi, type AdminAiModelProviderDto, type AiModelLimitsDto, type ModelSettingDto } from '@/api/client';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const providers = ref<AdminAiModelProviderDto[]>([]);
const limits = ref<AiModelLimitsDto | null>(null);
const loading = ref(false);
const saving = ref('');
const expanded = ref<Record<string, boolean>>({});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await platformModelsApi.adminList();
    providers.value = res.providers.map((p) => ({ ...p, models: [...(p.models ?? [])] }));
    limits.value = res.limits;
  } catch (e) {
    emit('fail', `加载模型配置失败：${(e as Error).message}`);
  } finally {
    loading.value = false;
  }
}

/** 解析某模型生效提示词的来源（表格最后一列） */
function promptSource(p: AdminAiModelProviderDto, model: string): 'model' | 'provider' | 'none' {
  return p.resolved?.find((r) => r.model === model)?.systemPromptSource ?? 'none';
}

function promptSourceLabel(p: AdminAiModelProviderDto, model: string): string {
  const s = promptSource(p, model);
  return s === 'model' ? '模型级' : s === 'provider' ? '供应商兜底' : '未配置';
}

/**
 * 取（必要时初始化）某模型的编辑态。
 *
 * 初始值取服务端已保存的值；缺失时留空 = 用内置默认。
 * 注意 systemPrompt 只在**模型级已配置**时才回填，否则留空，
 * 避免把「供应商兜底值」误存成模型级值（那会让运营以为改了供应商级却没生效）。
 */
function settingOf(p: AdminAiModelProviderDto, model: string): ModelSettingDto {
  if (!p.modelSettings) p.modelSettings = {};
  if (!p.modelSettings[model]) {
    const saved = p.resolved?.find((r) => r.model === model);
    p.modelSettings[model] = {
      temperature: saved?.temperature,
      maxTokens: saved?.maxTokens,
      priceIn: saved?.priceIn,
      priceOut: saved?.priceOut,
      systemPrompt: saved?.systemPromptSource === 'model' ? saved.systemPrompt : '',
    };
  }
  return p.modelSettings[model]!;
}

/** 更新模型列表（逗号分隔 → 数组），并清理已移除模型的设置 */
function updateModelList(p: AdminAiModelProviderDto, raw: string): void {
  const list = raw
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  p.models = list;
  if (p.defaultModel && !list.includes(p.defaultModel)) p.defaultModel = '';
  if (p.modelSettings) {
    for (const key of Object.keys(p.modelSettings)) {
      if (!list.includes(key)) delete p.modelSettings[key];
    }
  }
}

async function saveProvider(p: AdminAiModelProviderDto): Promise<void> {
  saving.value = p.provider;
  try {
    // 只回传非空字段，空对象会被服务端归一为 NULL（回落内置默认）
    const settings: Record<string, ModelSettingDto> = {};
    for (const [model, s] of Object.entries(p.modelSettings ?? {})) {
      if (!p.models.includes(model)) continue;
      const item: ModelSettingDto = {};
      if (s.temperature !== undefined && s.temperature !== null) item.temperature = Number(s.temperature);
      if (s.maxTokens !== undefined && s.maxTokens !== null) item.maxTokens = Number(s.maxTokens);
      if (s.priceIn !== undefined && s.priceIn !== null) item.priceIn = Number(s.priceIn);
      if (s.priceOut !== undefined && s.priceOut !== null) item.priceOut = Number(s.priceOut);
      if (s.systemPrompt && String(s.systemPrompt).trim()) item.systemPrompt = String(s.systemPrompt).trim();
      if (Object.keys(item).length > 0) settings[model] = item;
    }

    await platformModelsApi.adminSave(p.provider, {
      models: p.models,
      defaultModel: p.defaultModel || '',
      systemPrompt: p.systemPrompt || '',
      modelSettings: settings,
    });
    emit('notify', `已保存「${p.name}」的模型配置，前台下次打开设置页即生效`);
    await load();
  } catch (e) {
    emit('fail', `保存失败：${(e as Error).message}`);
  } finally {
    saving.value = '';
  }
}

function toggle(provider: string): void {
  expanded.value[provider] = !expanded.value[provider];
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="aim">
    <header class="adm-page-head">
      <div>
        <h2>平台模型配置</h2>
        <p>
          这里配置的是<strong>平台付费统一管理</strong>的模型：用户在前台「平台 AI 服务」区块只看到模型名、价格与系统提示词，
          看不到供应商地址与密钥。模型列表决定「开放哪些模型」，每模型设置决定温度上限 / 最大 token / 输入输出积分单价，
          系统提示词会在用户调用对话与知识库问答时由服务端自动注入到消息最前面。
        </p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <p class="adm-note">
      <NmIcon name="info" :size="14" />
      <span>
        生效优先级：<strong>模型级设置 &gt; 供应商兜底系统提示词 &gt; 内置默认值</strong>。
        表格最后一列会显示当前提示词来自哪一层；若在供应商级改了提示词却没生效，请检查该模型是否还留着旧的模型级提示词。
        模型级提示词留空即回落到供应商兜底。
      </span>
    </p>

    <p v-if="loading && !providers.length" class="adm-empty">加载中…</p>

    <section v-for="p in providers" :key="p.provider" class="adm-card" style="margin-bottom: 18px;">
      <div class="adm-card__head">
        <div class="headline">
          <strong>{{ p.name }}</strong>
          <span class="adm-mono adm-muted">({{ p.provider }})</span>
          <span class="adm-badge" :class="p.apiKeySet ? 'adm-badge--ok' : 'adm-badge--warn'">
            {{ p.apiKeySet ? '密钥已配' : '未配密钥' }}
          </span>
          <span class="adm-badge" :class="p.enabled ? 'adm-badge--accent' : 'adm-badge--muted'">
            {{ p.enabled ? '参与代付调度' : '不参与调度' }}
          </span>
          <span class="adm-badge adm-badge--muted">{{ p.models.length }} 个模型</span>
        </div>
        <div class="adm-page-actions">
          <button class="adm-rowbtn" @click="toggle(p.provider)">
            {{ expanded[p.provider] ? '收起设置' : '展开设置' }}
          </button>
          <button
            class="nm-btn nm-btn--sm nm-btn--primary"
            :disabled="saving === p.provider"
            @click="saveProvider(p)"
          >
            {{ saving === p.provider ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>

      <div class="adm-card__body">
        <div class="cfg-grid">
          <div class="adm-field">
            <label class="nm-label">开放模型（逗号分隔）</label>
            <input
              :value="p.models.join(', ')"
              class="nm-input adm-mono"
              placeholder="deepseek-chat, deepseek-reasoner"
              aria-label="开放模型列表"
              @input="updateModelList(p, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="adm-field">
            <label class="nm-label">默认模型（前台预选）</label>
            <select v-model="p.defaultModel" class="nm-input" aria-label="默认模型">
              <option value="">（不设默认）</option>
              <option v-for="m in p.models" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="adm-field cfg-grid__wide">
            <label class="nm-label">供应商级系统提示词（模型未配时兜底）</label>
            <input
              v-model="p.systemPrompt"
              class="nm-input"
              placeholder="你是 Neo MD 的写作助手…"
              aria-label="供应商级系统提示词"
            />
          </div>
        </div>

        <!-- 每模型设置：默认收起，避免模型多时页面过长 -->
        <div v-if="expanded[p.provider]">
          <table class="adm-table adm-table--tight" style="margin-top: 16px;">
            <thead>
              <tr>
                <th>模型</th>
                <th style="width: 92px;">温度上限</th>
                <th style="width: 104px;">最大 tokens</th>
                <th style="width: 96px;">单价(入)</th>
                <th style="width: 96px;">单价(出)</th>
                <th>模型级系统提示词</th>
                <th style="width: 96px;">提示词来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in p.models" :key="m">
                <td class="adm-mono adm-strong">{{ m }}</td>
                <td>
                  <input
                    v-model.number="settingOf(p, m).temperature"
                    class="nm-input adm-mono"
                    type="number"
                    step="0.1"
                    :min="limits?.temperature.min ?? 0"
                    :max="limits?.temperature.max ?? 2"
                    aria-label="温度上限"
                  />
                </td>
                <td>
                  <input
                    v-model.number="settingOf(p, m).maxTokens"
                    class="nm-input adm-mono"
                    type="number"
                    :min="limits?.maxTokens.min ?? 1"
                    :max="limits?.maxTokens.max ?? 32768"
                    aria-label="最大 tokens"
                  />
                </td>
                <td>
                  <input
                    v-model.number="settingOf(p, m).priceIn"
                    class="nm-input adm-mono"
                    type="number"
                    min="0"
                    aria-label="输入单价"
                  />
                </td>
                <td>
                  <input
                    v-model.number="settingOf(p, m).priceOut"
                    class="nm-input adm-mono"
                    type="number"
                    min="0"
                    aria-label="输出单价"
                  />
                </td>
                <td>
                  <input
                    v-model="settingOf(p, m).systemPrompt"
                    class="nm-input"
                    placeholder="留空则用供应商兜底"
                    aria-label="模型级系统提示词"
                  />
                </td>
                <td>
                  <span
                    class="adm-badge"
                    :class="promptSource(p, m) === 'model' ? 'adm-badge--accent' : promptSource(p, m) === 'provider' ? 'adm-badge--muted' : 'adm-badge--warn'"
                  >
                    {{ promptSourceLabel(p, m) }}
                  </span>
                </td>
              </tr>
              <tr v-if="!p.models.length">
                <td colspan="7" class="adm-empty">该供应商还没有开放模型</td>
              </tr>
            </tbody>
          </table>
          <p class="nm-hint">
            单价单位为「积分 / 千 tokens」；留空表示用内置默认（入 {{ limits?.priceIn.default ?? 1 }} / 出
            {{ limits?.priceOut.default ?? 2 }}）。温度上限 {{ limits?.temperature.min ?? 0 }}~{{ limits?.temperature.max ?? 2 }}，
            最大 token {{ limits?.maxTokens.min ?? 1 }}~{{ limits?.maxTokens.max ?? 32768 }}。
          </p>
        </div>
      </div>
    </section>

    <p v-if="!loading && !providers.length" class="adm-empty">暂无供应商配置</p>
  </div>
</template>

<style scoped>
.headline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.headline strong { font-size: 14.5px; color: #1f2329; }
.cfg-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.cfg-grid__wide { grid-column: 1 / -1; }
@media (max-width: 900px) {
  .cfg-grid { grid-template-columns: 1fr; }
  .cfg-grid__wide { grid-column: auto; }
}
</style>
