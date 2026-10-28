/**
 * AI 代理：把 OpenAI 兼容的 /chat/completions 请求转发出去，并以 SSE 回传增量文本。
 *
 * 两种模式：
 *  - 自带 Key（默认）：服务端不保存用户的 API Key，用完即弃，仅记录 token 用量。
 *  - 平台代付（usePlatform=true）：使用 platform_ai_providers 里的平台密钥，
 *    按 platform_config 的价格在流结束后扣积分并写流水。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { HttpError, badRequest, ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { userRateLimit } from '../middleware/rate.js';
import { LruCache } from '../lib/lru.js';
import { sha256 } from '../lib/crypto.js';
import {
  PLATFORM_PROVIDERS,
  chargeCredits,
  computeCost,
  findProvider,
  getProviderRow,
  listPlatformModels,
  listProviderRows,
  loadBilling,
  mergeAllProviderDefs,
  providerApiKey,
  publicProvider,
  readBalance,
  resolveModelSetting,
  resolvePlatformCandidates,
  resolveProviderDef,
  safeJson,
} from '../lib/platform.js';

/**
 * 预设供应商（静态兜底视图）。
 *
 * 注意：真实展示以 `GET /api/ai/providers` 为准——该路由会读库，
 * 把管理员在后台配置的 enabled / signupUrl / docsUrl / note / sortOrder 合并进来。
 * 这里保留常量仅为「库读失败时不至于 500」，不含任何后台配置。
 */
export const AI_PROVIDERS = PLATFORM_PROVIDERS.map((def) => publicProvider(def));

/** 上游模型列表缓存：10 分钟 */
const modelCache = new LruCache({ max: 200, ttlMs: 10 * 60_000 });

/** 拉取上游模型列表的超时时间 */
const MODELS_TIMEOUT = 8000;

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(200_000),
  name: z.string().max(64).optional(),
  toolCallId: z.string().max(120).optional(),
});

const chatSchema = z
  .object({
    provider: z.string().trim().max(40).optional().default('custom'),
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .regex(/^https?:\/\/[^\s]+$/i, { message: '接口地址必须以 http:// 或 https:// 开头' })
      .optional(),
    apiKey: z.string().trim().max(500).optional(),
    model: z.string({ error: '缺少模型名' }).trim().min(1, { message: '缺少模型名' }).max(120),
    messages: z.array(messageSchema).min(1, { message: '消息列表不能为空' }).max(200),
    temperature: z.coerce.number().min(0).max(2).optional().default(0.7),
    maxTokens: z.coerce.number().int().min(1).max(32768).optional().default(4096),
    usePlatform: z.boolean().optional().default(false),
  })
  .refine((value) => value.usePlatform || value.provider === 'platform' || Boolean(value.baseUrl), {
    message: '缺少接口地址',
    path: ['baseUrl'],
  })
  .refine((value) => value.usePlatform || value.provider === 'platform' || Boolean(value.apiKey), {
    message: '缺少 API Key',
    path: ['apiKey'],
  });

const modelsQuerySchema = z.object({
  provider: z
    .string({ error: '缺少供应商标识' })
    .trim()
    .min(1, { message: '缺少供应商标识' })
    .max(40, { message: '供应商标识过长' }),
});

/** AI 配置连通性自检参数（平台通道 / 自带 Key 两种模式共用） */
const aiTestSchema = z.object({
  provider: z
    .string({ error: '供应商标识必须是字符串' })
    .trim()
    .max(40, { message: '供应商标识最多 40 个字符' })
    .optional()
    .default('custom'),
  baseUrl: z.string().trim().max(300, { message: '接口地址最多 300 个字符' }).optional(),
  apiKey: z.string().trim().max(500, { message: 'API Key 最多 500 个字符' }).optional(),
  model: z.string().trim().max(120, { message: '模型名最多 120 个字符' }).optional(),
  usePlatform: z.boolean({ error: 'usePlatform 必须是布尔值' }).optional().default(false),
});

/** 自检请求超时（毫秒） */
const TEST_TIMEOUT = 8000;

/** 粗略估算 token 数（无 usage 回传时兜底） */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

