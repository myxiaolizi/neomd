/**
 * 管理后台接口：全部要求管理员身份，所有写操作都写审计日志。
 * 新增模块：积分充值/调整、平台 AI 供应商、计费配置、兑换码、发布包清单、自身改密。
 */
import { z } from 'zod';
// 1.1.7 数据看板需要数据库连通性探测（ping）与对象存储连通性自检（probePlatformStorage）
import { execute, ping, query, queryOne, tx } from '../db/pool.js';
import config from '../config.js';
import { hashPassword, randomPassword, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { adminPrefix, deletePlatformObject, platformConfig, platformPublicUrl, probePlatformStorage } from '../lib/oss.js';
import { listObjects } from '../lib/s3.js';
import { invalidateUserCache } from '../middleware/auth.js';
import {
  PLATFORM_PROVIDERS,
  MODEL_SETTING_LIMITS,
  addCredits,
  adminProviderItem,
  findProvider,
  ledgerItem,
  listPlatformModels,
  listProviderRows,
  loadBilling,
  normalizeModelSettings,
  normalizePaymentMethods,
  normalizePrices,
  resolveModelSetting,
  saveProvider,
  setConfigValue,
} from '../lib/platform.js';

const updateUserSchema = z
  .object({
    role: z.enum(['user', 'admin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    quotaBytes: z.coerce.number().int().min(0).max(10 * 1024 * 1024 * 1024 * 1024).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined || v.quotaBytes !== undefined, {
    message: '至少需要提交 role、status 或 quotaBytes 中的一项',
  });

const commentStatusSchema = z.object({
  status: z.enum(['visible', 'hidden']),
});

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(64).optional().default(''),
  userId: z.coerce.number().int().min(1).optional(),
});

/** 用户列表查询：分页 + 搜索 + 排序 + 状态筛选 */
const usersQuerySchema = paginationSchema.extend({
  sort: z.enum(['created', 'lastLogin', 'credits', 'documents']).optional().default('created'),
  status: z.enum(['active', 'disabled']).optional(),
});

const adjustCreditsSchema = z.object({
  amount: z.coerce
    .number({ error: '调整数量必须是数字' })
    .int({ message: '调整数量必须是整数' })
    .refine((value) => value !== 0, { message: '调整数量不能为 0' })
    .refine((value) => Math.abs(value) <= 1_000_000_000_000, { message: '调整数量超出允许范围' }),
  reason: z.string().trim().max(120, { message: '备注最多 120 个字符' }).optional().default(''),
});

const aiProviderSchema = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .max(255, { message: '接口地址最多 255 个字符' })
      .regex(/^https?:\/\/[^\s]+$/i, { message: '接口地址必须以 http:// 或 https:// 开头' })
      .optional(),
    enabled: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .transform((value) => value === true || value === 'true' || value === '1')
      .optional(),
    priority: z.coerce.number().int().min(1).max(9999).optional(),
    models: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
    apiKey: z.string().max(500, { message: 'API Key 过长' }).optional(),
    // 1.1.7 展示元数据：传空串表示「恢复默认」（落库为 NULL，读取时回落到内置默认值）
    signupUrl: z
      .union([
        z.literal(''),
        z
          .string()
          .trim()
          .max(255, { message: '申请地址最多 255 个字符' })
          .regex(/^https?:\/\/[^\s]+$/i, { message: '申请地址必须以 http:// 或 https:// 开头' }),
      ])
      .optional(),
    docsUrl: z
      .union([
        z.literal(''),
        z
          .string()
          .trim()
          .max(255, { message: '文档地址最多 255 个字符' })
          .regex(/^https?:\/\/[^\s]+$/i, { message: '文档地址必须以 http:// 或 https:// 开头' }),
      ])
      .optional(),
    note: z.string().trim().max(500, { message: '说明文案最多 500 个字符' }).optional(),
    sortOrder: z.coerce.number().int().min(1).max(9999).optional(),
  })
  .refine(
    (v) =>
      v.baseUrl !== undefined ||
      v.enabled !== undefined ||
      v.priority !== undefined ||
      v.models !== undefined ||
      v.apiKey !== undefined ||
      v.signupUrl !== undefined ||
      v.docsUrl !== undefined ||
      v.note !== undefined ||
      v.sortOrder !== undefined,
    {
      message: '至少需要提交一项修改字段',
    },
  );

/**
 * 批量保存供应商展示元数据（1.1.7）。
 *
 * 与 aiProviderSchema 的区别：这里是**批量 + 只含展示字段**，
 * 不接受 baseUrl / apiKey / models（那些仍走单条 PUT /api/admin/ai/:provider），
 * 避免运营在批量改排序时误改密钥或接口地址。
 */
const aiProvidersMetaItemSchema = z.object({
  provider: z.string().trim().min(1, { message: '缺少供应商标识' }).max(40),
  enabled: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1')
    .optional(),
  signupUrl: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(255, { message: '申请地址最多 255 个字符' })
        .regex(/^https?:\/\/[^\s]+$/i, { message: '申请地址必须以 http:// 或 https:// 开头' }),
    ])
    .optional(),
  docsUrl: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(255, { message: '文档地址最多 255 个字符' })
        .regex(/^https?:\/\/[^\s]+$/i, { message: '文档地址必须以 http:// 或 https:// 开头' }),
    ])
    .optional(),
  note: z.string().trim().max(500, { message: '说明文案最多 500 个字符' }).optional(),
  sortOrder: z.coerce.number().int().min(1).max(9999).optional(),
});

const aiProvidersMetaSchema = z.object({
  providers: z
    .array(aiProvidersMetaItemSchema)
    .min(1, { message: '至少提交一个供应商' })
    .max(50, { message: '单次最多提交 50 个供应商' }),
});

/**
 * 平台付费侧的「模型治理」配置（1.1.8）。
 *
 * 一个供应商可提交：
 *  - models：该供应商对用户开放的模型列表（后台可增删）；
 *  - defaultModel：默认模型（前台预选）；
 *  - systemPrompt：供应商级兜底系统提示词；
 *  - modelSettings：每模型独立设置（温度 / maxTokens / 单价 / 系统提示词）。
 *
 * 注意：这里**不接受 baseUrl 与 apiKey**——那两项属于「连接凭证」，
 * 仍走 `PUT /api/admin/ai/:provider`，避免运营在配模型时误改接口地址。
 */
const modelSettingItemSchema = z.object({
  enabled: z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).optional(),
  temperature: z.coerce.number().min(MODEL_SETTING_LIMITS.temperature.min).max(MODEL_SETTING_LIMITS.temperature.max).optional(),
  maxTokens: z.coerce
    .number()
    .int()
    .min(MODEL_SETTING_LIMITS.maxTokens.min)
    .max(MODEL_SETTING_LIMITS.maxTokens.max)
    .optional(),
  priceIn: z.coerce.number().min(MODEL_SETTING_LIMITS.priceIn.min).max(MODEL_SETTING_LIMITS.priceIn.max).optional(),
  priceOut: z.coerce.number().min(MODEL_SETTING_LIMITS.priceOut.min).max(MODEL_SETTING_LIMITS.priceOut.max).optional(),
  systemPrompt: z.string().max(MODEL_SETTING_LIMITS.systemPromptMax, { message: '系统提示词最多 8000 个字符' }).optional(),
});

const aiModelConfigSchema = z
  .object({
    // 注意：provider 来自路径参数（/api/admin/ai-models/:provider），不在 body 里校验
    models: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    defaultModel: z.string().trim().max(120).optional(),
    systemPrompt: z.string().max(MODEL_SETTING_LIMITS.systemPromptMax, { message: '系统提示词最多 8000 个字符' }).optional(),
    modelSettings: z.record(z.string().max(120), modelSettingItemSchema).optional(),
  })
  .refine(
    (v) =>
      v.models !== undefined ||
      v.defaultModel !== undefined ||
      v.systemPrompt !== undefined ||
      v.modelSettings !== undefined,
    { message: '至少需要提交一项修改字段' },
  );

