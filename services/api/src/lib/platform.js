/**
 * 平台级能力：AI 供应商目录、platform_config 读写、积分计价与扣费。
 *
 * 约定：
 *  - 供应商密钥以 AES-256-GCM 加密后存 platform_ai_providers.api_key_enc，
 *    对外只能以 apiKeySet 布尔值出现，明文仅在本模块内部使用。
 *  - 积分扣减/发放一律走事务 + 行锁，余额与流水始终一致。
 */
import { execute, query, queryOne, tx } from '../db/pool.js';
import { decryptJsonSafe, encryptJson } from './crypto.js';

/**
 * 内置供应商目录：与客户端 packages/shared/ai-presets 保持一致。
 * provider 为稳定标识，docsUrl / apiKeyUrl 指向官方控制台，供前端做引导链接。
 *
 * 1.1.7 起，供应商的「启用/关闭、申请地址、说明文案、展示排序」改为**管理后台可配置**：
 * 这里的字段只是**默认值**（fallback）。实际生效值来自 `platform_ai_providers` 表的
 * `enabled` / `signup_url` / `docs_url` / `note` / `sort_order` 列；
 * 后台没配到的字段才回落到本文件的默认值，因此老库无需手工补数据即可正常工作。
 *
 * 分组约定（前端据此分「平台供应商 / 自建供应商」两块）：
 *  - `platform`：可由平台代付、需要管理员配置密钥的内置供应商；
 *  - `custom`：用户自填 Base URL 的自建供应商（不在本数组中，由客户端预设提供）。
 */
export const PLATFORM_PROVIDERS = [
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    docs: 'https://platform.deepseek.com/api-docs',
    docsUrl: 'https://platform.deepseek.com/api-docs',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    /** 申请 Key 地址（后台可覆盖，默认取 apiKeyUrl） */
    signupUrl: 'https://platform.deepseek.com/api_keys',
    note: 'OpenAI 兼容接口，路径为 /chat/completions。',
    sortOrder: 10,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'xiaomi-mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'],
    defaultModel: 'mimo-v2.6-flash',
    docs: 'https://platform.xiaomimimo.com',
    docsUrl: 'https://platform.xiaomimimo.com',
    apiKeyUrl: 'https://platform.xiaomimimo.com',
    signupUrl: 'https://platform.xiaomimimo.com',
    note: 'OpenAI 兼容接口；模型名随账号权限变化，建议在设置中「获取最新列表」。',
    sortOrder: 20,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    defaultModel: 'qwen-plus',
    docs: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    signupUrl: 'https://bailian.console.aliyun.com/',
    note: 'DashScope OpenAI 兼容模式。',
    sortOrder: 30,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'tencent-hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-large', 'hunyuan-standard'],
    defaultModel: 'hunyuan-turbos-latest',
    docs: 'https://cloud.tencent.com/document/product/1729/111007',
    docsUrl: 'https://cloud.tencent.com/document/product/1729',
    apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    signupUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    note: 'OpenAI 兼容接口，使用控制台创建的 API Key。',
    sortOrder: 40,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4.6',
    docs: 'https://open.bigmodel.cn/dev/api',
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'OpenAI 兼容接口。',
    sortOrder: 50,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'volcengine-ark',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-pro-32k'],
    defaultModel: 'doubao-seed-1-6-250615',
    docs: 'https://www.volcengine.com/docs/82379/1298454',
    docsUrl: 'https://www.volcengine.com/docs/82379',
    apiKeyUrl: 'https://console.volcengine.com/ark',
    signupUrl: 'https://console.volcengine.com/ark',
    note: '模型名也可填写推理接入点 ID（ep-xxxx）。',
    sortOrder: 60,
    group: 'platform',
    supportsCors: false,
  },
  {
    provider: 'baidu-qianfan',
    name: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo-128k', 'ernie-4.0-8k', 'ernie-speed-128k'],
    defaultModel: 'ernie-4.5-turbo-128k',
    docs: 'https://cloud.baidu.com/doc/qianfan-api/index.html',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/',
    apiKeyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    signupUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    note: '千帆 v2 提供 OpenAI 兼容的 /chat/completions。',
    sortOrder: 70,
    group: 'platform',
    supportsCors: false,
  },
];

