<script setup lang="ts">
/**
 * 后台 · 计费与赠送（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 三块内容：
 *  1. 积分兑换比例与自动赠送（注册赠送 / 每日登录赠送）；
 *  2. 每个模型的计费方式（按 tokens / 按次 / 免费）与多供应商优先级队列；
 *  3. 支付方式说明。
 *
 * 表格与 JSON 文本框**双向联动**：改表格会同步刷新 JSON，改 JSON 也会反向解析回表格。
 * 保留 JSON 是为了让运营能一次粘贴大量规则，但表格才是主要入口。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV2, type ModelPriceRule } from '@/api/client';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

interface EditableRule {
  model: string;
  mode: 'tokens' | 'request' | 'free';
  in: number;
  out: number;
  perCall: number;
  providersStr: string;
}

interface BillingPayload {
  creditPerYuan: number;
  signupGrantCredits: number;
  dailyGrantCredits: number;
  modelPrices: Record<string, ModelPriceRule>;
  paymentMethods: Array<{ id: string; name: string; note: string; enabled: boolean }>;
}

const billing = ref<BillingPayload | null>(null);
const rules = ref<EditableRule[]>([]);
const newModelName = ref('');
const pricesText = ref('');
const methodsText = ref('');
const loading = ref(false);
const saving = ref(false);

/** JSON 文本框的语法错误（为空表示没问题） */
const pricesError = computed(() => jsonError(pricesText.value));
const methodsError = computed(() => jsonError(methodsText.value));