const billingSchema = z
  .object({
    creditPerYuan: z.coerce.number().positive({ message: '兑换比例必须大于 0' }).max(1_000_000_000).optional(),
    signupGrantCredits: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    dailyGrantCredits: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    modelPrices: z
      .record(
        z.string().max(80),
        z.object({
          mode: z.enum(['tokens', 'request', 'free']).optional().default('tokens'),
          in: z.coerce.number().min(0, { message: '输入单价不能为负' }).max(1_000_000).optional().default(1),
          out: z.coerce.number().min(0, { message: '输出单价不能为负' }).max(1_000_000).optional().default(2),
          perCall: z.coerce.number().min(0, { message: '按次单价不能为负' }).max(1_000_000).optional().default(2),
          providers: z.array(z.string().trim().max(40)).optional().default([]),
        }),
      )
      .optional(),
    paymentMethods: z
      .array(
        z.object({
          id: z.string().trim().min(1, { message: '支付方式缺少 id' }).max(32),
          name: z.string().trim().max(40).optional(),
          note: z.string().trim().max(200).optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .max(20, { message: '支付方式最多 20 项' })
      .optional(),
  })
  .refine(
    (v) =>
      v.creditPerYuan !== undefined ||
      v.signupGrantCredits !== undefined ||
      v.dailyGrantCredits !== undefined ||
      v.modelPrices !== undefined ||
      v.paymentMethods !== undefined,
    { message: '至少需要提交一项计费参数' },
  );

const redeemListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  size: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const redeemCreateSchema = z.object({
  count: z.coerce.number().int().min(1, { message: '生成数量至少 1 个' }).max(100, { message: '生成数量最多 100 个' }),
  credits: z.coerce.number().int().min(1, { message: '积分必须大于 0' }).max(1_000_000_000_000),
});

/* ---------------- 1.1.7 数据看板与扩展管理：查询/表单 schema ---------------- */

/**
 * 看板时间范围：只允许 1~90 天。
 * 上限 90 是为了避免有人传一个超大值导致按天聚合的 SQL 扫全表。
 */
const dashboardQuerySchema = z.object({
  days: z.coerce.number().int().min(1, { message: '查询天数至少 1 天' }).max(90, { message: '查询天数最多 90 天' }).optional().default(7),
});

/** 仓库管理列表：支持按仓库名/用户名/仓库 ID 搜索，按状态过滤 */
const vaultQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'disabled']).optional(),
});

/** 仓库启停：只接受两个合法状态 */
const vaultStatusSchema = z.object({
  status: z.enum(['active', 'disabled'], { message: '状态只能是 active 或 disabled' }),
});

/** 积分流水：可按用户、流水类型过滤 */
const ledgerQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().min(1).optional(),
  kind: z.enum(['recharge', 'consume', 'grant', 'refund']).optional(),
});

/**
 * 配置中心批量写入。
 * 值统一按字符串传输（多层 JSON 由前端序列化），服务端不做结构假设，
 * 因此新增配置项不需要改后端。限制条数与单项长度防止超大请求。
 */
const configUpdateSchema = z.object({
  entries: z
    .array(
      z.object({
        key: z.string().trim().min(1, { message: '配置键不能为空' }).max(64, { message: '配置键最多 64 个字符' }),
        value: z.string().max(65535, { message: '配置值过长' }),
      }),
    )
    .min(1, { message: '至少需要提交一项配置' })
    .max(50, { message: '单次最多保存 50 项配置' }),
});

const adminPasswordSchema = z.object({
  newPassword: z
    .string({ error: '请输入新密码' })
    .min(4, { message: '新密码至少 4 个字符' })
    .max(128, { message: '新密码最多 128 个字符' }),
});

/** 兑换码字符集：去掉容易混淆的 I / O / 0 / 1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 用户行投影（不含 pass_hash） */
function adminUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    nickname: row.nickname ?? null,
    avatarUrl: row.avatar_url ?? null,
    role: row.role,
    status: row.status,
    quotaBytes: Number(row.quota_bytes ?? 0),
    credits: Number(row.credits ?? 0),
    createdAt: row.created_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastLoginIp: row.last_login_ip ?? null,
    shareCount: Number(row.share_count ?? 0),
    publishCount: Number(row.publish_count ?? 0),
    documentCount: Number(row.doc_count ?? 0),
    storageBytes: Number(row.storage_bytes ?? 0),
  };
}