/** 默认计费配置：1 元 = 1000 积分，支持 tokens / request / free 三种计费方式及多供应商优先级 */
export const DEFAULT_CREDIT_PER_YUAN = 1000;
export const DEFAULT_SIGNUP_GRANT_CREDITS = 200;
export const DEFAULT_DAILY_GRANT_CREDITS = 20;
export const DEFAULT_MODEL_PRICES = {
  'deepseek-chat': { mode: 'tokens', in: 1, out: 2, perCall: 2, providers: ['deepseek'] },
  'deepseek-reasoner': { mode: 'tokens', in: 2, out: 4, perCall: 5, providers: ['deepseek'] },
  'mimo-v2.6-flash': { mode: 'tokens', in: 1, out: 2, perCall: 1, providers: ['xiaomi-mimo'] },
  'mimo-v2.6-pro': { mode: 'tokens', in: 2, out: 4, perCall: 3, providers: ['xiaomi-mimo'] },
  'qwen-plus': { mode: 'tokens', in: 1, out: 2, perCall: 2, providers: ['qwen'] },
  'glm-4.6': { mode: 'tokens', in: 2, out: 2, perCall: 2, providers: ['zhipu'] },
  'hunyuan-turbos-latest': { mode: 'tokens', in: 1, out: 2, perCall: 2, providers: ['tencent-hunyuan'] },
};
export const DEFAULT_PAYMENT_METHODS = [
  { id: 'alipay', name: '支付宝', note: '联系管理员获取收款码', enabled: true },
  { id: 'wechat', name: '微信支付', note: '联系管理员获取收款码', enabled: true },
  { id: 'redeem', name: '兑换码', note: '由管理员发放', enabled: true },
];

/** JSON 安全解析 */
export function safeJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    const value = JSON.parse(String(text));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 按 id 查供应商定义 */
export function findProvider(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return PLATFORM_PROVIDERS.find((item) => item.provider === key) ?? null;
}

/**
 * 供应商展示元数据的「后台值优先、默认值兜底」解析。
 *
 * 1.1.7 起后台可配置 enabled / signupUrl / docsUrl / note / sortOrder；
 * 后台没配过的字段（列值为 NULL）回落到 PLATFORM_PROVIDERS 里的默认值，
 * 因此老库升级后无需手工补数据也能给出完整展示。
 */
function resolveProviderMeta(row, def) {
  const pick = (columnValue, fallback) => {
    const text = columnValue === null || columnValue === undefined ? '' : String(columnValue).trim();
    return text === '' ? fallback : text;
  };
  /**
   * 整型列专用：NULL / 空串才算「未自定义」，落回内置默认值。
   *
   * 不能用 `Number.isFinite(Number(raw))` 判断——`Number(null)` 是 `0`，属于有限数，
   * 会把「未配置」误判成「排序 0」，排序就全乱了。
   */
  const pickInt = (columnValue, fallback) => {
    if (columnValue === null || columnValue === undefined || columnValue === '') return fallback;
    const n = Number(columnValue);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: Number(row?.enabled ?? 0) === 1,
    signupUrl: pick(row?.signup_url, def.signupUrl ?? def.apiKeyUrl ?? ''),
    docsUrl: pick(row?.docs_url, def.docsUrl ?? def.docs ?? ''),
    note: pick(row?.note, def.note ?? ''),
    sortOrder: pickInt(row?.sort_order, Number(def.sortOrder ?? 100)),
    priority: pickInt(row?.priority, 100),
  };
}

/** 对外投影：客户端 /api/ai/providers 使用（只读，不含任何密钥） */
export function publicProvider(def, row = null) {
  const meta = resolveProviderMeta(row, def);
  return {
    id: def.provider,
    name: def.name,
    baseUrl: row?.base_url || def.baseUrl,
    models: def.models,
    defaultModel: def.defaultModel,
    docs: def.docs,
    supportsCors: def.supportsCors,
    docsUrl: meta.docsUrl,
    apiKeyUrl: def.apiKeyUrl,
    // 1.1.7 新增：后台可配置的展示信息
    signupUrl: meta.signupUrl,
    note: meta.note,
    sortOrder: meta.sortOrder,
    enabled: meta.enabled,
    group: def.group ?? 'platform',
  };
}