function jsonError(text: string): string {
  const t = text.trim();
  if (!t) return '';
  try {
    JSON.parse(t);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** 表格 → JSON */
function syncRulesToPricesText(): void {
  const obj: Record<string, ModelPriceRule> = {};
  for (const r of rules.value) {
    const name = r.model.trim();
    if (!name) continue;
    obj[name] = {
      mode: r.mode,
      in: Number(r.in) || 0,
      out: Number(r.out) || 0,
      perCall: Number(r.perCall) || 0,
      providers: r.providersStr
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  pricesText.value = JSON.stringify(obj, null, 2);
}

/**
 * JSON → 表格（仅在 JSON 合法时执行）。
 * 用于「管理员直接粘贴一大段规则」的场景，避免表格与文本框长期不一致。
 */
function syncPricesTextToRules(): void {
  if (pricesError.value) return;
  let obj: Record<string, ModelPriceRule> = {};
  try {
    obj = JSON.parse(pricesText.value || '{}') as Record<string, ModelPriceRule>;
  } catch {
    return;
  }
  rules.value = Object.entries(obj).map(([model, rule]) => ({
    model,
    mode: rule.mode ?? 'tokens',
    in: Number(rule.in ?? 1),
    out: Number(rule.out ?? 2),
    perCall: Number(rule.perCall ?? 2),
    providersStr: (rule.providers ?? []).join(', '),
  }));
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const b = await adminApiV2.billing();
    billing.value = {
      creditPerYuan: b.creditPerYuan,
      signupGrantCredits: b.signupGrantCredits ?? 200,
      dailyGrantCredits: b.dailyGrantCredits ?? 20,
      modelPrices: b.modelPrices ?? {},
      paymentMethods: b.paymentMethods ?? [],
    };
    rules.value = Object.entries(b.modelPrices ?? {}).map(([m, rule]) => ({
      model: m,
      mode: rule.mode ?? 'tokens',
      in: Number(rule.in ?? 1),
      out: Number(rule.out ?? 2),
      perCall: Number(rule.perCall ?? 2),
      providersStr: (rule.providers ?? []).join(', '),
    }));
    pricesText.value = JSON.stringify(b.modelPrices ?? {}, null, 2);
    methodsText.value = JSON.stringify(b.paymentMethods ?? [], null, 2);
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

function addRule(): void {
  const m = newModelName.value.trim();
  if (!m) return;
  if (rules.value.some((x) => x.model === m)) {
    emit('fail', `模型 ${m} 已存在计费规则`);
    return;
  }
  rules.value.push({ model: m, mode: 'tokens', in: 1, out: 2, perCall: 2, providersStr: '' });
  newModelName.value = '';
  syncRulesToPricesText();
}

function removeRule(idx: number): void {
  rules.value.splice(idx, 1);
  syncRulesToPricesText();
}

async function save(): Promise<void> {
  if (!billing.value) return;
  if (pricesError.value) {
    emit('fail', `模型计费 JSON 格式错误：${pricesError.value}`);
    return;
  }
  if (methodsError.value) {
    emit('fail', `支付方式 JSON 格式错误：${methodsError.value}`);
    return;
  }
  saving.value = true;
  try {
    // 以 JSON 文本框为准（表格改动已实时同步进去，直接粘贴的 JSON 也能被保存）
    const modelPrices = JSON.parse(pricesText.value || '{}') as Record<string, ModelPriceRule>;
    const paymentMethods = JSON.parse(methodsText.value || '[]') as Array<{
      id: string;
      name: string;
      note: string;
      enabled: boolean;
    }>;
    await adminApiV2.saveBilling({
      creditPerYuan: billing.value.creditPerYuan,
      signupGrantCredits: billing.value.signupGrantCredits,
      dailyGrantCredits: billing.value.dailyGrantCredits,
      modelPrices,
      paymentMethods,
    });
    emit('notify', '计费规则、模型供应商优先级与积分赠送配置已保存');
    await load();
  } catch (e) {
    emit('fail', `保存失败：${(e as Error).message}`);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="bill">
    <header class="adm-page-head">
      <div>
        <h2>计费与赠送</h2>
        <p>
          积分兑换比例、注册与每日赠送、每个模型的计费方式与多供应商优先级队列。
          单价也会被「平台模型配置」里的每模型单价覆盖（模型级优先）。
        </p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm nm-btn--primary" :disabled="saving || !billing" @click="save">
          <NmIcon name="check" :size="13" />{{ saving ? '保存中…' : '保存全部配置' }}
        </button>
      </div>
    </header>

    <p v-if="loading && !billing" class="adm-empty">加载中…</p>

    <template v-if="billing">
      <section class="adm-card" style="margin-bottom: 22px;">
        <div class="adm-card__head">
          <div>
            <h3 class="adm-card__title">积分兑换与自动赠送</h3>
            <p class="adm-card__sub">填 0 表示不赠送</p>
          </div>
        </div>
        <div class="adm-card__body">
          <div class="three-col">
            <div class="adm-field">
              <label class="nm-label">充值兑换比例（1 元 = 多少积分）</label>
              <input v-model.number="billing.creditPerYuan" class="nm-input" type="number" min="1" />
            </div>
            <div class="adm-field">
              <label class="nm-label">新用户注册赠送积分</label>
              <input v-model.number="billing.signupGrantCredits" class="nm-input" type="number" min="0" />
            </div>
            <div class="adm-field">
              <label class="nm-label">每日首次登录赠送积分</label>
              <input v-model.number="billing.dailyGrantCredits" class="nm-input" type="number" min="0" />
            </div>
          </div>
        </div>
      </section>

      <section class="adm-card" style="margin-bottom: 22px;">
        <div class="adm-card__head">
          <div>
            <h3 class="adm-card__title">模型计费方式与供应商优先级</h3>
            <p class="adm-card__sub">
              支持按 Tokens / 按次固定 / 免费开放；供应商队列用逗号分隔，排在前面的优先调用。
            </p>
          </div>
        </div>
        <div class="adm-card__body" style="padding-top: 6px;">
          <table class="adm-table adm-table--tight">
            <thead>
              <tr>
                <th>模型标识</th>
                <th style="width: 160px;">计费方式</th>
                <th style="width: 120px;">输入单价</th>
                <th style="width: 120px;">输出单价</th>
                <th style="width: 130px;">按次扣费</th>
                <th>供应商优先级队列</th>
                <th class="adm-right" style="width: 80px;">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, idx) in rules" :key="r.model">
                <td class="adm-mono adm-strong">{{ r.model }}</td>
                <td>
                  <select v-model="r.mode" class="nm-input" @change="syncRulesToPricesText">
                    <option value="tokens">按 Tokens</option>
                    <option value="request">按次固定</option>
                    <option value="free">免费开放</option>
                  </select>
                </td>
                <td>
                  <input
                    v-model.number="r.in"
                    class="nm-input adm-mono"
                    type="number"
                    min="0"
                    :disabled="r.mode !== 'tokens'"
                    @input="syncRulesToPricesText"
                  />
                </td>
                <td>
                  <input
                    v-model.number="r.out"
                    class="nm-input adm-mono"
                    type="number"
                    min="0"
                    :disabled="r.mode !== 'tokens'"
                    @input="syncRulesToPricesText"
                  />
                </td>
                <td>
                  <input
                    v-model.number="r.perCall"
                    class="nm-input adm-mono"
                    type="number"
                    min="0"
                    :disabled="r.mode !== 'request'"
                    @input="syncRulesToPricesText"
                  />
                </td>
                <td>
                  <input
                    v-model="r.providersStr"
                    class="nm-input adm-mono"
                    placeholder="如 xiaomi-mimo, deepseek"
                    @input="syncRulesToPricesText"
                  />
                </td>
                <td class="adm-right">
                  <button class="adm-rowbtn adm-rowbtn--danger" @click="removeRule(idx)">移除</button>
                </td>
              </tr>
              <tr v-if="!rules.length">
                <td colspan="7" class="adm-empty">还没有模型计费规则</td>
              </tr>
            </tbody>
          </table>

          <div class="inline-add">
            <input
              v-model="newModelName"
              class="nm-input adm-mono"
              placeholder="新增模型名（如 deepseek-v3）"
              @keyup.enter="addRule"
            />
            <button class="nm-btn nm-btn--sm" @click="addRule">
              <NmIcon name="plus" :size="12" />添加规则
            </button>
          </div>

          <label class="nm-label mt">模型计费配置 JSON（高级编辑，与上方表格联动）</label>
          <textarea v-model="pricesText" class="nm-input adm-mono-area" rows="7" spellcheck="false" @blur="syncPricesTextToRules" />
          <p v-if="pricesError" class="err">JSON 格式错误：{{ pricesError }}</p>

          <label class="nm-label mt">支付方式说明（JSON 数组）</label>
          <textarea v-model="methodsText" class="nm-input adm-mono-area" rows="6" spellcheck="false" />
          <p v-if="methodsError" class="err">JSON 格式错误：{{ methodsError }}</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.three-col { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.inline-add { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.inline-add .nm-input { max-width: 320px; }
.mt { margin-top: 16px; }
.adm-mono-area {
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 12px;
  line-height: 1.65;
  resize: vertical;
}
.err { margin: 6px 0 0; font-size: 12px; color: #d93025; }
@media (max-width: 900px) {
  .three-col { grid-template-columns: 1fr; }
}
</style>
