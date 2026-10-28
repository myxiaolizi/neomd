/**
 * 知识库 API（1.1.0）。
 *
 * 设计原则（与产品的「本地优先」一致）：
 * **服务端不存储用户的仓库内容**。切片与检索全部在客户端完成，
 * 前端把命中的片段拼成 `context` 传给本接口，服务端只做两件事：
 * 1. 把 `context` 作为系统提示注入，再转发给 AI 供应商（复用 `/api/ai/chat` 的那套
 *    供应商解析、故障切换与扣费逻辑）；
 * 2. 记录一次知识库使用统计（查询次数 / tokens），便于用户在个人中心看到用量。
 *
 * 这样做的好处：
 * - 用户的笔记永远不会落到服务端磁盘或数据库；
 * - 私有化/自建部署时，服务端只是一层无状态的 AI 代理，替换成本极低；
 * - 也符合「通过 API 接口把仓库内容喂给 AI」的诉求 —— 内容是客户端主动提交的。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { HttpError, badRequest, forbidden, notFound, ok, unauthorized } from '../lib/http.js';
import { parse, parseId } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { bearerToken } from '../middleware/auth.js';
import { userRateLimit } from '../middleware/rate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import {
  chargeCredits,
  computeCost,
  listPlatformModels,
  listProviderRows,
  loadBilling,
  readBalance,
  resolveModelSetting,
  resolvePlatformCandidates,
} from '../lib/platform.js';

/** 单次请求允许携带的最大上下文长度（字符），防止把超大 payload 灌进来 */
const MAX_CONTEXT_CHARS = 60_000;
/** 单次请求允许的最大消息数 */
const MAX_MESSAGES = 40;

/* ------------------------------------------------------------------ */
/* 知识库访问令牌（1.1.8）                                            */
/* ------------------------------------------------------------------ */

/** 令牌前缀：便于用户在日志/界面上识别，也方便将来换算法时区分 */
const TOKEN_PREFIX = 'nmd_kb_';
/** 令牌明文总长度（不含前缀） */
const TOKEN_BODY_LEN = 40;
/** 令牌明文前若干位存入 token_prefix，供列表展示（不构成泄露：哈希才可校验） */
const TOKEN_DISPLAY_PREFIX_LEN = 12;
/** 有效期上限（天）：超过一年的一律拒绝，避免长期不轮换 */
const MAX_EXPIRES_DAYS = 365;
/** last_used_at 的写入节流：同一令牌 60 秒内只更新一次，避免每请求都写库 */
const LAST_USED_THROTTLE_MS = 60_000;

const tokenCreateSchema = z.object({
  name: z.string().trim().min(1, { message: '请填写令牌名称' }).max(80, { message: '令牌名称最多 80 个字符' }),
  scope: z.enum(['read', 'write']).optional().default('read'),
  /** 有效期（天）；0 或省略 = 永不过期 */
  expiresInDays: z.coerce.number().int().min(0).max(MAX_EXPIRES_DAYS).optional().default(0),
});

/** 生成一枚新令牌，返回明文与入库所需字段 */
function mintToken() {
  const body = randomToken(TOKEN_BODY_LEN);
  const plaintext = `${TOKEN_PREFIX}${body}`;
  return {
    plaintext,
    tokenHash: sha256(plaintext),
    tokenPrefix: plaintext.slice(0, TOKEN_DISPLAY_PREFIX_LEN),
  };
}

/** 对外投影：绝不返回 token_hash，只给前缀与状态 */
function tokenItem(row) {
  const now = Date.now();
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
  const revoked = Boolean(row.revoked_at);
  const expired = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now;
  return {
    id: Number(row.id),
    name: row.name,
    tokenPrefix: row.token_prefix ?? '',
    scope: row.scope === 'write' ? 'write' : 'read',
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at ?? null,
    /** 状态：active / revoked / expired，供前端显示徽章 */
    status: revoked ? 'revoked' : expired ? 'expired' : 'active',
    /** 是否仍可用于鉴权 */
    usable: !revoked && !expired,
  };
}