/* ------------------------------------------------------------------ */
/* platform_config                                                     */
/* ------------------------------------------------------------------ */

/** 读取单个配置项原始字符串 */
export async function getConfigValue(key, fallback = null) {
  const row = await queryOne('SELECT cfg_value FROM platform_config WHERE cfg_key = ? LIMIT 1', [String(key)]);
  if (!row) return fallback;
  const value = row.cfg_value;
  return value === null || value === undefined ? fallback : value;
}

/** 读取 JSON 配置项 */
export async function getConfigJson(key, fallback) {
  return safeJson(await getConfigValue(key, null), fallback);
}

/** 写入配置项（对象会自动序列化） */
export async function setConfigValue(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  await execute(
    `INSERT INTO platform_config (cfg_key, cfg_value, updated_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value), updated_at = NOW()`,
    [String(key).slice(0, 64), String(text)],
  );
  return { key, value: String(text) };
}

/** 归一化模型价格表（兼容按 tokens、按次 request、免费 free 及多供应商优先级 providers） */
export function normalizePrices(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [model, price] of Object.entries(input)) {
    if (!price || typeof price !== 'object') continue;
    const inCost = Number.isFinite(Number(price.in)) && Number(price.in) >= 0 ? Number(price.in) : 1;
    const outCost = Number.isFinite(Number(price.out)) && Number(price.out) >= 0 ? Number(price.out) : 2;
    const perCall = Number.isFinite(Number(price.perCall)) && Number(price.perCall) >= 0 ? Number(price.perCall) : 2;
    const mode = price.mode === 'request' || price.mode === 'free' ? price.mode : 'tokens';
    const providers = Array.isArray(price.providers)
      ? price.providers.map((p) => String(p).trim()).filter(Boolean)
      : [];
    out[String(model).slice(0, 80)] = { mode, in: inCost, out: outCost, perCall, providers };
  }
  return out;
}

/** 归一化支付方式列表 */
export function normalizePaymentMethods(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null)
    .slice(0, 20)
    .map((item) => ({
      id: String(item.id).slice(0, 32),
      name: String(item.name ?? item.id).slice(0, 40),
      note: String(item.note ?? '').slice(0, 200),
      enabled: item.enabled === undefined ? true : Boolean(item.enabled),
    }));
}

/* ------------------------------------------------------------------ */
/* 平台模型治理（1.1.8）                                              */
/* ------------------------------------------------------------------ */

/** 单个模型的平台设置上限（防止运营填出离谱值把上游打挂） */
export const MODEL_SETTING_LIMITS = {
  temperature: { min: 0, max: 2, default: 0.7 },
  maxTokens: { min: 1, max: 32768, default: 4096 },
  /** 单次调用的最大 token 硬上限（用户不可超过） */
  maxTokensCap: { min: 1, max: 32768, default: 4096 },
  /** 按 tokens 计费时的单价（积分 / 千 token） */
  priceIn: { min: 0, max: 100000, default: 1 },
  priceOut: { min: 0, max: 100000, default: 2 },
  /** 系统提示词最大长度 */
  systemPromptMax: 8000,
};

/** 取一个数值并夹到区间内 */
function clampNumber(value, limits, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, n));
}

/**
 * 归一化「每模型设置」。
 *
 * 结构（`platform_ai_providers.model_settings_json`）：
 * ```json
 * {
 *   "deepseek-chat": {
 *     "enabled": true,
 *     "temperature": 0.7,
 *     "maxTokens": 4096,
 *     "priceIn": 1,
 *     "priceOut": 2,
 *     "systemPrompt": "你是……"
 *   }
 * }
 * ```
 *
 * 全部字段可缺省：缺省表示「不限制 / 用全局默认」。
 * `systemPrompt` 为该模型的默认系统提示词，用户可在客户端覆盖。
 */