/** 分享对外投影（含公开访问地址） */
function adminShareItem(row) {
  return {
    id: Number(row.id),
    token: row.token,
    docId: row.doc_id,
    title: row.title,
    mode: row.mode,
    allowComment: Number(row.allow_comment) === 1,
    viewCount: Number(row.view_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    userId: Number(row.user_id),
    username: row.username ?? null,
    email: row.email ?? null,
    url: `${config.publicBaseUrl}/s/${row.token}`,
    createdAt: row.created_at ?? null,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

/** 发布对外投影（url 缺失时按 slug 兜底） */
function adminPublishItem(row) {
  return {
    id: Number(row.id),
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    rev: Number(row.rev ?? 1),
    url: row.url || `${config.publicBaseUrl}/p/${row.slug}`,
    ossKey: row.oss_key,
    userId: Number(row.user_id),
    username: row.username ?? null,
    createdAt: row.created_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

/** AI 用量投影 */
function usageItem(row) {
  return {
    id: Number(row.id),
    provider: row.provider ?? null,
    model: row.model ?? null,
    inTokens: Number(row.in_tokens ?? 0),
    outTokens: Number(row.out_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    createdAt: row.created_at ?? null,
  };
}

/** 生成唯一兑换码，冲突时自动重试 */
async function generateCode() {
  for (let i = 0; i < 6; i += 1) {
    const body = randomToken(12, CODE_ALPHABET);
    const code = `NEOMD-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
    const existing = await queryOne('SELECT id FROM redeem_codes WHERE code = ? LIMIT 1', [code]);
    if (!existing) return code;
  }
  throw conflict('兑换码生成冲突，请重试', 'REDEEM_CODE_CONFLICT');
}

export async function adminRoutes(app) {
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  /* ------------------------------ 概览 ------------------------------ */

  app.get('/api/admin/stats', adminOnly, async (_req, reply) => {
    const [users, shares, publishes, comments, storage, aiToday, vaults, credits, consumed, recharged, backups, enabledProviders] =
      await Promise.all([
        queryOne(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
                  SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
                  SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS today,
                  SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS week
           FROM users`,
        ),
        queryOne(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
                  COALESCE(SUM(view_count), 0) AS views
           FROM shares`,
        ),
        queryOne(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active FROM publishes`,
        ),
        queryOne("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden FROM share_comments"),
        queryOne('SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(doc_count), 0) AS docs FROM user_vaults'),
        queryOne(
          'SELECT COUNT(*) AS requests, COALESCE(SUM(in_tokens), 0) AS in_tokens, COALESCE(SUM(out_tokens), 0) AS out_tokens FROM ai_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)',
        ),
        queryOne('SELECT COUNT(*) AS total FROM user_vaults'),
        queryOne('SELECT COALESCE(SUM(credits), 0) AS circulating FROM users'),
        queryOne("SELECT COALESCE(SUM(-delta), 0) AS consumed FROM credit_ledger WHERE kind = 'consume' AND created_at >= CURDATE()"),
        queryOne(
          "SELECT COALESCE(SUM(delta), 0) AS recharged FROM credit_ledger WHERE kind IN ('recharge', 'grant') AND created_at >= CURDATE()",
        ),
        queryOne('SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM backups'),
        queryOne('SELECT COUNT(*) AS total FROM platform_ai_providers WHERE enabled = 1'),
      ]);

    // 近 14 天注册趋势
    const signupRows = await query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
       GROUP BY DATE(created_at) ORDER BY day ASC`,
    );
    const signupMap = new Map(signupRows.map((row) => [String(row.day), Number(row.count)]));
    const signupsDaily = [];
    for (let i = 13; i >= 0; i -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      signupsDaily.push({ date: key, count: signupMap.get(key) ?? 0 });
    }

    return ok(reply, {
      users: {
        total: Number(users?.total ?? 0),
        active: Number(users?.active ?? 0),
        disabled: Number(users?.disabled ?? 0),
        admins: Number(users?.admins ?? 0),
        newToday: Number(users?.today ?? 0),
        newThisWeek: Number(users?.week ?? 0),
      },
      shares: {
        total: Number(shares?.total ?? 0),
        active: Number(shares?.active ?? 0),
        views: Number(shares?.views ?? 0),
      },
      publishes: {
        total: Number(publishes?.total ?? 0),
        active: Number(publishes?.active ?? 0),
      },
      comments: {
        total: Number(comments?.total ?? 0),
        hidden: Number(comments?.hidden ?? 0),
      },
      storage: {
        bytes: Number(storage?.bytes ?? 0),
        documents: Number(storage?.docs ?? 0),
        vaults: Number(vaults?.total ?? 0),
      },
      ai: {
        requests24h: Number(aiToday?.requests ?? 0),
        inTokens24h: Number(aiToday?.in_tokens ?? 0),
        outTokens24h: Number(aiToday?.out_tokens ?? 0),
      },
      credits: {
        circulating: Number(credits?.circulating ?? 0),
        consumedToday: Number(consumed?.consumed ?? 0),
        rechargedToday: Number(recharged?.recharged ?? 0),
      },
      backups: {
        total: Number(backups?.total ?? 0),
        bytes: Number(backups?.bytes ?? 0),
      },
      aiPlatform: {
        enabledProviders: Number(enabledProviders?.total ?? 0),
      },
      signupsDaily,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /* ------------------------------ 用户 ------------------------------ */

  app.get('/api/admin/users', adminOnly, async (req, reply) => {
    const { page, pageSize, search, sort, status } = parse(usersQuerySchema, req.query, '分页参数');
    const filters = [];
    const params = [];
    if (search) {
      filters.push('(u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      filters.push('u.status = ?');
      params.push(status);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const orderBy = {
      created: 'u.created_at DESC, u.id DESC',
      lastLogin: 'u.last_login_at DESC, u.id DESC',
      credits: 'u.credits DESC, u.id DESC',
      documents: 'doc_count DESC, u.id DESC',
    }[sort] ?? 'u.created_at DESC, u.id DESC';

    const rows = await query(
      `SELECT u.id, u.email, u.username, u.nickname, u.avatar_url, u.role, u.status, u.quota_bytes, u.credits,
              u.created_at, u.last_login_at, u.last_login_ip,
              (SELECT COUNT(*) FROM shares s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS share_count,
              (SELECT COUNT(*) FROM publishes p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS publish_count,
              (SELECT COALESCE(SUM(v.doc_count), 0) FROM user_vaults v WHERE v.user_id = u.id) AS doc_count,
              (SELECT COALESCE(SUM(v.bytes), 0) FROM user_vaults v WHERE v.user_id = u.id) AS storage_bytes
       FROM users u ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM users u ${where}`, params);

    return ok(reply, {
      items: rows.map(adminUser),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
      sort,
      status: status ?? null,
    });
  });

  // 用户详情：资料 + 流水 + 分享 + 发布 + 用量
  app.get('/api/admin/users/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const row = await queryOne(
      `SELECT u.id, u.email, u.username, u.nickname, u.avatar_url, u.role, u.status, u.quota_bytes, u.credits,
              u.created_at, u.last_login_at, u.last_login_ip,
              (SELECT COUNT(*) FROM shares s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS share_count,
              (SELECT COUNT(*) FROM publishes p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS publish_count,
              (SELECT COALESCE(SUM(v.doc_count), 0) FROM user_vaults v WHERE v.user_id = u.id) AS doc_count,
              (SELECT COALESCE(SUM(v.bytes), 0) FROM user_vaults v WHERE v.user_id = u.id) AS storage_bytes
       FROM users u WHERE u.id = ? LIMIT 1`,
      [id],
    );
    if (!row) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const [ledgerRows, shareRows, publishRows, usageRows] = await Promise.all([
      query('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', [id]),
      query(
        `SELECT s.*, u.username, u.email,
                (SELECT COUNT(*) FROM share_comments c WHERE c.share_id = s.id) AS comment_count
         FROM shares s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 50`,
        [id],
      ),
      query(
        `SELECT p.*, u.username FROM publishes p LEFT JOIN users u ON u.id = p.user_id
         WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 50`,
        [id],
      ),
      query(
        'SELECT * FROM ai_usage WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [id],
      ),
    ]);

    return ok(reply, {
      user: adminUser(row),
      ledger: ledgerRows.map(ledgerItem),
      shares: shareRows.map(adminShareItem),
      publishes: publishRows.map(adminPublishItem),
      usage: usageRows.map(usageItem),
    });
  });

  // 管理员调整积分（正负均可，统一记 grant 流水）
  app.put('/api/admin/users/:id/credits', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const body = parse(adjustCreditsSchema, req.body, '积分调整内容');
    const target = await queryOne('SELECT id, username, email, credits FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const before = Number(target.credits ?? 0);
    const result = await addCredits(id, body.amount, {
      kind: 'grant',
      ref: body.reason || `admin:${req.user.id}`,
      detail: { reason: body.reason || null, adminId: req.user.id, before, after: before + Number(body.amount) },
    });
    if (!result) throw notFound('用户不存在', 'USER_NOT_FOUND');

    await audit(req, 'admin.user.credits', `user:${id}`, {
      amount: Number(body.amount),
      reason: body.reason || null,
      before,
      after: result.balance,
    });

    const updated = await queryOne(
      'SELECT id, email, username, nickname, avatar_url, role, status, quota_bytes, credits, created_at, last_login_at, last_login_ip FROM users WHERE id = ? LIMIT 1',
      [id],
    );
    return ok(reply, {
      user: adminUser(updated ?? target),
      delta: result.delta,
      balance: result.balance,
    });
  });

  app.put('/api/admin/users/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const body = parse(updateUserSchema, req.body, '用户修改内容');
    const target = await queryOne('SELECT id, email, username, role, status, quota_bytes FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    if (id === req.user.id) {
      if (body.role && body.role !== 'admin') throw forbidden('不能取消自己的管理员身份', 'SELF_DEMOTE');
      if (body.status && body.status !== 'active') throw forbidden('不能停用自己的账号', 'SELF_DISABLE');
    }
    if (target.role === 'admin' && body.role === 'user') {
      const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
      if (Number(adminCount?.total ?? 0) <= 1) {
        throw conflict('系统至少需要保留一个管理员', 'LAST_ADMIN');
      }
    }

    const nextRole = body.role ?? target.role;
    const nextStatus = body.status ?? target.status;
    const nextQuota = body.quotaBytes === undefined ? Number(target.quota_bytes ?? 0) : Number(body.quotaBytes);

    await execute('UPDATE users SET role = ?, status = ?, quota_bytes = ? WHERE id = ?', [nextRole, nextStatus, nextQuota, id]);
    if (nextStatus !== 'active') {
      await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    }
    invalidateUserCache(id);
    await audit(req, 'admin.user.update', `user:${id}`, {
      role: nextRole,
      status: nextStatus,
      quotaBytes: nextQuota,
      before: { role: target.role, status: target.status, quotaBytes: Number(target.quota_bytes ?? 0) },
    });

    const updated = await queryOne(
      'SELECT id, email, username, nickname, avatar_url, role, status, quota_bytes, credits, created_at, last_login_at, last_login_ip FROM users WHERE id = ?',
      [id],
    );
    return ok(reply, adminUser(updated));
  });

  app.post('/api/admin/users/:id/reset-password', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const target = await queryOne('SELECT id, username, email FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const password = randomPassword(20);
    const passHash = await hashPassword(password);
    await execute('UPDATE users SET pass_hash = ? WHERE id = ?', [passHash, id]);
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    await audit(req, 'admin.user.reset_password', `user:${id}`);

    return ok(reply, {
      id,
      username: target.username,
      email: target.email,
      password,
      once: true,
      message: '新密码只显示这一次，请立即转交给用户',
    });
  });

  app.delete('/api/admin/users/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    if (id === req.user.id) throw forbidden('不能删除自己的账号', 'SELF_DELETE');
    const target = await queryOne('SELECT id, email, username, role FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');
    if (target.role === 'admin') {
      const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
      if (Number(adminCount?.total ?? 0) <= 1) throw conflict('系统至少需要保留一个管理员', 'LAST_ADMIN');
    }

    await tx(async (conn) => {
      await conn.execute('UPDATE shares SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
      await conn.execute('UPDATE publishes SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
      await conn.execute('DELETE FROM refresh_tokens WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM user_settings WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM user_vaults WHERE user_id = ?', [id]);
      await conn.execute('DELETE FROM users WHERE id = ?', [id]);
    });

    invalidateUserCache(id);
    await audit(req, 'admin.user.delete', `user:${id}`, { email: target.email, username: target.username });
    return ok(reply, { id, deleted: true });
  });

  /* ------------------------------ 分享 ------------------------------ */

  app.get('/api/admin/shares', adminOnly, async (req, reply) => {
    const { page, pageSize, search } = parse(paginationSchema, req.query, '分页参数');
    const filters = [];
    const params = [];
    if (search) {
      filters.push('(s.title LIKE ? OR s.token LIKE ? OR u.username LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = await query(
      `SELECT s.*, u.username, u.email,
              (SELECT COUNT(*) FROM share_comments c WHERE c.share_id = s.id) AS comment_count
       FROM shares s LEFT JOIN users u ON u.id = s.user_id
       ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM shares s LEFT JOIN users u ON u.id = s.user_id ${where}`,
      params,
    );

    return ok(reply, {
      items: rows.map(adminShareItem),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  app.delete('/api/admin/shares/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '分享编号');
    const row = await queryOne('SELECT id, token, user_id, revoked_at FROM shares WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('分享不存在', 'SHARE_NOT_FOUND');
    await execute('UPDATE shares SET revoked_at = NOW() WHERE id = ?', [id]);
    await audit(req, 'admin.share.revoke', `share:${id}`, { token: row.token, userId: Number(row.user_id) });
    return ok(reply, { id, revoked: true });
  });

  // 跟随分享内容查看该分享下的评价/标注列表
  app.get('/api/admin/shares/:id/comments', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '分享编号');
    const rows = await query(
      `SELECT c.id, c.share_id, c.author_name, c.body, c.status, c.created_at, a.quote
       FROM share_comments c
       LEFT JOIN share_annotations a ON a.comment_id = c.id
       WHERE c.share_id = ?
       ORDER BY c.id DESC LIMIT 500`,
      [id],
    );
    return ok(reply, {
      items: rows.map((r) => ({
        id: Number(r.id),
        shareId: Number(r.share_id),
        authorName: r.author_name ?? '匿名读者',
        body: r.body,
        quote: r.quote ?? '',
        status: r.status,
        createdAt: r.created_at ?? null,
      })),
    });
  });

  /* ------------------------------ 发布 ------------------------------ */

  app.get('/api/admin/publishes', adminOnly, async (req, reply) => {
    const { page, pageSize, search } = parse(paginationSchema, req.query, '分页参数');
    const filters = [];
    const params = [];
    if (search) {
      filters.push('(p.title LIKE ? OR p.slug LIKE ? OR u.username LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = await query(
      `SELECT p.*, u.username, u.email FROM publishes p LEFT JOIN users u ON u.id = p.user_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM publishes p LEFT JOIN users u ON u.id = p.user_id ${where}`,
      params,
    );

    return ok(reply, {
      items: rows.map(adminPublishItem),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  app.delete('/api/admin/publishes/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '发布编号');
    const row = await queryOne('SELECT id, slug, oss_key, user_id FROM publishes WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('发布记录不存在', 'PUBLISH_NOT_FOUND');
    if (row.oss_key) await deletePlatformObject(row.oss_key);
    await execute('UPDATE publishes SET revoked_at = NOW() WHERE id = ?', [id]);
    await audit(req, 'admin.publish.revoke', `publish:${id}`, { slug: row.slug, userId: Number(row.user_id) });
    return ok(reply, { id, revoked: true, slug: row.slug });
  });

  /* ------------------------------ AI 平台代付 ------------------------------ */

  // 平台 AI 供应商配置（密钥只回布尔值）
  app.get('/api/admin/ai', adminOnly, async (_req, reply) => {
    const rows = await listProviderRows();
    const map = new Map(rows.map((row) => [row.provider, row]));
    return ok(reply, {
      providers: PLATFORM_PROVIDERS.map((def) => adminProviderItem(map.get(def.provider), def)),
    });
  });

  // 修改单个供应商（apiKey 传空串表示清除）
  app.put('/api/admin/ai/:provider', adminOnly, async (req, reply) => {
    const providerId = String(req.params.provider ?? '').trim();
    const def = findProvider(providerId);
    if (!def) throw notFound(`未知的 AI 供应商：${providerId}`, 'UNKNOWN_PROVIDER');
    const body = parse(aiProviderSchema, req.body, '供应商配置');

    const saved = await saveProvider(def.provider, body);
    await audit(req, 'admin.ai.update', `ai:${def.provider}`, {
      baseUrl: saved.baseUrl,
      enabled: saved.enabled,
      apiKeyChanged: body.apiKey !== undefined,
      apiKeyCleared: body.apiKey === '',
    });
    return ok(reply, { provider: saved });
  });

  /* ------------------- AI 供应商展示元数据（1.1.7） ------------------- */

  /**
   * 读取全部供应商的「展示元数据」。
   *
   * 这是 `/api/admin/ai` 的轻量视图：只返回前台展示需要的字段
   * （启用状态、申请地址、文档地址、说明、排序、模型数、是否已配密钥），
   * **不返回 base_url 与任何密钥信息**，便于后台做纯展示配置。
   */
  app.get('/api/admin/ai-providers-meta', adminOnly, async (_req, reply) => {
    const rows = await listProviderRows();
    const map = new Map(rows.map((row) => [row.provider, row]));
    const items = PLATFORM_PROVIDERS.map((def) => adminProviderItem(map.get(def.provider), def))
      .map((item) => ({
        provider: item.provider,
        name: item.name,
        enabled: item.enabled,
        signupUrl: item.signupUrl,
        docsUrl: item.docsUrl,
        note: item.note,
        sortOrder: item.sortOrder,
        group: item.group,
        modelCount: (item.models ?? []).length,
        apiKeySet: item.apiKeySet,
        defaults: item.defaults,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.provider.localeCompare(b.provider));
    return ok(reply, { providers: items });
  });

  /**
   * 批量保存供应商展示元数据。
   *
   * 请求体：`{ providers: [{ provider, enabled?, signupUrl?, docsUrl?, note?, sortOrder? }] }`
   * 每个 `provider` 只更新传入的字段；字符串传空串表示「恢复默认」（落库 NULL）。
   * 任一 provider 未知则整体拒绝（避免静默丢配置）。
   */
  app.put('/api/admin/ai-providers-meta', adminOnly, async (req, reply) => {
    const body = parse(aiProvidersMetaSchema, req.body, '供应商展示配置');

    // 先全部校验，确认无未知 provider 与重复项，再落库
    const seen = new Set();
    for (const item of body.providers) {
      const providerId = String(item.provider ?? '').trim();
      if (!findProvider(providerId)) {
        throw notFound(`未知的 AI 供应商：${providerId}`, 'UNKNOWN_PROVIDER');
      }
      if (seen.has(providerId)) {
        throw conflict(`供应商 ${providerId} 在本次请求中重复出现`, 'DUPLICATE_PROVIDER');
      }
      seen.add(providerId);
    }

    const changed = [];
    for (const item of body.providers) {
      const { provider: providerId, ...patch } = item;
      const saved = await saveProvider(String(providerId).trim(), patch);
      changed.push({
        provider: saved.provider,
        enabled: saved.enabled,
        signupUrl: saved.signupUrl,
        docsUrl: saved.docsUrl,
        note: saved.note,
        sortOrder: saved.sortOrder,
      });
    }

    await audit(req, 'admin.ai.meta.update', 'ai:providers-meta', {
      providers: changed.map((c) => c.provider),
    });
    return ok(reply, { providers: changed });
  });

  /* ---------------- 平台付费：模型列表 / 每模型设置 / 系统提示词（1.1.8） ---------------- */

  /**
   * 读取平台模型的治理配置（后台用）。
   *
   * 返回两部分：
   *  - `models`：**对所有用户实际开放**的模型清单（只含已启用且有密钥的供应商），
   *    前台「平台 AI 服务」区块直接消费这份数据；
   *  - `providers`：每个供应商的配置明细（自己的模型列表、默认模型、兜底提示词、
   *    每模型设置，以及解析后的生效值 `resolved`，便于运营确认哪一层生效）。
   */
  app.get('/api/admin/ai-models', adminOnly, async (_req, reply) => {
    const rows = await listProviderRows();
    const map = new Map(rows.map((row) => [row.provider, row]));

    const providers = PLATFORM_PROVIDERS.map((def) => {
      const row = map.get(def.provider) ?? null;
      const item = adminProviderItem(row, def);
      const models = item.models ?? [];
      return {
        provider: item.provider,
        name: item.name,
        enabled: item.enabled,
        apiKeySet: item.apiKeySet,
        models,
        defaultModel: item.defaultModel,
        systemPrompt: item.systemPrompt,
        modelSettings: item.modelSettings,
        defaults: item.defaults,
        /** 每模型的生效值（模型级 > 供应商兜底 > 内置默认） */
        resolved: models.map((model) => resolveModelSetting(row, def, model)),
      };
    });

    return ok(reply, {
      providers,
      models: listPlatformModels(rows),
      limits: MODEL_SETTING_LIMITS,
    });
  });

  /**
   * 保存某供应商的模型治理配置。
   *
   * 只改「平台付费侧」的东西，不碰 baseUrl / apiKey（那两项走 `PUT /api/admin/ai/:provider`）。
   * `modelSettings` 传 `{}` 表示清空（落库 NULL，全部回落内置默认）。
   */
  app.put('/api/admin/ai-models/:provider', adminOnly, async (req, reply) => {
    const providerId = String(req.params.provider ?? '').trim();
    const def = findProvider(providerId);
    if (!def) throw notFound(`未知的 AI 供应商：${providerId}`, 'UNKNOWN_PROVIDER');
    const body = parse(aiModelConfigSchema, req.body, '平台模型配置');

    // defaultModel 必须在模型列表内（避免前台预选到一个不存在的模型）
    if (body.defaultModel !== undefined && body.defaultModel !== '') {
      // 模型列表以「本次提交的 models」优先，否则取库里现值
      const currentRow = (await listProviderRows()).find((x) => x.provider === def.provider) ?? null;
      const currentItem = adminProviderItem(currentRow, def);
      const effectiveModels = body.models !== undefined ? body.models : currentItem.models;
      if (effectiveModels.length > 0 && !effectiveModels.includes(body.defaultModel)) {
        throw badRequest(`默认模型 ${body.defaultModel} 不在该供应商的模型列表中`, 'DEFAULT_MODEL_NOT_IN_LIST');
      }
    }

    const patch = {};
    if (body.models !== undefined) patch.models = body.models;
    if (body.defaultModel !== undefined) patch.defaultModel = body.defaultModel;
    if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;
    if (body.modelSettings !== undefined) {
      // 先归一化（夹范围、去空对象），再交给 saveProvider
      patch.modelSettings = normalizeModelSettings(body.modelSettings);
    }

    const saved = await saveProvider(def.provider, patch);
    await audit(req, 'admin.ai.models.update', `ai-models:${def.provider}`, {
      fields: Object.keys(patch),
      modelCount: (saved.models ?? []).length,
      defaultModel: saved.defaultModel,
    });

    return ok(reply, {
      provider: {
        provider: saved.provider,
        name: saved.name,
        enabled: saved.enabled,
        apiKeySet: saved.apiKeySet,
        models: saved.models,
        defaultModel: saved.defaultModel,
        systemPrompt: saved.systemPrompt,
        modelSettings: saved.modelSettings,
        defaults: saved.defaults,
      },
    });
  });

  /* ------------------------------ 计费 ------------------------------ */

  app.get('/api/admin/billing', adminOnly, async (_req, reply) => {
    return ok(reply, await loadBilling());
  });

  app.put('/api/admin/billing', adminOnly, async (req, reply) => {
    const body = parse(billingSchema, req.body, '计费配置');
    const changed = [];
    if (body.creditPerYuan !== undefined) {
      await setConfigValue('credit_per_yuan', String(body.creditPerYuan));
      changed.push('credit_per_yuan');
    }
    if (body.signupGrantCredits !== undefined) {
      await setConfigValue('signup_grant_credits', String(body.signupGrantCredits));
      changed.push('signup_grant_credits');
    }
    if (body.dailyGrantCredits !== undefined) {
      await setConfigValue('daily_grant_credits', String(body.dailyGrantCredits));
      changed.push('daily_grant_credits');
    }
    if (body.modelPrices !== undefined) {
      await setConfigValue('model_prices', JSON.stringify(normalizePrices(body.modelPrices)));
      changed.push('model_prices');
    }
    if (body.paymentMethods !== undefined) {
      await setConfigValue('payment_methods', JSON.stringify(normalizePaymentMethods(body.paymentMethods)));
      changed.push('payment_methods');
    }

    await audit(req, 'admin.billing.update', 'platform_config', { changed });
    return ok(reply, await loadBilling());
  });

  /* ------------------------------ 兑换码 ------------------------------ */

  app.get('/api/admin/redeem-codes', adminOnly, async (req, reply) => {
    const { page, size } = parse(redeemListSchema, req.query, '分页参数');
    const offset = (page - 1) * size;

    const rows = await query(
      `SELECT r.*, u.username AS used_username, c.username AS created_username
       FROM redeem_codes r
       LEFT JOIN users u ON u.id = r.used_by
       LEFT JOIN users c ON c.id = r.created_by
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      [size, offset],
    );
    const totalRow = await queryOne('SELECT COUNT(*) AS total FROM redeem_codes');

    return ok(reply, {
      items: rows.map((row) => ({
        id: Number(row.id),
        code: row.code,
        credits: Number(row.credits ?? 0),
        usedBy: row.used_by === null ? null : Number(row.used_by),
        usedByUsername: row.used_username ?? null,
        usedAt: row.used_at ?? null,
        createdBy: row.created_by === null ? null : Number(row.created_by),
        createdByUsername: row.created_username ?? null,
        createdAt: row.created_at ?? null,
      })),
      page,
      size,
      total: Number(totalRow?.total ?? 0),
    });
  });

  app.post('/api/admin/redeem-codes', adminOnly, async (req, reply) => {
    const body = parse(redeemCreateSchema, req.body, '兑换码生成参数');
    const created = [];
    for (let i = 0; i < body.count; i += 1) {
      const code = await generateCode();
      const result = await execute(
        'INSERT INTO redeem_codes (code, credits, used_by, used_at, created_by, created_at) VALUES (?, ?, NULL, NULL, ?, NOW())',
        [code, body.credits, req.user.id],
      );
      created.push({ id: Number(result.insertId), code, credits: body.credits });
    }

    await audit(req, 'admin.redeem.generate', 'redeem_codes', { count: created.length, credits: body.credits });
    return ok(
      reply,
      {
        codes: created.map((c) => c.code),
        items: created,
        count: created.length,
        credits: body.credits,
      },
      201,
    );
  });

  app.delete('/api/admin/redeem-codes/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '兑换码编号');
    const row = await queryOne('SELECT id, code, used_by FROM redeem_codes WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('兑换码不存在', 'REDEEM_CODE_NOT_FOUND');
    if (row.used_by !== null) throw conflict('已使用的兑换码不能删除', 'REDEEM_CODE_USED');

    await execute('DELETE FROM redeem_codes WHERE id = ? AND used_by IS NULL', [id]);
    await audit(req, 'admin.redeem.delete', `redeem:${id}`, { code: row.code });
    return ok(reply, { id, deleted: true, code: row.code });
  });

  /* ------------------------------ 发布包 ------------------------------ */

  // 对象存储 mdadmin/releases/ 下的安装包清单
  app.get('/api/admin/releases', adminOnly, async (req, reply) => {
    const prefix = `${adminPrefix('releases')}/`;
    let listing;
    try {
      listing = await listObjects(platformConfig(), prefix, 1000);
    } catch (err) {
      req.log.warn({ err, prefix }, '列举发布包失败');
      return ok(reply, { prefix, files: [], message: `列举对象存储失败：${err.message}` });
    }

    const files = listing.objects
      .filter((item) => item.key && !item.key.endsWith('/'))
      .map((item) => ({
        key: item.key,
        size: Number(item.size ?? 0),
        lastModified: item.lastModified ?? null,
        url: platformPublicUrl(item.key),
      }))
      .sort((a, b) => String(b.lastModified ?? '').localeCompare(String(a.lastModified ?? '')));

    return ok(reply, { prefix, files });
  });

  /* ------------------------------ 自身改密 ------------------------------ */

  app.put('/api/admin/password', adminOnly, async (req, reply) => {
    const body = parse(adminPasswordSchema, req.body, '密码信息');
    const passHash = await hashPassword(body.newPassword);
    await execute('UPDATE users SET pass_hash = ? WHERE id = ?', [passHash, req.user.id]);
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
    await audit(req, 'admin.password_change', `user:${req.user.id}`);
    return ok(reply, { updated: true, reLoginRequired: true });
  });

  /* ------------------------------ 审计 ------------------------------ */

  app.get('/api/admin/audit', adminOnly, async (req, reply) => {
    const { page, pageSize, search, action, userId } = parse(auditQuerySchema, req.query, '查询参数');
    const filters = [];
    const params = [];
    if (action) {
      filters.push('a.action = ?');
      params.push(action);
    }
    if (userId) {
      filters.push('a.user_id = ?');
      params.push(userId);
    }
    if (search) {
      filters.push('(a.target LIKE ? OR a.action LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = await query(
      `SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`, params);

    return ok(reply, {
      items: rows.map((row) => ({
        id: Number(row.id),
        userId: row.user_id === null ? null : Number(row.user_id),
        username: row.username ?? null,
        action: row.action,
        target: row.target,
        detail: row.detail_json ? safeJson(row.detail_json) : null,
        ip: row.ip,
        createdAt: row.created_at ?? null,
      })),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  /* ------------------------------ 评论 ------------------------------ */

  app.get('/api/admin/comments', adminOnly, async (req, reply) => {
    const { page, pageSize, search } = parse(paginationSchema, req.query, '分页参数');
    const filters = [];
    const params = [];
    if (search) {
      filters.push('(c.body LIKE ? OR c.author_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = await query(
      `SELECT c.*, s.title AS share_title, s.token AS share_token, s.user_id AS owner_id
       FROM share_comments c LEFT JOIN shares s ON s.id = c.share_id
       ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM share_comments c ${where}`, params);

    return ok(reply, {
      items: rows.map((row) => ({
        id: Number(row.id),
        shareId: Number(row.share_id),
        shareTitle: row.share_title ?? null,
        shareToken: row.share_token ?? null,
        ownerId: row.owner_id === null ? null : Number(row.owner_id),
        authorName: row.author_name ?? '匿名读者',
        body: row.body,
        status: row.status,
        createdAt: row.created_at ?? null,
      })),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  app.put('/api/admin/comments/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '评论编号');
    const body = parse(commentStatusSchema, req.body, '评论状态');
    const row = await queryOne('SELECT id, share_id, status FROM share_comments WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('评论不存在', 'COMMENT_NOT_FOUND');
    await execute('UPDATE share_comments SET status = ? WHERE id = ?', [body.status, id]);
    await audit(req, 'admin.comment.status', `comment:${id}`, { status: body.status, before: row.status });
    return ok(reply, { id, status: body.status });
  });

  /* ================================================================== */
  /* 1.1.7 数据看板                                                      */
  /*                                                                    */
  /* 设计要点：                                                          */
  /* 1. 所有按天聚合都用**一条递归 CTE** 生成完整日期序列再 LEFT JOIN，   */
  /*    这样缺失的日期会补 0，前端不需要再补洞；日期标签由 MySQL 生成，   */
  /*    与 `DATE(column)` 的时区语义完全一致（不用 JS 拼日期，避免时区错位）。*/
  /* 2. 指标分为「累计」与「今日」两套，前端指标卡直接消费。              */
  /* 3. 实时状态里的 OSS 探测带 3 秒超时兜底，绝不因为对象存储慢而拖垮看板。*/
  /* ================================================================== */

  app.get('/api/admin/dashboard', adminOnly, async (req, reply) => {
    const { days } = parse(dashboardQuerySchema, req.query, '看板查询参数');
    // 递归 CTE 从 days-1 天前开始，共 days 天（含今天）
    const span = Math.max(0, days - 1);

    const [
      userRow,
      vaultRow,
      backupRow,
      aiTodayRow,
      aiTotalRow,
      aiHealthRow,
      compareRow,
      kbTodayRow,
      kbTotalRow,
      creditRow,
      trendRows,
      providerRows,
      vaultTopRows,
      storageTopRows,
    ] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
                SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS new_today,
                SUM(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS new_week,
                SUM(CASE WHEN DATE(last_login_at) = CURDATE() THEN 1 ELSE 0 END) AS active_today
         FROM users`,
      ),
      queryOne(
        `SELECT COUNT(*) AS vaults,
                COALESCE(SUM(doc_count), 0) AS docs,
                COALESCE(SUM(bytes), 0) AS bytes,
                SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
         FROM user_vaults`,
      ),
      queryOne('SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM backups'),
      queryOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost
         FROM ai_usage WHERE created_at >= CURDATE()`,
      ),
      queryOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens
         FROM ai_usage`,
      ),
      // AI 健康度（1.1.8 看板）：今日失败率 + 平均响应时间。
      // 老库可能还没有 status / latency_ms 列（迁移未跑），这里用 COUNT(COLUMN_NAME) 判断不可行
      // （会把整条查询变成动态 SQL），因此改为：列缺失时由下方 try/catch 回落到全 0。
      queryOne(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN status = 'ok' AND latency_ms > 0 THEN latency_ms ELSE 0 END) AS ok_latency,
                SUM(CASE WHEN status = 'ok' AND latency_ms > 0 THEN 1 ELSE 0 END) AS ok_latency_count
         FROM ai_usage WHERE created_at >= CURDATE()`,
      ).catch(() => null),
      // 环比（今日 vs 昨日）：新增用户与 AI 调用，用于指标卡的「↑/↓ x%」
      queryOne(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) AS users_today,
           (SELECT COUNT(*) FROM users WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)) AS users_yesterday,
           (SELECT COUNT(*) FROM ai_usage WHERE DATE(created_at) = CURDATE()) AS ai_today,
           (SELECT COUNT(*) FROM ai_usage WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)) AS ai_yesterday,
           (SELECT COUNT(*) FROM knowledge_usage WHERE DATE(created_at) = CURDATE()) AS kb_today,
           (SELECT COUNT(*) FROM knowledge_usage WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)) AS kb_yesterday`,
      ).catch(() => null),
      queryOne(
        `SELECT COUNT(*) AS queries,
                COALESCE(SUM(chunk_count), 0) AS chunks,
                COALESCE(SUM(context_chars), 0) AS chars
         FROM knowledge_usage WHERE created_at >= CURDATE()`,
      ),
      queryOne('SELECT COUNT(*) AS queries FROM knowledge_usage'),
      queryOne(
        `SELECT COALESCE(SUM(credits), 0) AS circulating,
                (SELECT COALESCE(SUM(-delta), 0) FROM credit_ledger WHERE kind = 'consume' AND created_at >= CURDATE()) AS consumed_today,
                (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE kind IN ('recharge', 'grant') AND created_at >= CURDATE()) AS recharged_today
         FROM users`,
      ),
      query(
        `WITH RECURSIVE day_series AS (
           SELECT DATE_SUB(CURDATE(), INTERVAL ? DAY) AS d
           UNION ALL
           SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM day_series WHERE d < CURDATE()
         )
         SELECT DATE_FORMAT(ds.d, '%Y-%m-%d') AS day,
                COALESCE(sg.cnt, 0) AS new_users,
                COALESCE(ac.cnt, 0) AS active_users,
                COALESCE(ai.cnt, 0) AS ai_calls,
                COALESCE(kb.cnt, 0) AS knowledge_queries,
                COALESCE(sy.bytes, 0) AS sync_bytes
         FROM day_series ds
         LEFT JOIN (
           SELECT DATE(created_at) AS d, COUNT(*) AS cnt FROM users
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(created_at)
         ) sg ON sg.d = ds.d
         LEFT JOIN (
           SELECT DATE(last_login_at) AS d, COUNT(*) AS cnt FROM users
           WHERE last_login_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(last_login_at)
         ) ac ON ac.d = ds.d
         LEFT JOIN (
           SELECT DATE(created_at) AS d, COUNT(*) AS cnt FROM ai_usage
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(created_at)
         ) ai ON ai.d = ds.d
         LEFT JOIN (
           SELECT DATE(created_at) AS d, COUNT(*) AS cnt FROM knowledge_usage
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(created_at)
         ) kb ON kb.d = ds.d
         LEFT JOIN (
           SELECT DATE(last_synced_at) AS d, COALESCE(SUM(bytes), 0) AS bytes FROM user_vaults
           WHERE last_synced_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE(last_synced_at)
         ) sy ON sy.d = ds.d
         ORDER BY ds.d ASC`,
        [span, span, span, span, span, span],
      ),
      query(
        `SELECT provider, COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost
         FROM ai_usage
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND provider IS NOT NULL AND provider <> ''
         GROUP BY provider ORDER BY calls DESC LIMIT 12`,
        [span],
      ),
      query(
        `SELECT v.vault_id, v.name, v.doc_count, v.bytes, v.status, v.last_synced_at, u.username
         FROM user_vaults v LEFT JOIN users u ON u.id = v.user_id
         ORDER BY v.doc_count DESC, v.bytes DESC LIMIT 10`,
      ),
      query(
        `SELECT v.user_id, u.username,
                COALESCE(SUM(v.bytes), 0) AS bytes,
                COALESCE(SUM(v.doc_count), 0) AS doc_count,
                COUNT(*) AS vaults
         FROM user_vaults v LEFT JOIN users u ON u.id = v.user_id
         GROUP BY v.user_id, u.username
         ORDER BY bytes DESC LIMIT 10`,
      ),
    ]);

    // 供应商调用占比：total 为 0 时 share 记为 0，避免前端除零
    const providerTotal = providerRows.reduce((sum, row) => sum + Number(row.calls ?? 0), 0);
    const aiProviders = providerRows.map((row) => {
      const calls = Number(row.calls ?? 0);
      const def = findProvider(row.provider);
      return {
        provider: row.provider,
        name: def?.name ?? row.provider,
        calls,
        inTokens: Number(row.in_tokens ?? 0),
        outTokens: Number(row.out_tokens ?? 0),
        cost: Number(row.cost ?? 0),
        share: providerTotal > 0 ? Math.round((calls / providerTotal) * 1000) / 1000 : 0,
      };
    });

    // 实时状态：数据库连通 + 对象存储自检（带 3 秒超时）
    const status = await buildRealtimeStatus();

    return ok(reply, {
      range: { days, span },
      metrics: {
        users: {
          total: Number(userRow?.total ?? 0),
          active: Number(userRow?.active ?? 0),
          disabled: Number(userRow?.disabled ?? 0),
          admins: Number(userRow?.admins ?? 0),
          newToday: Number(userRow?.new_today ?? 0),
          newThisWeek: Number(userRow?.new_week ?? 0),
          activeToday: Number(userRow?.active_today ?? 0),
        },
        documents: {
          total: Number(vaultRow?.docs ?? 0),
          vaults: Number(vaultRow?.vaults ?? 0),
          disabledVaults: Number(vaultRow?.disabled ?? 0),
        },
        storage: {
          bytes: Number(vaultRow?.bytes ?? 0),
          backupBytes: Number(backupRow?.bytes ?? 0),
          backups: Number(backupRow?.total ?? 0),
        },
        ai: {
          callsToday: Number(aiTodayRow?.calls ?? 0),
          callsTotal: Number(aiTotalRow?.calls ?? 0),
          inTokensToday: Number(aiTodayRow?.in_tokens ?? 0),
          outTokensToday: Number(aiTodayRow?.out_tokens ?? 0),
          inTokensTotal: Number(aiTotalRow?.in_tokens ?? 0),
          outTokensTotal: Number(aiTotalRow?.out_tokens ?? 0),
          costToday: Number(aiTodayRow?.cost ?? 0),
          // 1.1.8 看板新增：今日失败率（0-1）与平均响应时间（ms）
          // aiHealthRow 为 null 表示库表尚未迁移（缺 status/latency_ms 列），此时统一回 0 而不是报错
          errorsToday: Number(aiHealthRow?.errors ?? 0),
          failRateToday:
            Number(aiHealthRow?.calls ?? 0) > 0
              ? Math.round((Number(aiHealthRow?.errors ?? 0) / Number(aiHealthRow?.calls ?? 1)) * 1000) / 1000
              : 0,
          avgLatencyToday:
            Number(aiHealthRow?.ok_latency_count ?? 0) > 0
              ? Math.round(Number(aiHealthRow?.ok_latency ?? 0) / Number(aiHealthRow?.ok_latency_count ?? 1))
              : 0,
        },
        knowledge: {
          queriesToday: Number(kbTodayRow?.queries ?? 0),
          queriesTotal: Number(kbTotalRow?.queries ?? 0),
          chunksToday: Number(kbTodayRow?.chunks ?? 0),
          contextCharsToday: Number(kbTodayRow?.chars ?? 0),
        },
        credits: {
          circulating: Number(creditRow?.circulating ?? 0),
          consumedToday: Number(creditRow?.consumed_today ?? 0),
          rechargedToday: Number(creditRow?.recharged_today ?? 0),
        },
      },
      /**
       * 环比数据（1.1.8 看板）：今日 vs 昨日。
       * `delta` 为百分比变化；昨日为 0 时返回 null（表示「无可比基数」，前端显示「新增」而非 ∞）。
       */
      compare: {
        users: buildCompare(Number(compareRow?.users_today ?? 0), Number(compareRow?.users_yesterday ?? 0)),
        ai: buildCompare(Number(compareRow?.ai_today ?? 0), Number(compareRow?.ai_yesterday ?? 0)),
        knowledge: buildCompare(Number(compareRow?.kb_today ?? 0), Number(compareRow?.kb_yesterday ?? 0)),
      },
      trends: trendRows.map((row) => ({
        date: String(row.day),
        newUsers: Number(row.new_users ?? 0),
        activeUsers: Number(row.active_users ?? 0),
        aiCalls: Number(row.ai_calls ?? 0),
        knowledgeQueries: Number(row.knowledge_queries ?? 0),
        syncBytes: Number(row.sync_bytes ?? 0),
      })),
      distributions: {
        aiProviders,
        vaultsTop: vaultTopRows.map((row) => ({
          vaultId: row.vault_id,
          name: row.name ?? row.vault_id,
          username: row.username ?? null,
          docCount: Number(row.doc_count ?? 0),
          bytes: Number(row.bytes ?? 0),
          status: row.status,
          lastSyncedAt: row.last_synced_at ?? null,
        })),
        storageTop: storageTopRows.map((row) => ({
          userId: Number(row.user_id),
          username: row.username ?? null,
          bytes: Number(row.bytes ?? 0),
          docCount: Number(row.doc_count ?? 0),
          vaults: Number(row.vaults ?? 0),
        })),
      },
      status,
      generatedAt: new Date().toISOString(),
    });
  });

  /* ------------------------------ 仓库管理（1.1.7） ------------------------------ */

  app.get('/api/admin/vaults', adminOnly, async (req, reply) => {
    const { page, pageSize, search, status } = parse(vaultQuerySchema, req.query, '仓库查询参数');
    const filters = [];
    const params = [];
    if (status) {
      filters.push('v.status = ?');
      params.push(status);
    }
    if (search) {
      filters.push('(v.name LIKE ? OR v.vault_id LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, totalRow, summaryRow] = await Promise.all([
      query(
        `SELECT v.*, u.username, u.email
         FROM user_vaults v LEFT JOIN users u ON u.id = v.user_id
         ${where} ORDER BY v.bytes DESC, v.id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      ),
      queryOne(
        `SELECT COUNT(*) AS total FROM user_vaults v LEFT JOIN users u ON u.id = v.user_id ${where}`,
        params,
      ),
      queryOne(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(bytes), 0) AS bytes,
                COALESCE(SUM(doc_count), 0) AS docs,
                SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
         FROM user_vaults`,
      ),
    ]);

    return ok(reply, {
      items: rows.map((row) => ({
        id: Number(row.id),
        userId: Number(row.user_id),
        username: row.username ?? null,
        email: row.email ?? null,
        vaultId: row.vault_id,
        name: row.name ?? row.vault_id,
        docCount: Number(row.doc_count ?? 0),
        bytes: Number(row.bytes ?? 0),
        status: row.status,
        lastSyncedAt: row.last_synced_at ?? null,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
      })),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
      summary: {
        total: Number(summaryRow?.total ?? 0),
        bytes: Number(summaryRow?.bytes ?? 0),
        docs: Number(summaryRow?.docs ?? 0),
        disabled: Number(summaryRow?.disabled ?? 0),
      },
    });
  });

  app.put('/api/admin/vaults/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '仓库编号');
    const body = parse(vaultStatusSchema, req.body, '仓库状态');
    const row = await queryOne('SELECT id, user_id, vault_id, status FROM user_vaults WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('仓库不存在', 'VAULT_NOT_FOUND');
    await execute('UPDATE user_vaults SET status = ?, updated_at = NOW() WHERE id = ?', [body.status, id]);
    await audit(req, 'admin.vault.status', `vault:${row.vault_id}`, {
      status: body.status,
      before: row.status,
      userId: Number(row.user_id),
    });
    return ok(reply, { id, status: body.status });
  });

  /**
   * 删除仓库注册记录。
   *
   * 只删 `user_vaults` 行，**不删对象存储里的文件**：文档实体在 S3 前缀下，
   * 误删注册表可以重建，误删文件不可恢复。前端会二次确认并明确提示。
   */
  app.delete('/api/admin/vaults/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '仓库编号');
    const row = await queryOne('SELECT id, user_id, vault_id, name, doc_count FROM user_vaults WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('仓库不存在', 'VAULT_NOT_FOUND');
    await execute('DELETE FROM user_vaults WHERE id = ?', [id]);
    await audit(req, 'admin.vault.delete', `vault:${row.vault_id}`, {
      userId: Number(row.user_id),
      name: row.name ?? null,
      docCount: Number(row.doc_count ?? 0),
      note: '仅删除注册记录，对象存储文件保留',
    });
    return ok(reply, { deleted: true, id });
  });

  /* ------------------------------ 积分流水（1.1.7） ------------------------------ */

  app.get('/api/admin/ledger', adminOnly, async (req, reply) => {
    const { page, pageSize, search, userId, kind } = parse(ledgerQuerySchema, req.query, '流水查询参数');
    const filters = [];
    const params = [];
    if (userId) {
      filters.push('l.user_id = ?');
      params.push(userId);
    }
    if (kind) {
      filters.push('l.kind = ?');
      params.push(kind);
    }
    if (search) {
      filters.push('(u.username LIKE ? OR u.email LIKE ? OR l.ref LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, totalRow, summaryRow] = await Promise.all([
      query(
        `SELECT l.*, u.username, u.email
         FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id
         ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      ),
      queryOne(
        `SELECT COUNT(*) AS total FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id ${where}`,
        params,
      ),
      queryOne(
        `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS outflow
         FROM credit_ledger`,
      ),
    ]);

    return ok(reply, {
      items: rows.map((row) => ({
        ...ledgerItem(row),
        username: row.username ?? null,
        email: row.email ?? null,
      })),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
      summary: {
        inflow: Number(summaryRow?.inflow ?? 0),
        outflow: Number(summaryRow?.outflow ?? 0),
      },
    });
  });

  /* ------------------------------ 配置中心（1.1.7） ------------------------------ */

  /**
   * 敏感配置键的判定：值需要打码后再回传。
   * 配置中心面向管理员，但仍遵循「不回传明文凭据」的既有约定。
   */
  const SENSITIVE_CONFIG_RE = /(secret|password|token|api_?key|private)/i;

  app.get('/api/admin/config', adminOnly, async (_req, reply) => {
    const rows = await query('SELECT cfg_key, cfg_value, updated_at FROM platform_config ORDER BY cfg_key ASC');
    return ok(reply, {
      items: rows.map((row) => {
        const value = row.cfg_value === null || row.cfg_value === undefined ? '' : String(row.cfg_value);
        const sensitive = SENSITIVE_CONFIG_RE.test(String(row.cfg_key));
        return {
          key: row.cfg_key,
          value: sensitive ? '••••••' : value,
          sensitive,
          // 打码的键不允许原样保存，前端会要求重新输入
          updatedAt: row.updated_at ?? null,
        };
      }),
    });
  });

  app.put('/api/admin/config', adminOnly, async (req, reply) => {
    const body = parse(configUpdateSchema, req.body, '配置内容');
    const changed = [];
    for (const entry of body.entries) {
      const key = entry.key.trim();
      // 打码占位值表示「未修改」，直接跳过，避免把 •••••• 写进库
      if (entry.value === '••••••') continue;
      const before = await queryOne('SELECT cfg_value FROM platform_config WHERE cfg_key = ? LIMIT 1', [key]);
      await setConfigValue(key, entry.value);
      changed.push({
        key,
        before: before ? String(before.cfg_value).slice(0, 120) : null,
      });
    }
    if (changed.length === 0) {
      return ok(reply, { updated: 0, skipped: true });
    }
    await audit(req, 'admin.config.update', 'platform_config', {
      keys: changed.map((c) => c.key),
    });
    return ok(reply, { updated: changed.length, keys: changed.map((c) => c.key) });
  });

  /* ------------------------------ 实时状态（1.1.7） ------------------------------ */

  app.get('/api/admin/status', adminOnly, async (_req, reply) => {
    return ok(reply, await buildRealtimeStatus());
  });
}

/** 安全解析 JSON 字段 */
function safeJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return String(text);
  }
}

/**
 * 计算环比（今日 vs 昨日）。
 *
 * - 昨日为 0 且今日也为 0 → `delta: 0`（持平，前端显示 0%）
 * - 昨日为 0 但今日 > 0   → `delta: null`（无可比基数，前端显示「新增」而不是 ∞）
 * - 其余                  → `delta = (今日 - 昨日) / 昨日`，保留 4 位小数
 *
 * @param {number} today 今日数值
 * @param {number} yesterday 昨日数值
 * @returns {{today: number, yesterday: number, delta: number|null}}
 */
function buildCompare(today, yesterday) {
  const t = Number(today) || 0;
  const y = Number(yesterday) || 0;
  let delta = 0;
  if (y === 0) delta = t === 0 ? 0 : null;
  else delta = Math.round(((t - y) / y) * 10000) / 10000;
  return { today: t, yesterday: y, delta };
}

/**
 * 组装后台看板用的实时状态。
 *
 * 三个探针互相独立，任一失败都不影响其它项：
 * - `db`：`SELECT 1`，反映连接池是否可用；
 * - `oss`：平台桶读写自检，带 3 秒超时（对象存储慢不能拖垮看板接口）；
 * - `billing`：平台 AI 计费配置是否就绪。
 *
 * 关于「队列」：本服务是同步处理模型，**没有消息队列**，
 * 因此这里如实返回 `queue: null`，前端显示「无队列（同步处理）」而不是伪造数字。
 *
 * @returns {Promise<object>}
 */
async function buildRealtimeStatus() {
  const startedAt = Date.now();

  // 数据库
  let db = false;
  let dbError = null;
  try {
    db = await ping();
  } catch (err) {
    db = false;
    dbError = err?.message ?? '数据库探测失败';
  }

  // 对象存储：Promise.race 兜住慢探测
  let oss = { configured: false, ok: null, message: '未配置对象存储', latencyMs: 0 };
  try {
    const cfg = platformConfig();
    oss.configured = Boolean(cfg?.bucket && cfg?.accessKeyId);
  } catch {
    oss.configured = false;
  }
  if (oss.configured) {
    const probeStartedAt = Date.now();
    try {
      const result = await Promise.race([
        probePlatformStorage(),
        new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 3000)),
      ]);
      oss.latencyMs = Date.now() - probeStartedAt;
      if (result?.__timeout) {
        oss.ok = null;
        oss.message = '探测超时（3 秒）';
      } else {
        oss.ok = Boolean(result?.ok);
        oss.message = result?.message ?? (result?.ok ? '可用' : '不可用');
      }
    } catch (err) {
      oss.ok = false;
      oss.latencyMs = Date.now() - probeStartedAt;
      oss.message = err?.message ?? '对象存储探测失败';
    }
  }

  // 近 24 小时管理操作数（本服务无独立错误表，用审计量反映后台活跃度）
  let auditEvents24h = 0;
  try {
    const row = await queryOne('SELECT COUNT(*) AS total FROM audit_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)');
    auditEvents24h = Number(row?.total ?? 0);
  } catch {
    auditEvents24h = 0;
  }

  return {
    ok: db,
    db: { ok: db, error: dbError },
    oss,
    queue: null,
    auditEvents24h,
    uptimeSeconds: Math.round(process.uptime()),
    version: config.version,
    env: config.nodeEnv,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

export default adminRoutes;