/**
 * 令牌鉴权：`Authorization: Bearer nmd_kb_xxx`。
 *
 * 与用户登录令牌并存：
 *  - 以 `nmd_kb_` 开头 → 走本函数（查 knowledge_tokens 表）；
 *  - 否则 → 由 `app.authenticate` 按 JWT 校验。
 *
 * 校验项：哈希匹配、未吊销、未过期、所属用户状态正常。
 * 成功后把 `req.user` / `req.knowledgeToken` 都填好，后续 handler 无感知。
 */
async function resolveKnowledgeToken(req) {
  const raw = bearerToken(req);
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;

  const hash = sha256(raw);
  const row = await queryOne('SELECT * FROM knowledge_tokens WHERE token_hash = ? LIMIT 1', [hash]);
  if (!row) throw unauthorized('知识库令牌无效', 'KB_TOKEN_INVALID');
  if (row.revoked_at) throw unauthorized('知识库令牌已被吊销', 'KB_TOKEN_REVOKED');
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw unauthorized('知识库令牌已过期', 'KB_TOKEN_EXPIRED');
  }

  const user = await queryOne(
    'SELECT id, email, username, role, status, quota_bytes, created_at FROM users WHERE id = ? LIMIT 1',
    [row.user_id],
  );
  if (!user) throw unauthorized('令牌所属账号不存在', 'KB_TOKEN_USER_MISSING');
  if (user.status !== 'active') throw forbidden('令牌所属账号已被停用', 'ACCOUNT_DISABLED');

  // last_used_at 节流更新：高频调用下不每个请求都写库
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - last > LAST_USED_THROTTLE_MS) {
    execute('UPDATE knowledge_tokens SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
  }

  return {
    token: tokenItem(row),
    user: {
      id: Number(user.id),
      email: user.email,
      username: user.username,
      role: user.role === 'admin' ? 'admin' : 'user',
      status: user.status,
      quotaBytes: Number(user.quota_bytes ?? 0),
      createdAt: user.created_at,
      lastLoginAt: null,
      lastLoginIp: null,
    },
  };
}

/**
 * 「登录令牌 或 知识库令牌」二选一鉴权。
 *
 * 用于 `/api/knowledge/chat` 与 `/api/knowledge/stats`：
 * 外部 AI / 智能体用知识库令牌，应用内用登录 JWT，两者都能通过。
 */
function knowledgeAuth(app) {
  return async function knowledgeAuthenticate(req) {
    const resolved = await resolveKnowledgeToken(req);
    if (resolved) {
      req.user = resolved.user;
      req.knowledgeToken = resolved.token;
      req.deviceId = null;
      return;
    }
    // 不是知识库令牌 → 交回标准 JWT 鉴权
    await app.authenticate(req);
  };
}

const knowledgeChatSchema = z
  .object({
    /** 用户提问 */
    query: z.string().trim().min(1, { message: '请输入问题' }).max(4000),
    /** 客户端检索出的知识库上下文（已由 buildContext 拼好） */
    context: z.string().max(MAX_CONTEXT_CHARS).optional().default(''),
    /** 命中的片段数（仅用于统计展示，服务端不校验其真实性） */
    chunkCount: z.coerce.number().int().min(0).max(200).optional().default(0),
    model: z.string({ error: '缺少模型名' }).trim().min(1, { message: '缺少模型名' }).max(120),
    provider: z.string().trim().max(40).optional().default('custom'),
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .regex(/^https?:\/\/[^\s]+$/i, { message: '接口地址必须以 http:// 或 https:// 开头' })
      .optional(),
    apiKey: z.string().trim().max(500).optional(),
    usePlatform: z.boolean().optional().default(false),
    temperature: z.coerce.number().min(0).max(2).optional().default(0.3),
    maxTokens: z.coerce.number().int().min(1).max(32768).optional().default(4096),
    /** 是否把上下文拼进系统提示（关闭则等价于普通问答，便于对比效果） */
    useContext: z.boolean().optional().default(true),
    /** 多轮历史（可选，便于「基于知识库追问」） */
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(20_000),
        }),
      )
      .max(MAX_MESSAGES)
      .optional()
      .default([]),
  })
  .refine((v) => v.usePlatform || v.provider === 'platform' || Boolean(v.baseUrl), {
    message: '缺少接口地址',
    path: ['baseUrl'],
  })
  .refine((v) => v.usePlatform || v.provider === 'platform' || Boolean(v.apiKey), {
    message: '缺少 API Key',
    path: ['apiKey'],
  });

const statsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

/** 系统提示：明确告知模型「以下是用户知识库摘录」，并约束引用行为 */
function buildSystemPrompt(context, useContext) {
  const base =
    '你是 Neo MD 的写作与知识助手。回答准确、精炼，使用标准 Markdown。' +
    '不要编造事实，不要输出无关寒暄。';
  if (!useContext || !context.trim()) return base;
  return (
    `${base}\n\n` +
    '下面是从用户个人知识库中检索出的相关片段。请**优先基于这些片段**回答，' +
    '并在引用具体内容时用「（来源：《文档标题》）」标注出处；' +
    '若片段中没有答案，请明确说明「知识库中没有相关内容」，再给出你自己的通用回答。\n\n' +
    '=== 知识库片段开始 ===\n' +
    context.slice(0, MAX_CONTEXT_CHARS) +
    '\n=== 知识库片段结束 ==='
  );
}

/** 记录一次知识库使用（失败不影响响应） */
async function recordKnowledgeUsage(userId, model, contextChars, chunkCount, inTokens, outTokens, cost) {
  try {
    await execute(
      `INSERT INTO knowledge_usage
         (user_id, model, context_chars, chunk_count, in_tokens, out_tokens, cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId,
        String(model).slice(0, 80),
        Math.max(0, Math.round(contextChars)),
        Math.max(0, Math.round(chunkCount)),
        Math.max(0, Math.round(inTokens)),
        Math.max(0, Math.round(outTokens)),
        Math.max(0, Math.round(cost)),
      ],
    );
  } catch {
    /* 统计失败忽略：不能因为它影响用户拿到回答 */
  }
}

/** 粗略估算 token（上游未回传 usage 时兜底） */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

export async function knowledgeRoutes(app) {
  /** 双鉴权：知识库令牌（nmd_kb_*）或登录 JWT 都能过 */
  const authenticate = knowledgeAuth(app);

  /**
   * 知识库问答（SSE 流式）。
   *
   * 与 `/api/ai/chat` 的差别：
   *  1. 把客户端检索出的 `context` 注入系统提示；
   *  2. 平台模式下叠加后台为「该模型」配置的系统提示词，并套用其温度 / maxTokens 上限；
   *  3. 记录知识库使用统计；
   *  4. 支持知识库令牌鉴权（外部 AI / 智能体调用）。
   */
  app.post(
    '/api/knowledge/chat',
    { preHandler: [authenticate, userRateLimit('ai')] },
    async (req, reply) => {
      const body = parse(knowledgeChatSchema, req.body, '知识库问答');

      const isPlatform = Boolean(body.usePlatform || body.provider === 'platform');
      let candidates = [];
      /** 平台模型的生效设置（温度 / maxTokens / 系统提示词），自带 Key 模式为空 */
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
        // 读取后台为该模型配置的设置（1.1.8）：系统提示词与参数上限
        try {
          const rows = await listProviderRows();
          const chosen = candidates[0];
          const def = { provider: chosen.provider, defaultModel: body.model };
          const row = rows.find((r) => r.provider === chosen.provider) ?? null;
          modelSetting = resolveModelSetting(row, def, body.model);
        } catch {
          /* 读不到就按无自定义设置处理，不影响调用 */
        }
      } else {
        candidates = [{ provider: body.provider || 'custom', baseUrl: body.baseUrl, apiKey: body.apiKey }];
      }

      // 系统提示词拼接顺序：平台模型提示词（若配置）→ 知识库上下文提示词
      const platformPrompt = String(modelSetting?.systemPrompt ?? '').trim();
      const basePrompt = buildSystemPrompt(body.context, body.useContext);
      const systemPrompt = platformPrompt ? `${platformPrompt}\n\n${basePrompt}` : basePrompt;

      // 参数上限：平台模式下不超过后台为该模型设的上限，用户传更小的值以用户为准
      const effTemperature =
        modelSetting && Number.isFinite(Number(modelSetting.temperature))
          ? Math.min(Number(body.temperature ?? 0.3), Number(modelSetting.temperature))
          : body.temperature;
      const effMaxTokens =
        modelSetting && Number.isFinite(Number(modelSetting.maxTokens))
          ? Math.min(Number(body.maxTokens ?? 4096), Number(modelSetting.maxTokens))
          : body.maxTokens;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...body.history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: body.query },
      ];

      const controller = new AbortController();
      let clientGone = false;
      req.raw.on('close', () => {
        clientGone = true;
        controller.abort();
      });

      const completionsUrl = (baseUrl) => {
        const trimmed = String(baseUrl).replace(/\/+$/, '');
        return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
      };

      let upstream = null;
      let chosenProvider = candidates[0].provider;
      let lastError = '';

      for (const cand of candidates) {
        if (clientGone) return reply;
        try {
          const resp = await fetch(completionsUrl(cand.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cand.apiKey}` },
            body: JSON.stringify({
              model: body.model,
              messages,
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
        throw new HttpError(502, 'KNOWLEDGE_UPSTREAM_ERROR', `知识库问答调用失败（${lastError || '无可用上游'}）`);
      }

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

      try {
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
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
        if (!clientGone) send({ type: 'error', error: `流式读取中断：${err.message}` });
      }

      const inTokens = usage.in > 0 ? usage.in : estimateTokens(messages.map((m) => m.content).join('\n'));
      const outTokens = usage.out > 0 ? usage.out : estimateTokens(collected);

      // 平台代付：按管理员配置的计费方式扣积分（与 /api/ai/chat 一致）
      let billing = null;
      if (isPlatform) {
        try {
          const billingConfig = await loadBilling();
          const cost = computeCost(billingConfig.modelPrices, body.model, inTokens, outTokens);
          const charged = await chargeCredits(req.user.id, cost, {
            kind: 'consume',
            ref: body.model,
            detail: { provider: chosenProvider, inTokens, outTokens, cost, source: 'knowledge' },
          });
          billing = { cost, balance: charged.balance, model: body.model, provider: chosenProvider };
        } catch (err) {
          req.log.error({ err, userId: req.user.id }, '知识库积分扣费失败');
          if (!clientGone) send({ type: 'error', error: '本次调用的积分结算失败，请联系管理员核对' });
        }
      }

      await recordKnowledgeUsage(
        req.user.id,
        body.model,
        body.context.length,
        body.chunkCount,
        inTokens,
        outTokens,
        billing?.cost ?? 0,
      );

      if (!clientGone) {
        send({
          type: 'done',
          usage: { promptTokens: inTokens, completionTokens: outTokens, totalTokens: inTokens + outTokens },
          contextChars: body.context.length,
          chunkCount: body.chunkCount,
          ...(billing ? { billing } : {}),
        });
      }

      if (!res.writableEnded && !res.destroyed) res.end();
      await audit(req, 'knowledge.chat', body.model, {
        provider: chosenProvider,
        chunkCount: body.chunkCount,
        contextChars: body.context.length,
        inTokens,
        outTokens,
      });
      return reply;
    },
  );

  /**
   * 知识库使用统计。
   *
   * 只统计「用量」这一层元数据（次数、tokens、上下文长度），
   * **不保存任何笔记内容**——`context` 只在内存里用于转发，写完即丢。
   */
  app.get('/api/knowledge/stats', { preHandler: [authenticate] }, async (req, reply) => {
    const params = parse(statsQuerySchema, req.query, '统计参数');
    const [total, today, rows] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(context_chars), 0) AS context_chars,
                COALESCE(SUM(chunk_count), 0) AS chunks
           FROM knowledge_usage WHERE user_id = ?`,
        [req.user.id],
      ),
      queryOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens
           FROM knowledge_usage WHERE user_id = ? AND created_at >= CURDATE()`,
        [req.user.id],
      ),
      query(
        `SELECT model, context_chars, chunk_count, in_tokens, out_tokens, cost, created_at
           FROM knowledge_usage WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
        [req.user.id, params.limit],
      ),
    ]);

    return ok(reply, {
      total: {
        calls: Number(total?.calls ?? 0),
        inTokens: Number(total?.in_tokens ?? 0),
        outTokens: Number(total?.out_tokens ?? 0),
        contextChars: Number(total?.context_chars ?? 0),
        chunks: Number(total?.chunks ?? 0),
      },
      today: {
        calls: Number(today?.calls ?? 0),
        inTokens: Number(today?.in_tokens ?? 0),
        outTokens: Number(today?.out_tokens ?? 0),
      },
      history: rows.map((r) => ({
        model: r.model ?? null,
        contextChars: Number(r.context_chars ?? 0),
        chunkCount: Number(r.chunk_count ?? 0),
        inTokens: Number(r.in_tokens ?? 0),
        outTokens: Number(r.out_tokens ?? 0),
        cost: Number(r.cost ?? 0),
        createdAt: r.created_at ?? null,
      })),
      /** 本次请求所用的鉴权方式：token=知识库令牌、jwt=账号登录 */
      authMode: req.knowledgeToken ? 'token' : 'jwt',
    });
  });

  /* -------------------------- 知识库令牌管理（1.1.8） -------------------------- */

  /**
   * 列出我的知识库令牌。
   *
   * 只返回前缀与状态，**绝不返回 token_hash 或明文**。
   * 用 JWT 鉴权（令牌不能用自己来管理自己）。
   */
  app.get('/api/knowledge/tokens', { preHandler: [app.authenticate] }, async (req, reply) => {
    const rows = await query(
      `SELECT id, name, token_prefix, scope, expires_at, last_used_at, revoked_at, created_at
         FROM knowledge_tokens WHERE user_id = ? ORDER BY id DESC`,
      [req.user.id],
    );
    return ok(reply, { tokens: rows.map(tokenItem) });
  });

  /**
   * 创建知识库令牌。
   *
   * **明文只在这一次响应里返回**（`token` 字段），之后任何接口都拿不回来。
   * 用户必须当场复制；丢了只能吊销后重建。
   */
  app.post('/api/knowledge/tokens', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(tokenCreateSchema, req.body, '令牌参数');

    // 每人最多 20 枚未吊销令牌，防止刷爆表
    const countRow = await queryOne(
      'SELECT COUNT(*) AS n FROM knowledge_tokens WHERE user_id = ? AND revoked_at IS NULL',
      [req.user.id],
    );
    if (Number(countRow?.n ?? 0) >= 20) {
      throw badRequest('未吊销的令牌已达上限（20 枚），请先吊销不用的令牌', 'TOKEN_LIMIT_REACHED');
    }

    const { plaintext, tokenHash, tokenPrefix } = mintToken();
    const expiresAt =
      Number(body.expiresInDays) > 0
        ? new Date(Date.now() + Number(body.expiresInDays) * 24 * 60 * 60 * 1000)
        : null;

    const result = await execute(
      `INSERT INTO knowledge_tokens
         (user_id, name, token_hash, token_prefix, scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [req.user.id, body.name, tokenHash, tokenPrefix, body.scope, expiresAt],
    );

    const row = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [result.insertId]);
    await audit(req, 'knowledge.token.create', `kb-token:${result.insertId}`, {
      name: body.name,
      scope: body.scope,
      expiresInDays: body.expiresInDays,
    });

    return ok(reply, {
      // ⚠️ 明文只在这里出现一次
      token: plaintext,
      item: tokenItem(row),
      warning: '请立即复制保存，关闭后无法再次查看该令牌明文。',
    });
  });

  /**
   * 吊销知识库令牌（软删除）。
   *
   * 只允许吊销自己的令牌；已吊销的重复吊销按幂等处理（返回当前状态）。
   */
  app.delete('/api/knowledge/tokens/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '令牌编号');
    const row = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('令牌不存在', 'TOKEN_NOT_FOUND');
    if (Number(row.user_id) !== Number(req.user.id)) {
      throw forbidden('不能操作他人的令牌', 'TOKEN_FORBIDDEN');
    }
    if (!row.revoked_at) {
      await execute('UPDATE knowledge_tokens SET revoked_at = NOW() WHERE id = ?', [id]);
      await audit(req, 'knowledge.token.revoke', `kb-token:${id}`, { name: row.name });
    }
    const saved = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [id]);
    return ok(reply, { item: tokenItem(saved) });
  });

  /**
   * 测试令牌是否可用。
   *
   * 设计取舍：**不接收明文令牌**，只按 id 校验「当前这枚令牌的配置是否可用」
   * （未吊销、未过期、所属账号正常）。理由：明文只在创建时出现过一次，
   * 服务端不该也不能再次拿到它；用 id 校验能覆盖 99% 的真实故障场景
   * （过期、被吊销、账号停用），且不引入新的泄露面。
   *
   * 真正的端到端验证（用令牌真的发一次请求）由前端在创建后立即用明文做，
   * 见 `POST /api/knowledge/tokens/:id/test` 的 `selfCheck` 说明。
   */
  app.post('/api/knowledge/tokens/:id/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '令牌编号');
    const row = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('令牌不存在', 'TOKEN_NOT_FOUND');
    if (Number(row.user_id) !== Number(req.user.id)) {
      throw forbidden('不能操作他人的令牌', 'TOKEN_FORBIDDEN');
    }

    const item = tokenItem(row);
    const checks = [];
    checks.push({
      key: 'exists',
      label: '令牌存在',
      ok: true,
      detail: `前缀 ${item.tokenPrefix}…`,
    });
    checks.push({
      key: 'revoked',
      label: '未被吊销',
      ok: !row.revoked_at,
      detail: row.revoked_at ? `已于 ${row.revoked_at} 吊销` : '正常',
    });
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
    checks.push({
      key: 'expired',
      label: '未过期',
      ok: expiresAt === null || expiresAt > Date.now(),
      detail: expiresAt === null ? '永不过期' : `到期时间 ${row.expires_at}`,
    });

    const user = await queryOne('SELECT status FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    checks.push({
      key: 'account',
      label: '所属账号可用',
      ok: user?.status === 'active',
      detail: user?.status === 'active' ? '正常' : '账号已被停用',
    });

    const passed = checks.every((c) => c.ok);
    await audit(req, 'knowledge.token.test', `kb-token:${id}`, { passed });

    return ok(reply, {
      passed,
      checks,
      item,
      /** 提示前端：真正的鉴权链路验证请用创建时拿到的明文令牌调 /api/knowledge/stats */
      selfCheckHint: '如需完整验证，请在创建后用该令牌调用 GET /api/knowledge/stats',
    });
  });
}

export default knowledgeRoutes;