export function normalizeModelSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawModel, rawSetting] of Object.entries(input)) {
    const model = String(rawModel).trim().slice(0, 120);
    if (!model) continue;
    const s = rawSetting && typeof rawSetting === 'object' && !Array.isArray(rawSetting) ? rawSetting : {};
    const item = {};
    if (s.enabled !== undefined) item.enabled = Boolean(s.enabled);
    if (s.temperature !== undefined) {
      item.temperature = clampNumber(s.temperature, MODEL_SETTING_LIMITS.temperature, MODEL_SETTING_LIMITS.temperature.default);
    }
    if (s.maxTokens !== undefined) {
      item.maxTokens = Math.trunc(clampNumber(s.maxTokens, MODEL_SETTING_LIMITS.maxTokens, MODEL_SETTING_LIMITS.maxTokens.default));
    }
    if (s.priceIn !== undefined) {
      item.priceIn = clampNumber(s.priceIn, MODEL_SETTING_LIMITS.priceIn, MODEL_SETTING_LIMITS.priceIn.default);
    }
    if (s.priceOut !== undefined) {
      item.priceOut = clampNumber(s.priceOut, MODEL_SETTING_LIMITS.priceOut, MODEL_SETTING_LIMITS.priceOut.default);
    }
    if (s.systemPrompt !== undefined) {
      const prompt = String(s.systemPrompt ?? '').trim();
      if (prompt) item.systemPrompt = prompt.slice(0, MODEL_SETTING_LIMITS.systemPromptMax);
    }
    // 至少有一个有效字段才保留，避免写一堆空对象
    if (Object.keys(item).length > 0) out[model] = item;
  }
  return out;
}

/** 读取某供应商的模型设置（从已查出的行解析，避免重复查库） */
export function providerModelSettings(row) {
  return normalizeModelSettings(safeJson(row?.model_settings_json, {}));
}

/**
 * 解析某个模型的「生效设置」。
 *
 * 优先级：模型级设置 > 供应商兜底系统提示词 > 内置默认值。
 * 返回结构同时供两处使用：
 *  - 后台：展示当前生效值（含来源，便于运营判断哪一层生效）；
 *  - 前台/接口：拿 temperature / maxTokens / systemPrompt 实际下发。
 */
export function resolveModelSetting(row, def, model) {
  const settings = providerModelSettings(row);
  const per = settings[String(model)] ?? {};
  const fallbackPrompt = String(row?.system_prompt ?? '').trim();
  const modelPrompt = String(per.systemPrompt ?? '').trim();
  const systemPrompt = modelPrompt || fallbackPrompt || '';
  return {
    model: String(model),
    enabled: per.enabled === undefined ? true : Boolean(per.enabled),
    temperature:
      per.temperature === undefined ? MODEL_SETTING_LIMITS.temperature.default : Number(per.temperature),
    maxTokens: per.maxTokens === undefined ? MODEL_SETTING_LIMITS.maxTokens.default : Number(per.maxTokens),
    priceIn: per.priceIn === undefined ? MODEL_SETTING_LIMITS.priceIn.default : Number(per.priceIn),
    priceOut: per.priceOut === undefined ? MODEL_SETTING_LIMITS.priceOut.default : Number(per.priceOut),
    systemPrompt,
    /** 系统提示词来源：model=模型级、provider=供应商兜底、none=未配置 */
    systemPromptSource: modelPrompt ? 'model' : fallbackPrompt ? 'provider' : 'none',
    /** 该模型的默认模型标记 */
    isDefault: String(row?.default_model ?? def?.defaultModel ?? '') === String(model),
  };
}

/**
 * 汇总「平台可用模型」（前台只读消费）。
 *
 * 这是「平台付费」区块的唯一数据源：用户只看到模型名、说明、限制与价格，
 * **看不到供应商 baseUrl / apiKey 等实现细节**（B 项要求的分离）。
 *
 * @param {Array} rows platform_ai_providers 全量行
 * @returns {Array<{model:string, provider:string, providerName:string, ...}>}
 */