/** 记录用量，失败不影响响应（包含 status / latency_ms / error_code，供后台看板统计失败率与平均响应时间） */
async function recordUsage(userId, provider, model, inTokens, outTokens, cost = 0, { status = 'ok', latencyMs = 0, errorCode = null } = {}) {
  const base = [
    userId,
    String(provider).slice(0, 40),
    String(model).slice(0, 80),
    Math.max(0, Math.round(inTokens)),
    Math.max(0, Math.round(outTokens)),
  ];
  const safeCost = Math.max(0, Math.round(cost));
  const safeStatus = status === 'error' ? 'error' : 'ok';
  const safeLatency = Math.max(0, Math.round(latencyMs));
  const safeErrCode = errorCode ? String(errorCode).slice(0, 64) : null;
  try {
    await execute(
      'INSERT INTO ai_usage (user_id, provider, model, in_tokens, out_tokens, cost, status, latency_ms, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [...base, safeCost, safeStatus, safeLatency, safeErrCode],
    );
  } catch {
    try {
      await execute(
        'INSERT INTO ai_usage (user_id, provider, model, in_tokens, out_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [...base, safeCost],
      );
    } catch {
      try {
        await execute(
          'INSERT INTO ai_usage (user_id, provider, model, in_tokens, out_tokens, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
          base,
        );
      } catch {
        /* 统计失败忽略 */
      }
    }
  }
}

/** 拼接上游地址 */
function completionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/** 拉取上游模型列表（8 秒超时） */
async function fetchUpstreamModels(baseUrl, apiKey) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `请求超时（${MODELS_TIMEOUT / 1000} 秒）` : err?.message || String(err);
    throw new Error(reason);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`上游返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return items
    .map((item) => ({
      id: String(item?.id ?? ''),
      owned_by: item?.owned_by ?? item?.ownedBy ?? null,
    }))
    .filter((item) => item.id !== '');
}

/**
 * 探测上游 /models（自带 Key 模式自检）。
 * 不抛异常，把状态码与中文原因结构化返回，方便前端直接展示。
 * @returns {Promise<{ ok: boolean, status: number, models: string[], message?: string }>}
 */
async function detectUpstreamModels(baseUrl, apiKey) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `请求超时（${TEST_TIMEOUT / 1000} 秒）` : err?.message || String(err);
    return { ok: false, status: 0, models: [], message: `连接上游失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 160);
    } catch {
      /* 读取失败忽略 */
    }
    const known = {
      401: 'API Key 无效或无权限（HTTP 401），请确认 Key 是否正确、是否已过期',
      403: 'API Key 无效或无权限（HTTP 403），请确认 Key 是否已开通该服务',
      404: '上游没有 /models 接口（HTTP 404），请确认接口地址是否为 OpenAI 兼容地址',
      429: '上游限流（HTTP 429），请稍后重试',
    };
    return {
      ok: false,
      status: res.status,
      models: [],
      message: known[res.status] ?? `上游返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`,
    };
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = items.map((item) => String(item?.id ?? '')).filter((id) => id !== '');
  return { ok: true, status: res.status, models };
}

/**
 * 平台通道自检：用平台密钥发一次极短的非流式 chat 请求。
 * 说明：这只是连通性验证，不扣积分、不写用量；按候选顺序逐个尝试。
 * @returns {Promise<{ ok: boolean, provider?: string, name?: string, model?: string, models?: string[], tried: string[] }>}
 */
async function probePlatformChat(candidates, requestedModel) {
  const tried = [];
  for (const cand of candidates) {
    const def = findProvider(cand.provider);
    const model =
      requestedModel || (def && cand.modelSet.has(def.defaultModel) ? def.defaultModel : [...cand.modelSet][0]);
    if (!model) {
      tried.push(`${cand.name}：未配置任何可用模型`);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);
    let res;
    try {
      res = await fetch(completionsUrl(cand.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cand.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '回复ok' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err?.name === 'AbortError' ? `请求超时（${TEST_TIMEOUT / 1000} 秒）` : err?.message || String(err);
      tried.push(`${cand.name}（${model}）：${reason}`);
      continue;
    }
    clearTimeout(timer);

    if (res.ok) {
      try {
        await res.json();
      } catch {
        /* HTTP 2xx 即视为连通，响应体解析失败不影响结论 */
      }
      return {
        ok: true,
        provider: cand.provider,
        name: cand.name,
        model,
        models: [...cand.modelSet],
        tried,
      };
    }
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 160);
    } catch {
      /* 读取失败忽略 */
    }
    tried.push(`${cand.name}（${model}）：HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return { ok: false, tried };
}

export async function aiRoutes(app) {
  /**
   * 供应商目录（公开，无需登录）。
   *
   * 1.1.9 起这份响应的语义被收窄为「**客户端自带 Key 时可选哪些供应商**」：
   *  - `signupUrl` ：申请 API Key 的地址（后台可改）
   *  - `docsUrl`   ：官方文档地址
   *  - `note`      ：说明文案
   *  - `sortOrder` ：展示排序（升序）
   *  - `group`     ：`platform`（OpenAI 兼容厂商）/ `custom`（自建，由客户端预设提供）
   *
   * **不再返回 `enabled`**：平台是否开通代付，与用户自带 Key 能不能用毫无关系，
   * 把它放进前台响应只会制造「未开通所以不能用」的误解。
   * 平台代付的可用模型改由 `/api/ai/platform-models` 表达（空列表 = 暂未开放）。
   *
   * 读库失败时回落到内置默认值，保证前端永远拿得到完整列表。
   */
  app.get('/api/ai/providers', async (_req, reply) => {
    let providers = AI_PROVIDERS;
    try {
      const rows = await listProviderRows();
      const rowMap = new Map(rows.map((row) => [row.provider, row]));
      const allDefs = mergeAllProviderDefs(rows);
      providers = allDefs.map((def) => publicProvider(def, rowMap.get(def.provider) ?? null)).sort(
        (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
      );
    } catch {
      /* 库不可用时用静态兜底，不阻塞供应商列表展示 */
    }
    return ok(reply, { providers });
  });

  /**
   * 平台付费可用的模型清单（1.1.8，公开无需登录）。
   *
   * 这是「平台 AI 服务」区块的唯一数据源，与「我的 AI 供应商（自带 Key）」
   * 彻底分离：只暴露模型名、来源供应商名、参数上限与单价，
   * **绝不暴露 baseUrl / apiKey / 供应商密钥状态**。
   *
   * 只汇总「后台已启用且配好密钥」的供应商——没密钥的模型用户选了也调不通。
   */
  app.get('/api/ai/platform-models', async (_req, reply) => {
    let models = [];
    try {
      const rows = await listProviderRows();
      models = listPlatformModels(rows);
    } catch {
      /* 库不可用时返回空列表，前台显示「暂无可选模型」而不是报错 */
    }
    return ok(reply, { models });
  });

  // 上游可用模型列表（登录可选）：优先平台密钥，其次调用方自带密钥；provider='platform' 返回所有已开启的平台模型
  app.get('/api/ai/models', { preHandler: [app.optionalAuth] }, async (req, reply) => {
    const params = parse(modelsQuerySchema, req.query, '供应商参数');
    if (params.provider === 'platform') {
      const [rows, billing] = await Promise.all([listProviderRows(), loadBilling()]);
      const rowMap = new Map(rows.map((r) => [r.provider, r]));
      const allDefs = mergeAllProviderDefs(rows);
      const enabledDefs = allDefs.filter((def) => {
        const r = rowMap.get(def.provider);
        return r && Number(r.enabled) === 1 && Boolean(providerApiKey(r));
      });
      const merged = new Set();
      for (const def of enabledDefs) {
        const r = rowMap.get(def.provider);
        const list = safeJson(r?.models_json, null);
        for (const m of Array.isArray(list) && list.length ? list : def.models) merged.add(String(m));
      }
      // 计费表里配置了价格的模型，只有在「确实有已启用供应商」时才并入列表。
      // 否则会出现「后台一个供应商都没开，前端却列出一堆模型」的错觉，
      // 用户选完点测试只会拿到 400 —— 这正是「平台积分测试返回 400」的根因之一。
      if (enabledDefs.length > 0) {
        for (const m of Object.keys(billing.modelPrices ?? {})) merged.add(m);
      }

      // 关键：没有任何已启用供应商时**不得**回退填充内置模型名。
      // 旧实现在这里把全部预设模型塞进列表并谎称「平台已开放 N 个可用模型」，
      // 用户选完模型点测试只会拿到 400，是「平台积分测试返回 400」的直接成因。
      // 现在如实返回空列表 + 明确的 source/message，前端据此提示去后台启用供应商。
      if (merged.size === 0) {
        return ok(reply, {
          models: [],
          source: 'unavailable',
          message: '平台暂未开放任何 AI 模型（管理员尚未在后台启用并配置供应商密钥），请改用个人 API Key 或在后台启用',
        });
      }
      return ok(reply, {
        models: [...merged].map((id) => ({ id, owned_by: 'platform' })),
        source: 'upstream',
        message: `平台已开放 ${merged.size} 个可用模型`,
      });
    }

    const row = await getProviderRow(params.provider);
    const def = resolveProviderDef(params.provider, row);
    if (!def) throw badRequest(`未知的供应商：${params.provider}`, 'UNKNOWN_PROVIDER');
    const platformKey = row && Number(row.enabled) === 1 ? providerApiKey(row) : null;
    const headerRaw = req.headers['x-user-ai-key'];
    const headerKey = String(Array.isArray(headerRaw) ? headerRaw[0] : headerRaw ?? '').trim() || null;
    const apiKey = platformKey || headerKey;
    const baseUrl = String(row?.base_url || def.baseUrl).replace(/\/+$/, '');
    const staticModels = def.models.map((id) => ({ id }));

    const cacheKey = `${def.provider}|${apiKey ? sha256(apiKey).slice(0, 16) : 'nokey'}|${baseUrl}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return ok(reply, cached);

    if (!apiKey) {
      const payload = {
        models: staticModels,
        source: 'static',
        message: '该供应商尚未配置平台密钥，先返回内置模型列表；可在设置里填写自己的 API Key 后重试',
      };
      modelCache.set(cacheKey, payload);
      return ok(reply, payload);
    }

    try {
      const models = await fetchUpstreamModels(baseUrl, apiKey);
      if (models.length === 0) throw new Error('上游未返回任何模型');
      const payload = { models, source: 'upstream' };
      modelCache.set(cacheKey, payload);
      return ok(reply, payload);
    } catch (err) {
      req.log.warn({ err, provider: def.provider }, '拉取上游模型列表失败');
      const payload = {
        models: staticModels,
        source: 'static',
        message: `获取上游模型列表失败：${err.message}`,
      };
      modelCache.set(cacheKey, payload);
      return ok(reply, payload);
    }
  });

  // 我的 AI 用量（最近 200 条 + 今日汇总）
  app.get('/api/ai/usage', { preHandler: [app.authenticate] }, async (req, reply) => {
    const [balance, today, rows] = await Promise.all([
      readBalance(req.user.id),
      queryOne(
        `SELECT COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost
         FROM ai_usage WHERE user_id = ? AND created_at >= CURDATE()`,
        [req.user.id],
      ),
      query(
        'SELECT model, in_tokens, out_tokens, cost, created_at FROM ai_usage WHERE user_id = ? ORDER BY id DESC LIMIT 200',
        [req.user.id],
      ),
    ]);

    return ok(reply, {
      balance,
      tokensToday: Number(today?.in_tokens ?? 0) + Number(today?.out_tokens ?? 0),
      costToday: Number(today?.cost ?? 0),
      history: rows.map((row) => ({
        model: row.model ?? null,
        inTokens: Number(row.in_tokens ?? 0),
        outTokens: Number(row.out_tokens ?? 0),
        cost: Number(row.cost ?? 0),
        createdAt: row.created_at ?? null,
      })),
    });
  });

  // AI 配置连通性自检：平台通道与自带 Key 都由服务端代发，避免浏览器 CORS 与路径拼接问题
  // 注意：失败也返回 HTTP 200，把 ok:false 放在 data 里，前端统一展示 message
  app.post('/api/ai/test', { preHandler: [app.authenticate, userRateLimit('ai')] }, async (req, reply) => {
    const body = parse(aiTestSchema, req.body, 'AI 自检参数');
    const started = Date.now();
    const mode = body.usePlatform || body.provider === 'platform' ? 'platform' : 'byok';
    /** 统一收口：data 内始终带 ok / mode / message / latencyMs */
    const finish = (payload) => ok(reply, { mode, latencyMs: Date.now() - started, ...payload });

    if (mode === 'platform') {
      try {
        const balance = await readBalance(req.user.id);
        if (balance <= 0) {
          return finish({
            ok: false,
            message: '平台积分不足（当前余额为 0），请先充值或兑换积分后再测试平台通道',
          });
        }
        const candidates = await resolvePlatformCandidates(body.provider, body.model ?? '');
        if (candidates.length === 0) {
          return finish({ ok: false, message: '管理员尚未启用任何平台 AI 供应商，请联系管理员或改用个人 API Key' });
        }
        const probed = await probePlatformChat(candidates, body.model);
        if (!probed.ok) {
          return finish({
            ok: false,
            message: `平台通道调用失败：${probed.tried.join('；') || '无可用上游'}`,
          });
        }
        await audit(req, 'ai.test', probed.provider, { mode, model: probed.model, ok: true });
        return finish({
          ok: true,
          message: `平台通道正常（供应商：${probed.name}，模型：${probed.model}）`,
          models: probed.models ?? [],
        });
      } catch (err) {
        req.log.warn({ err }, '平台 AI 通道自检异常');
        return finish({ ok: false, message: `平台自检异常：${err.message}` });
      }
    }

    // 自带 Key 模式：服务端代发 GET {baseUrl}/models
    if (!body.baseUrl) {
      return finish({ ok: false, message: '请先填写接口地址（baseUrl），例如 https://api.deepseek.com/v1' });
    }
    if (!/^https?:\/\//i.test(body.baseUrl)) {
      return finish({ ok: false, message: '接口地址必须以 http:// 或 https:// 开头' });
    }
    if (!body.apiKey) {
      return finish({ ok: false, message: '请先填写 API Key' });
    }

    const probed = await detectUpstreamModels(body.baseUrl, body.apiKey);
    await audit(req, 'ai.test', body.provider, { mode, ok: probed.ok, status: probed.status });
    return finish({
      ok: probed.ok,
      message: probed.ok
        ? probed.models.length > 0
          ? `接口连通，读取到 ${probed.models.length} 个模型`
          : '接口连通，但上游未返回模型列表（不影响对话功能）'
        : probed.message || '自检未通过',
      models: probed.models,
    });
  });

  // 流式对话
  app.post(
    '/api/ai/chat',
    { preHandler: [app.authenticate, userRateLimit('ai')] },
    async (req, reply) => {
      const body = parse(chatSchema, req.body, 'AI 请求');

      const isPlatform = Boolean(body.usePlatform || body.provider === 'platform');
      let candidates = [];
      let modelSetting = null;
      if (isPlatform) {
        const balance = await readBalance(req.user.id);
        if (balance <= 0) {
          throw new HttpError(402, 'INSUFFICIENT_CREDITS', '平台积分不足，请先前往用户中心充值或兑换积分');
        }
        candidates = await resolvePlatformCandidates(body.provider, body.model);
        if (candidates.length === 0) {
          throw new HttpError(
            400,
            'PLATFORM_AI_DISABLED',
            '管理员尚未在后台启用并配置任何平台 AI 供应商密钥，请联系管理员或使用个人 API Key',
          );
        }
        try {
          const chosen = candidates[0];
          const row = chosen.row ?? (await getProviderRow(chosen.provider));
          const def = chosen.def ?? resolveProviderDef(chosen.provider, row);
          modelSetting = resolveModelSetting(row, def, body.model);
        } catch {
          /* 读不到就按无自定义设置处理 */
        }
      } else {
        candidates = [
          {
            provider: body.provider || 'custom',
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
          },
        ];
      }

      // 平台模式下：将后台为该模型（或供应商）配置的系统提示词注入到最前面，并对 temperature / maxTokens 按上限夹逼
      const platformPrompt = isPlatform ? String(modelSetting?.systemPrompt ?? '').trim() : '';
      const effTemperature =
        isPlatform && modelSetting && Number.isFinite(Number(modelSetting.temperature))
          ? Math.min(Number(body.temperature ?? 0.7), Number(modelSetting.temperature))
          : body.temperature;
      const effMaxTokens =
        isPlatform && modelSetting && Number.isFinite(Number(modelSetting.maxTokens))
          ? Math.min(Number(body.maxTokens ?? 4096), Number(modelSetting.maxTokens))
          : body.maxTokens;

      const baseMessages = body.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      }));
      const upstreamMessages = platformPrompt
        ? [{ role: 'system', content: platformPrompt }, ...baseMessages]
        : baseMessages;

      const controller = new AbortController();
      let clientGone = false;
      req.raw.on('close', () => {
        clientGone = true;
        controller.abort();
      });

      const startedAt = Date.now();
      let upstream = null;
      let chosenProvider = candidates[0].provider;
      let chosenCandidate = candidates[0];
      let lastError = '';

      for (const cand of candidates) {
        if (clientGone) return reply;
        const url = completionsUrl(cand.baseUrl);
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${cand.apiKey}`,
            },
            body: JSON.stringify({
              model: body.model,
              messages: upstreamMessages,
              temperature: effTemperature,
              max_tokens: effMaxTokens,
              stream: true,
              stream_options: { include_usage: true },
            }),
            signal: controller.signal,
          });
          if (resp.ok && resp.body) {
            upstream = resp;
            chosenProvider = cand.provider;
            chosenCandidate = cand;
            break;
          }
          let detail = '';
          try {
            detail = (await resp.text()).slice(0, 260);
          } catch {
            /* ignore */
          }
          lastError = `HTTP ${resp.status}${detail ? `：${detail}` : ''}`;
        } catch (err) {
          lastError = err?.message || String(err);
        }
      }

      if (!upstream || !upstream.body) {
        await recordUsage(req.user.id, chosenProvider, body.model, 0, 0, 0, {
          status: 'error',
          latencyMs: Date.now() - startedAt,
          errorCode: 'AI_UPSTREAM_ERROR',
        });
        throw new HttpError(502, 'AI_UPSTREAM_ERROR', `AI 服务调用失败（${lastError || '无可用上游'}）`);
      }

      // 若实际命中的候选供应商不是第一个，重新解析该供应商的模型设置以保证计费准确
      if (isPlatform && chosenCandidate && chosenCandidate.provider !== candidates[0]?.provider) {
        try {
          const row = chosenCandidate.row ?? (await getProviderRow(chosenCandidate.provider));
          const def = chosenCandidate.def ?? resolveProviderDef(chosenCandidate.provider, row);
          modelSetting = resolveModelSetting(row, def, body.model);
        } catch {
          /* ignore */
        }
      }

      // 进入裸流模式，自行控制 SSE 写出
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const send = (payload) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let usage = { in: 0, out: 0 };
      let collected = '';

      let streamErrored = false;
      try {
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') {
              continue;
            }
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              collected += delta;
              send({ type: 'delta', text: delta });
            }
            if (parsed?.usage) {
              usage = {
                in: Number(parsed.usage.prompt_tokens ?? 0),
                out: Number(parsed.usage.completion_tokens ?? 0),
              };
            }
          }
        }
      } catch (err) {
        streamErrored = true;
        if (!clientGone) {
          send({ type: 'error', error: `流式读取中断：${err.message}` });
        }
      }

      const promptText = upstreamMessages.map((m) => m.content).join('\n');
      const inTokens = usage.in > 0 ? usage.in : estimateTokens(promptText);
      const outTokens = usage.out > 0 ? usage.out : estimateTokens(collected);

      // 平台代付：优先采用模型治理中为该模型设置的单价，其次按计费规则结算
      let billing = null;
      if (isPlatform) {
        try {
          const billingConfig = await loadBilling();
          const cost = computeCost(billingConfig.modelPrices, body.model, inTokens, outTokens, modelSetting);
          const charged = await chargeCredits(req.user.id, cost, {
            kind: 'consume',
            ref: body.model,
            detail: { provider: chosenProvider, inTokens, outTokens, cost },
          });
          billing = { cost, balance: charged.balance, model: body.model, provider: chosenProvider };
        } catch (err) {
          req.log.error({ err, userId: req.user.id }, 'AI 积分扣费失败');
          if (!clientGone) send({ type: 'error', error: '本次调用的积分结算失败，请联系管理员核对' });
        }
      }

      if (!clientGone) {
        send({
          type: 'done',
          usage: { promptTokens: inTokens, completionTokens: outTokens, totalTokens: inTokens + outTokens },
          ...(billing ? { billing } : {}),
        });
      }

      if (!res.writableEnded && !res.destroyed) res.end();
      await recordUsage(req.user.id, chosenProvider, body.model, inTokens, outTokens, billing?.cost ?? 0, {
        status: streamErrored ? 'error' : 'ok',
        latencyMs: Date.now() - startedAt,
        errorCode: streamErrored ? 'STREAM_INTERRUPTED' : null,
      });
      return reply;
    },
  );
}

export default aiRoutes;