export function listPlatformModels(rows) {
  const out = [];
  const seen = new Set();
  for (const def of PLATFORM_PROVIDERS) {
    const row = rows.find((r) => r.provider === def.provider);
    if (!row) continue;
    // 只汇总「已启用且配了密钥」的供应商：没密钥的模型前台选了也调不通
    if (Number(row.enabled) !== 1 || !row.api_key_enc) continue;
    const models = safeJson(row.models_json, null);
    const modelList = Array.isArray(models) && models.length > 0 ? models.map(String) : def.models;
    for (const model of modelList) {
      if (seen.has(model)) continue;
      seen.add(model);
      const setting = resolveModelSetting(row, def, model);
      if (!setting.enabled) continue;
      out.push({
        model,
        provider: def.provider,
        providerName: def.name,
        temperature: setting.temperature,
        maxTokens: setting.maxTokens,
        priceIn: setting.priceIn,
        priceOut: setting.priceOut,
        systemPrompt: setting.systemPrompt,
        isDefault: setting.isDefault,
      });
    }
  }
  // 默认模型排最前，其余按供应商 sortOrder 保序
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** 读取完整计费配置 */
export async function loadBilling() {
  const [perYuanRaw, modelPrices, paymentMethods, currency, signupRaw, dailyRaw] = await Promise.all([
    getConfigValue('credit_per_yuan', String(DEFAULT_CREDIT_PER_YUAN)),
    getConfigJson('model_prices', DEFAULT_MODEL_PRICES),
    getConfigJson('payment_methods', DEFAULT_PAYMENT_METHODS),
    getConfigValue('currency', 'CNY'),
    getConfigValue('signup_grant_credits', String(DEFAULT_SIGNUP_GRANT_CREDITS)),
    getConfigValue('daily_grant_credits', String(DEFAULT_DAILY_GRANT_CREDITS)),
  ]);
  const perYuan = Number(perYuanRaw);
  const signupGrantCredits = Number(signupRaw);
  const dailyGrantCredits = Number(dailyRaw);
  return {
    creditPerYuan: Number.isFinite(perYuan) && perYuan > 0 ? perYuan : DEFAULT_CREDIT_PER_YUAN,
    signupGrantCredits: Number.isFinite(signupGrantCredits) && signupGrantCredits >= 0 ? Math.trunc(signupGrantCredits) : DEFAULT_SIGNUP_GRANT_CREDITS,
    dailyGrantCredits: Number.isFinite(dailyGrantCredits) && dailyGrantCredits >= 0 ? Math.trunc(dailyGrantCredits) : DEFAULT_DAILY_GRANT_CREDITS,
    modelPrices: normalizePrices(modelPrices),
    paymentMethods: normalizePaymentMethods(paymentMethods),
    currency: String(currency || 'CNY').slice(0, 8),
  };
}

/**
 * 计算一次调用的积分成本。
 * 支持：
 *  - mode === 'free': 0 积分
 *  - mode === 'request': 按次固定扣减 perCall 积分
 *  - mode === 'tokens' (默认): 每 1000 token 消耗 in / out 积分
 */
export function computeCost(modelPrices, model, inTokens, outTokens) {
  const price = modelPrices && modelPrices[model] ? modelPrices[model] : { mode: 'tokens', in: 1, out: 2, perCall: 2 };
  if (price.mode === 'free') return 0;
  if (price.mode === 'request') {
    const c = Number(price.perCall);
    return Number.isFinite(c) && c >= 0 ? Math.round(c) : 2;
  }
  const inPrice = Number.isFinite(Number(price.in)) ? Number(price.in) : 1;
  const outPrice = Number.isFinite(Number(price.out)) ? Number(price.out) : 2;
  const prompt = Math.max(0, Number(inTokens) || 0);
  const completion = Math.max(0, Number(outTokens) || 0);
  const raw = (prompt / 1000) * inPrice + (completion / 1000) * outPrice;
  return Math.max(0, Math.round(raw));
}

/* ------------------------------------------------------------------ */
/* 积分                                                                */
/* ------------------------------------------------------------------ */

/** 积分流水对外投影 */
export function ledgerItem(row) {
  return {
    id: Number(row.id),
    delta: Number(row.delta ?? 0),
    balanceAfter: Number(row.balance_after ?? 0),
    kind: row.kind,
    ref: row.ref ?? null,
    detail: row.detail_json ? safeJson(row.detail_json, null) : null,
    createdAt: row.created_at ?? null,
  };
}

/** 读取用户余额 */
export async function readBalance(userId) {
  const row = await queryOne('SELECT credits FROM users WHERE id = ? LIMIT 1', [userId]);
  return row ? Number(row.credits ?? 0) : 0;
}

/**
 * 扣减积分：事务内加行锁，余额与流水同时落库。
 * 仅扣本次请求的成本，因此负余额最多来自当前这一笔。
 */
export async function chargeCredits(userId, cost, { kind = 'consume', ref = null, detail = null } = {}) {
  const amount = Math.trunc(Number(cost) || 0);
  if (amount <= 0) {
    return { delta: 0, balance: await readBalance(userId), cost: 0, skipped: true };
  }
  return tx(async (conn) => {
    const rows = await conn.query('SELECT credits FROM users WHERE id = ? FOR UPDATE', [userId]);
    const current = Number(rows?.[0]?.credits ?? 0);
    const balance = current - amount;
    await conn.execute('UPDATE users SET credits = ? WHERE id = ?', [balance, userId]);
    await conn.execute(
      'INSERT INTO credit_ledger (user_id, delta, balance_after, kind, ref, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [userId, -amount, balance, kind, ref === null ? null : String(ref).slice(0, 120), detail ? JSON.stringify(detail) : null],
    );
    return { delta: -amount, balance, cost: amount, skipped: false };
  });
}

/**
 * 增加积分（充值 / 补发 / 管理员调整）。
 * 管理员手动调整允许 amount 为负数，此时按 kind='grant' 记录负向流水。
 */
export async function addCredits(userId, amount, { kind = 'grant', ref = null, detail = null } = {}) {
  const delta = Math.trunc(Number(amount) || 0);
  return tx(async (conn) => {
    const rows = await conn.query('SELECT credits FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!rows || rows.length === 0) return null;
    const current = Number(rows[0].credits ?? 0);
    const balance = current + delta;
    await conn.execute('UPDATE users SET credits = ? WHERE id = ?', [balance, userId]);
    await conn.execute(
      'INSERT INTO credit_ledger (user_id, delta, balance_after, kind, ref, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [userId, delta, balance, kind, ref === null ? null : String(ref).slice(0, 120), detail ? JSON.stringify(detail) : null],
    );
    return { delta, balance };
  });
}

/* ------------------------------------------------------------------ */
/* AI 供应商（平台代付）                                               */
/* ------------------------------------------------------------------ */

/** 读取某供应商的平台配置行 */
export async function getProviderRow(provider) {
  return queryOne('SELECT * FROM platform_ai_providers WHERE provider = ? LIMIT 1', [String(provider)]);
}

/** 读取全部供应商配置行 */
export async function listProviderRows() {
  return query('SELECT * FROM platform_ai_providers');
}

/** 解密平台密钥，任何异常都视为未配置 */
export function providerApiKey(row) {
  if (!row || !row.api_key_enc) return null;
  const value = decryptJsonSafe(row.api_key_enc);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 加密平台密钥 */
export function encryptProviderKey(apiKey) {
  return encryptJson(String(apiKey));
}

/** 管理端投影：绝不返回密钥明文，但包含全部展示元数据（1.1.7 起可编辑） */
export function adminProviderItem(row, def) {
  const models = safeJson(row?.models_json, null);
  const meta = resolveProviderMeta(row, def);
  return {
    provider: def.provider,
    name: def.name,
    baseUrl: row?.base_url || def.baseUrl,
    enabled: meta.enabled,
    priority: meta.priority,
    apiKeySet: Boolean(row?.api_key_enc),
    models: Array.isArray(models) && models.length > 0 ? models.map((m) => String(m)) : def.models,
    // 1.1.7 新增：展示配置（后台可编辑）
    signupUrl: meta.signupUrl,
    docsUrl: meta.docsUrl,
    note: meta.note,
    sortOrder: meta.sortOrder,
    group: def.group ?? 'platform',
    // 1.1.8 新增：平台付费侧的模型治理
    defaultModel: String(row?.default_model ?? def.defaultModel ?? ''),
    modelSettings: providerModelSettings(row),
    systemPrompt: String(row?.system_prompt ?? '').trim(),
    // 默认值，供后台「恢复默认」与占位提示使用
    defaults: {
      signupUrl: def.signupUrl ?? def.apiKeyUrl ?? '',
      docsUrl: def.docsUrl ?? def.docs ?? '',
      note: def.note ?? '',
      sortOrder: Number(def.sortOrder ?? 100),
      defaultModel: String(def.defaultModel ?? ''),
    },
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * 写入供应商配置（仅更新传入的字段）。
 *
 * 1.1.7 起支持展示元数据：signupUrl / docsUrl / note / sortOrder。
 * 传空串表示「恢复默认」（落库为 NULL，读取时回落到 PLATFORM_PROVIDERS）。
 */
export async function saveProvider(provider, patch) {
  const def = findProvider(provider);
  if (!def) return null;
  const current = await getProviderRow(def.provider);
  const baseUrl = patch.baseUrl === undefined ? current?.base_url ?? def.baseUrl : String(patch.baseUrl);
  const enabled = patch.enabled === undefined ? Number(current?.enabled ?? 0) : patch.enabled ? 1 : 0;
  const priority =
    patch.priority === undefined
      ? Number.isFinite(Number(current?.priority))
        ? Number(current.priority)
        : 100
      : Math.max(1, Math.min(9999, Math.trunc(Number(patch.priority) || 100)));
  let apiKeyEnc = current?.api_key_enc ?? null;
  if (patch.apiKey !== undefined) {
    apiKeyEnc = patch.apiKey === '' || patch.apiKey === null ? null : encryptProviderKey(patch.apiKey);
  }
  const modelsJson = patch.models === undefined ? current?.models_json ?? null : JSON.stringify(patch.models);

  // 展示元数据：undefined 保持原值；空串归一为 NULL（表示回落到默认值）
  const nullableText = (patchValue, currentValue, maxLen) => {
    if (patchValue === undefined) return currentValue ?? null;
    const text = String(patchValue ?? '').trim();
    return text === '' ? null : text.slice(0, maxLen);
  };
  const signupUrl = nullableText(patch.signupUrl, current?.signup_url, 255);
  const docsUrl = nullableText(patch.docsUrl, current?.docs_url, 255);
  const note = nullableText(patch.note, current?.note, 500);
  // sortOrder：NULL 表示「未自定义」（读取时回落内置默认），因此不能用 100 兜底
  const sortOrder = (() => {
    if (patch.sortOrder !== undefined) {
      return Math.max(1, Math.min(9999, Math.trunc(Number(patch.sortOrder) || 100)));
    }
    const raw = current?.sort_order;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  })();

  // 1.1.8 模型治理三列：undefined 保持原值，空串 / 空对象归一为 NULL（回落内置默认）
  const defaultModel = nullableText(patch.defaultModel, current?.default_model, 120);
  const systemPrompt = (() => {
    if (patch.systemPrompt === undefined) {
      const cur = String(current?.system_prompt ?? '').trim();
      return cur === '' ? null : cur;
    }
    const text = String(patch.systemPrompt ?? '').trim();
    return text === '' ? null : text.slice(0, MODEL_SETTING_LIMITS.systemPromptMax);
  })();
  const modelSettingsJson = (() => {
    if (patch.modelSettings === undefined) return current?.model_settings_json ?? null;
    const normalized = normalizeModelSettings(patch.modelSettings);
    return Object.keys(normalized).length === 0 ? null : JSON.stringify(normalized);
  })();

  const fullSql = `INSERT INTO platform_ai_providers
       (provider, base_url, api_key_enc, models_json, enabled, priority,
        signup_url, docs_url, note, sort_order,
        default_model, model_settings_json, system_prompt, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE base_url = VALUES(base_url), api_key_enc = VALUES(api_key_enc),
       models_json = VALUES(models_json), enabled = VALUES(enabled), priority = VALUES(priority),
       signup_url = VALUES(signup_url), docs_url = VALUES(docs_url), note = VALUES(note),
       sort_order = VALUES(sort_order), default_model = VALUES(default_model),
       model_settings_json = VALUES(model_settings_json), system_prompt = VALUES(system_prompt),
       updated_at = NOW()`;
  const fullArgs = [
    def.provider,
    baseUrl.slice(0, 255),
    apiKeyEnc,
    modelsJson,
    enabled,
    priority,
    signupUrl,
    docsUrl,
    note,
    sortOrder,
    defaultModel,
    modelSettingsJson,
    systemPrompt,
  ];

  try {
    await execute(fullSql, fullArgs);
  } catch {
    // 兜底：兼容尚未执行 1.1.7 迁移的老库（缺 signup_url 等列）
    try {
      await execute(
        `INSERT INTO platform_ai_providers (provider, base_url, api_key_enc, models_json, enabled, priority, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE base_url = VALUES(base_url), api_key_enc = VALUES(api_key_enc),
           models_json = VALUES(models_json), enabled = VALUES(enabled), priority = VALUES(priority), updated_at = NOW()`,
        [def.provider, baseUrl.slice(0, 255), apiKeyEnc, modelsJson, enabled, priority],
      );
    } catch {
      await execute(
        `INSERT INTO platform_ai_providers (provider, base_url, api_key_enc, models_json, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE base_url = VALUES(base_url), api_key_enc = VALUES(api_key_enc),
           models_json = VALUES(models_json), enabled = VALUES(enabled), updated_at = NOW()`,
        [def.provider, baseUrl.slice(0, 255), apiKeyEnc, modelsJson, enabled],
      );
    }
  }

  const saved = await getProviderRow(def.provider);
  return adminProviderItem(saved, def);
}

/**
 * 为指定模型按优先级选出已启用且配置了平台密钥的候选供应商列表。
 * 若某一模型被多个供应商支持，优先按 modelPrices[model].providers 的顺序，其次按供应商 priority 升序（越小越优先）。
 */
export async function resolvePlatformCandidates(requestedProvider, model) {
  const rows = await listProviderRows();
  const billing = await loadBilling();
  const rowMap = new Map(rows.map((r) => [r.provider, r]));

  const activeList = [];
  for (const def of PLATFORM_PROVIDERS) {
    const row = rowMap.get(def.provider);
    const key = row ? providerApiKey(row) : null;
    if (!row || Number(row.enabled) !== 1 || !key) continue;
    const models = safeJson(row.models_json, null);
    const modelSet = new Set(Array.isArray(models) && models.length ? models.map(String) : def.models);
    activeList.push({
      provider: def.provider,
      name: def.name,
      baseUrl: row.base_url || def.baseUrl,
      apiKey: key,
      priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
      modelSet,
    });
  }

  // 按 priority 升序排列
  activeList.sort((a, b) => a.priority - b.priority);

  const modelPriceCfg = billing.modelPrices?.[model];
  const preferredOrder = Array.isArray(modelPriceCfg?.providers) ? modelPriceCfg.providers : [];

  const matching = activeList.filter((c) => c.modelSet.has(model));
  if (matching.length > 0) {
    matching.sort((a, b) => {
      const ia = preferredOrder.indexOf(a.provider);
      const ib = preferredOrder.indexOf(b.provider);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.priority - b.priority;
    });
    return matching;
  }

  // 若指定了具体供应商且已启用
  if (requestedProvider && requestedProvider !== 'platform') {
    const exact = activeList.find((c) => c.provider === requestedProvider);
    if (exact) return [exact];
  }

  return activeList;
}

/**
 * 尝试发放每日登录积分（若管理员配置 dailyGrantCredits > 0 且用户今日尚未领取）。
 */
export async function grantDailyCreditsIfEligible(userId) {
  try {
    const billing = await loadBilling();
    const amount = Number(billing.dailyGrantCredits ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const userRow = await queryOne('SELECT id, last_daily_grant_date FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!userRow || userRow.last_daily_grant_date === today) return null;
    await execute('UPDATE users SET last_daily_grant_date = ? WHERE id = ?', [today, userId]);
    return await addCredits(userId, amount, {
      kind: 'grant',
      ref: `daily:${today}`,
      detail: { reason: '每日登录赠送积分', date: today, amount },
    });
  } catch {
    return null;
  }
}

export default {
  PLATFORM_PROVIDERS,
  DEFAULT_CREDIT_PER_YUAN,
  DEFAULT_MODEL_PRICES,
  DEFAULT_PAYMENT_METHODS,
  findProvider,
  publicProvider,
  getConfigValue,
  getConfigJson,
  setConfigValue,
  normalizePrices,
  normalizePaymentMethods,
  loadBilling,
  computeCost,
  ledgerItem,
  readBalance,
  chargeCredits,
  addCredits,
  getProviderRow,
  listProviderRows,
  providerApiKey,
  encryptProviderKey,
  adminProviderItem,
  saveProvider,
  resolvePlatformCandidates,
  grantDailyCreditsIfEligible,
  safeJson,
  // 1.1.8 平台模型治理
  MODEL_SETTING_LIMITS,
  normalizeModelSettings,
  providerModelSettings,
  resolveModelSetting,
  listPlatformModels,
};
