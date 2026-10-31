/**
 * 管理后台接口：全部要求管理员身份，所有写操作都写审计日志。
 * 新增模块：积分充值/调整、平台 AI 供应商、计费配置、兑换码、发布包清单、自身改密。
 */
import { z } from 'zod';
// 1.1.7 数据看板需要数据库连通性探测（ping）与对象存储连通性自检（probePlatformStorage）
import { execute, ping, query, queryOne, tx } from '../db/pool.js';
import config from '../config.js';
// 1.4.0 客户端分发：后台必须与客户端**同源**，直接复用 download.js 的清单与历史 APK 枚举
// （绝不在本文件里重写目录扫描 + 正则 —— 那就是「第二份清单」，1.3.1 已因此踩过坑）
import { DOWNLOAD_FILES, listHistoricalApks } from './download.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, randomPassword, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { adminPrefix, deletePlatformObject, platformConfig, platformPublicUrl, probePlatformStorage } from '../lib/oss.js';
import { listObjects } from '../lib/s3.js';
import { invalidateUserCache } from '../middleware/auth.js';
// 管理员令牌治理复用用户侧投影，保证两个视角字段完全一致（见 knowledge.js 的 tokenItem 注释）
import { tokenItem } from './knowledge.js';
import {
  PLATFORM_PROVIDERS,
  MODEL_SETTING_LIMITS,
  addCredits,
  adminProviderItem,
  deleteProvider,
  findProvider,
  getProviderRow,
  ledgerItem,
  listPlatformModels,
  listProviderRows,
  loadBilling,
  mergeAllProviderDefs,
  normalizeModelSettings,
  normalizePaymentMethods,
  normalizePrices,
  resolveModelSetting,
  resolveProviderDef,
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

/** 用户列表查询：分页 + 搜索 + 排序 + 状态筛选（兼容 size 与 pageSize 两种参数名） */
const usersQuerySchema = paginationSchema
  .extend({
    size: z.coerce.number().int().min(1).max(100).optional(),
    sort: z.enum(['created', 'lastLogin', 'credits', 'documents']).optional().default('created'),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .transform((v) => ({
    ...v,
    pageSize: v.size ?? v.pageSize,
  }));

const adjustCreditsSchema = z.object({
  amount: z.coerce
    .number({ error: '调整数量必须是数字' })
    .int({ message: '调整数量必须是整数' })
    .refine((value) => value !== 0, { message: '调整数量不能为 0' })
    .refine((value) => Math.abs(value) <= 1_000_000_000_000, { message: '调整数量超出允许范围' }),
  reason: z.string().trim().max(120, { message: '备注最多 120 个字符' }).optional().default(''),
});

/* ------------------------------------------------------------------ */
/* 1.4.0 后台用户管理增强：封禁 / 批量 / 角色 / 登录记录 / 概览 / 导出   */
/* ------------------------------------------------------------------ */

/**
 * 封禁用户。
 *
 * `until` 是「封禁到期时间」：不传或传 null 表示**永久封禁**。
 * 到期后的处理是**惰性解封**（见 `sweepExpiredBans`），不依赖定时任务 ——
 * 理由：本服务没有调度器，引入 cron 会多一个可能失效的组件；
 * 而「到期」这个事实可以直接由 `ban_until < NOW()` 判定，读时顺手纠正即可。
 */
const banUserSchema = z.object({
  reason: z
    .string({ error: '请填写封禁原因' })
    .trim()
    .min(2, { message: '封禁原因至少 2 个字符' })
    .max(255, { message: '封禁原因最多 255 个字符' }),
  /** 封禁时长（小时）；与 until 二选一，都不传 = 永久 */
  hours: z.coerce.number().int().min(1).max(24 * 365 * 10).optional(),
  /** 绝对到期时间（ISO 字符串）；优先级高于 hours */
  until: z.string().trim().max(40).optional(),
});

const USER_ROLES = ['user', 'admin'];

/**
 * 统一状态变更（`PUT /api/admin/users/:id/status`）。
 *
 * `status='disabled'` 时可选带 `banReason`：带了就是「封禁」（可再带 `banUntil`/`hours` 设到期），
 * 不带就是「人工停用」。与 `POST /:id/ban` / `POST /:id/unban` 共用同一套数据约定。
 */
const userStatusSchema = z
  .object({
    status: z.enum(['active', 'disabled'], { message: '状态必须是 active 或 disabled' }),
    banReason: z.string().trim().max(255, { message: '封禁原因最多 255 个字符' }).optional(),
    /** 绝对到期时间（ISO）；与 hours 二选一 */
    banUntil: z.string().trim().max(40).optional(),
    hours: z.coerce.number().int().min(1).max(24 * 365 * 10).optional(),
  })
  .refine((v) => v.status === 'active' || v.banReason === undefined || v.banReason.trim().length >= 2, {
    message: '封禁原因至少 2 个字符',
  });

/** 角色调整：单独一个接口，审计动作更精确（与「改状态」区分开） */
const userRoleSchema = z.object({
  role: z.enum(USER_ROLES, { message: '角色必须是 user 或 admin' }),
});

/**
 * 批量操作。
 *
 * 三种动作共用一次请求，是为了让「勾选 20 个用户 → 一次执行」在服务端也是原子的
 * （要么全部生效，要么明确的逐条结果），避免前端发 20 个请求导致部分失败难以收拾。
 * 返回 `results` 逐条给出成功/失败原因，前端据此提示。
 */
const batchUserSchema = z
  .object({
    ids: z
      .array(z.coerce.number().int().min(1))
      .min(1, { message: '请至少选择一个用户' })
      .max(100, { message: '单次最多操作 100 个用户' }),
    action: z.enum(['disable', 'enable', 'grant', 'role'], { message: '不支持的批量操作' }),
    /** action=grant 时必填：每人发放的积分数（可为负 = 批量扣减） */
    amount: z.coerce
      .number()
      .int({ message: '积分必须是整数' })
      .refine((v) => v !== 0, { message: '积分不能为 0' })
      .refine((v) => Math.abs(v) <= 1_000_000_000, { message: '积分超出允许范围' })
      .optional(),
    reason: z.string().trim().max(120).optional().default(''),
    /** action=role 时必填 */
    role: z.enum(USER_ROLES).optional(),
  })
  .refine((v) => v.action !== 'grant' || v.amount !== undefined, { message: '批量发放积分时必须填写 amount' })
  .refine((v) => v.action !== 'role' || v.role !== undefined, { message: '批量调整角色时必须填写 role' });

/** 导出 CSV 的筛选条件（与列表页保持同一套，导出的就是「当前筛选结果」） */
const exportUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional().default(''),
  status: z.enum(['active', 'disabled']).optional(),
  role: z.enum(USER_ROLES).optional(),
  sort: z.enum(['created', 'lastLogin', 'credits', 'documents']).optional().default('created'),
});

/** 登录记录查询 */
const loginHistoryQuerySchema = paginationSchema.extend({
  /** 只看失败记录 */
  failuresOnly: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional()
    .default(false),
});

const aiProviderSchema = z
  .object({
    name: z.string().trim().min(1, { message: '供应商名称不能为空' }).max(80, { message: '供应商名称最多 80 个字符' }).optional(),
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
      v.name !== undefined ||
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
 * 知识库令牌治理列表查询（1.1.9）。
 *
 * status 只接受三种与 `tokenItem()` 完全对齐的取值，不接受「全部」以外的高自由度字符串，
 * 避免前端传个拼写错误就静默返回全量。
 */
const knowledgeTokenQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().min(1).optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
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

/**
 * 随服务部署的本地安装包目录（与 download.js 的 `LOCAL_DIR` 指向同一处）。
 *
 * 这里只用于「后台展示本地有哪些文件 / 大小多少」，**不重复实现 APK 型号识别与排序** ——
 * 那部分一律走 download.js 的 `listHistoricalApks()`，保证与客户端同源。
 */
const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'releases');

/**
 * 当前产品版本号。
 *
 * 事实源：`services/api/package.json` 的 `version`（与 download.js 的 APP_VERSION 同源，
 * 也与 `config.version` 同源）。后台「当前版本」列必须与它严格相等，
 * 因此这里直接复用 `config.version`，不再读一次文件（避免两处解析出不同结果）。
 */
const APP_VERSION = config.version;

/** 文件名里的型号识别（仅用于给 OSS 上未被清单认领的遗留文件反推版本，与 download.js 的 APK_RE 独立） */
const APK_RE = /^NeoMD-(\d+(?:\.\d+)*)\.apk$/;

/**
 * 判断一条封禁是否已到期 —— **仅在拿不到 SQL 计算列时兜底使用**。
 *
 * 语义约定（与 `banUserSchema` 一致）：`ban_until` 为 NULL = 永久封禁，永不到期。
 *
 * ## 为什么不能直接 `new Date(banUntil)`（1.4.0 实测踩到的真缺陷）
 *
 * 连接池配置是 `timezone: 'Z'` + `dateStrings: true`（见 db/pool.js）：
 *   - 写入时按 **UTC** 存进 DATETIME 列；
 *   - 读出时因为 `dateStrings`，拿到的是**裸字符串**（如 `2026-10-30 20:00:45`，无时区后缀）。
 * 而 `new Date('2026-10-30 20:00:45')` 在 JS 里按**本地时区**解析（东八区 +08:00），
 * 于是同一个值被偏移了 8 小时 —— 刚封禁 2 小时的账号会被误判成「已到期」，
 * 表现为后台显示「已解封」但账号实际仍是 disabled。
 *
 * 因此**权威判定一律由 MySQL 做**（用 `UTC_TIMESTAMP()`，与 UTC 存储口径一致——
 * 用 `NOW()` 会因服务器本地时区 +08:00 而偏移 8 小时）：
 * `USER_SELECT_COLUMNS` 里已算好 `ban_expired` / `ban_active` 两个计算列。
 * 本函数只在下游拿到原始行、没有计算列时兜底，并显式按 UTC 解释裸字符串。
 *
 * @param {string|Date|null|undefined} banUntil
 * @param {number} [now] 便于测试注入的时间戳
 * @returns {boolean}
 */
function isBanExpired(banUntil, now = Date.now()) {
  if (!banUntil) return false;
  let t;
  if (banUntil instanceof Date) {
    t = banUntil.getTime();
  } else {
    const raw = String(banUntil).trim();
    // 裸 'YYYY-MM-DD HH:mm:ss' 必须按 UTC 解释（与连接池 timezone:'Z' 一致）；
    // 已带 Z 或 ±hh:mm 后缀的 ISO 串交给 Date 自己解析。
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    t = new Date(hasZone ? raw : `${raw.replace(' ', 'T')}Z`).getTime();
  }
  if (!Number.isFinite(t)) return false;
  return t <= now;
}

/**
 * 把 MySQL 的 DATETIME 裸字符串（连接池 timezone:'Z'，即 UTC）转成带时区的 ISO 字符串。
 *
 * 为什么 1.4.0 新增字段要转：`dateStrings: true` 让 DATETIME 以 `2026-10-30 20:00:45`
 * 这种**无时区**形式返回，前端 `new Date('2026-10-30 20:00:45')` 会按本地时区解析，
 * 东八区下显示时间偏 8 小时（「封禁到 X」显示错误会直接引发使用者误解）。
 * 转成 `...Z` 后前端无需任何约定即可正确显示。
 *
 * 注意：**只用于 1.4.0 新增的字段**（bannedAt / banUntil）。
 * 既有字段（createdAt / lastLoginAt 等）保持原样 —— 它们已被多处消费，
 * 擅自改格式属于跨模块行为变更，不在本组范围内。
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function toIsoUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value).trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const d = new Date(hasZone ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * 用户行投影（不含 pass_hash）。
 *
 * 1.4.0 新增：封禁三列 + `lastActiveAt`（审计表聚合的最后活跃时间）+ `banned` 派生标志。
 *
 * 为什么要有 `banned` 这个派生字段，而不是让前端自己判断：
 * 「封禁」在数据层是 `status='disabled'` **且** `ban_reason` 非空，这个复合条件
 * 如果让每个消费方（列表/详情/CSV/批量结果）各自拼一遍，迟早会有一处漏判，
 * 表现为「有的地方显示封禁、有的地方显示已禁用」。统一在这里派生一次。
 *
 * `ban_expired` / `ban_active` 优先取 SQL 计算列（时区权威），缺失时才回落到 JS 判断。
 */
function adminUser(row) {
  const banReason = row.ban_reason ?? null;
  const banUntil = row.ban_until ?? null;
  const hasSqlExpired = row.ban_expired !== undefined && row.ban_expired !== null;
  const expired = hasSqlExpired ? Number(row.ban_expired) === 1 : isBanExpired(banUntil);
  const hasSqlActive = row.ban_active !== undefined && row.ban_active !== null;
  const banned = hasSqlActive ? Number(row.ban_active) === 1 : Boolean(banReason) && row.status !== 'active' && !expired;
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
    /* 1.4.0 封禁：expired=true 时前端按「已自动解封」展示（惰性解封见 sweepExpiredBans） */
    banReason,
    bannedAt: toIsoUtc(row.banned_at),
    banUntil: toIsoUtc(banUntil),
    banExpired: expired,
    banned,
    /** 最后活跃（审计表里该用户最近一条事件的时间，没有则为 null） */
    lastActiveAt: row.last_active_at ?? null,
    shareCount: Number(row.share_count ?? 0),
    publishCount: Number(row.publish_count ?? 0),
    documentCount: Number(row.doc_count ?? 0),
    storageBytes: Number(row.storage_bytes ?? 0),
  };
}

/**
 * 惰性解封：把「已过封禁到期时间」的用户真正改回 active 并清空封禁三列。
 *
 * ## 为什么用惰性而不是定时任务
 *
 * 本服务没有调度器（见 `/api/admin/status` 的 `queue: null`），引入 cron 会多一个
 * 可能悄悄失效、且难以观测的组件。而「封禁到期」这个事实完全可以直接由
 * `ban_until IS NOT NULL AND ban_until <= NOW()` 判定 —— **读的时候顺手纠正**，
 * 不需要任何人记得去跑任务。所有会展示/写入用户状态的接口入口调用本函数。
 *
 * ## 幂等与安全
 *
 * 只更新「确有到期封禁」的行，条件由 SQL 精确表达，重复调用无副作用；
 * 只在**确实改动过**时才写审计（避免每次列表刷新都刷一条审计）。
 *
 * @param {object} req Fastify 请求（用于审计）
 * @returns {Promise<number>} 实际解封的用户数
 */
async function sweepExpiredBans(req) {
  let rows;
  try {
    rows = await query(
      `SELECT id, username, ban_reason, ban_until FROM users
       WHERE ban_until IS NOT NULL AND ban_until <= UTC_TIMESTAMP() AND status <> 'active'`,
    );
  } catch {
    return 0;
  }
  if (!rows.length) return 0;
  const ids = rows.map((r) => Number(r.id));
  await execute(
    `UPDATE users SET status = 'active', ban_reason = NULL, banned_at = NULL, ban_until = NULL
     WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  for (const id of ids) invalidateUserCache(id);
  await audit(req, 'admin.user.ban_expired', `users:${ids.join(',')}`, {
    count: ids.length,
    users: rows.map((r) => ({ id: Number(r.id), username: r.username, reason: r.ban_reason, until: r.ban_until })),
    note: '封禁到期自动解封（惰性）',
  });
  return ids.length;
}

/**
 * 用户列表/详情的统一 SQL 片段（避免两个接口的字段与统计口径漂移）。
 *
 * `last_active_at` 用审计表的 MAX(created_at) 聚合。这里依赖 1.4.0 新增的
 * `idx_audit_logs_user_created(user_id, created_at)`，是索引内的取最大值，不会扫全表。
 *
 * ## `ban_expired` / `ban_active` 为什么在 SQL 里算（关键）
 *
 * 封禁到期判断**必须**由 MySQL 做，且**必须用 `UTC_TIMESTAMP()` 而不是 `NOW()`**：
 *
 *  - 连接池是 `timezone: 'Z'`，JS `Date` 写进 DATETIME 时被格式化成 **UTC** 字符串；
 *  - 但 MySQL 的 `NOW()` 返回**服务器本地时间**（本机 SYSTEM 时区是 +08:00）；
 *  - 两者相差 8 小时 → 用 `NOW()` 比较会把「刚封禁 2 小时」判成「已到期」。
 *
 * 改用 `UTC_TIMESTAMP()` 后，比较双方都在 UTC 时钟里，天然正确。
 * 同理 `banned_at` 也用 `UTC_TIMESTAMP()` 写入，保证封禁三列口径一致。
 * 若改回 JS 侧 `new Date(ban_until) > Date.now()`，则会踩另一个坑：
 * `dateStrings: true` 让 DATETIME 以无时区裸字符串返回，JS 按本地时区解析，同样偏 8 小时。
 */
const USER_SELECT_COLUMNS = `u.id, u.email, u.username, u.nickname, u.avatar_url, u.role, u.status, u.quota_bytes, u.credits,
        u.created_at, u.last_login_at, u.last_login_ip, u.ban_reason, u.banned_at, u.ban_until,
        (u.ban_until IS NOT NULL AND u.ban_until <= UTC_TIMESTAMP()) AS ban_expired,
        (u.ban_reason IS NOT NULL AND u.ban_reason <> '' AND u.status <> 'active'
         AND (u.ban_until IS NULL OR u.ban_until > UTC_TIMESTAMP())) AS ban_active,
        (SELECT COUNT(*) FROM shares s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS share_count,
        (SELECT COUNT(*) FROM publishes p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS publish_count,
        (SELECT COALESCE(SUM(v.doc_count), 0) FROM user_vaults v WHERE v.user_id = u.id) AS doc_count,
        (SELECT COALESCE(SUM(v.bytes), 0) FROM user_vaults v WHERE v.user_id = u.id) AS storage_bytes,
        (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.user_id = u.id) AS last_active_at`;

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

/** 令牌「长期未用」判定阈值（天）：超过这个天数没被用过，视为可回收 */
const TOKEN_STALE_DAYS = 90;

/**
 * 知识库令牌风险审计（1.1.9 后台治理）。
 *
 * 只输出**可解释的信号**（前端把信号翻译成人话），不做打分黑箱：
 *  - `owner_disabled`：所属账号已停用，但令牌还能鉴权 → 最高优先级，应立即吊销；
 *  - `write_scope`  ：可写权限令牌，一旦泄露影响面大于只读；
 *  - `never_expires`：没有过期时间，长期有效的凭据不符合最小权限原则；
 *  - `never_used`   ：创建后从未使用，大概率是误建或已废弃；
 *  - `stale`        ：超过 90 天没用过。
 *
 * level 取最高那一条：disabled 相关 → high；其余 → medium；都没有 → none。
 * 已吊销 / 已过期的令牌不再判风险（它们已经不可用，标记只会造成噪声）。
 */
function auditTokenRisk(item, row) {
  const signals = [];
  if (!item.usable) {
    return { level: 'none', signals };
  }
  const ownerDisabled = row.user_status !== null && row.user_status !== undefined && row.user_status !== 'active';
  if (ownerDisabled) signals.push('owner_disabled');
  if (item.scope === 'write') signals.push('write_scope');
  if (!item.expiresAt) signals.push('never_expires');
  if (!item.lastUsedAt) signals.push('never_used');
  else {
    const last = new Date(item.lastUsedAt).getTime();
    if (Number.isFinite(last) && Date.now() - last > TOKEN_STALE_DAYS * 24 * 60 * 60 * 1000) {
      signals.push('stale');
    }
  }
  const level = signals.includes('owner_disabled') ? 'high' : signals.length > 0 ? 'medium' : 'none';
  return { level, signals };
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
    // 惰性解封：先把已到期的封禁改回 active，保证列表与现实一致（幂等，无到期则零开销）
    await sweepExpiredBans(req);

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
      `SELECT ${USER_SELECT_COLUMNS} FROM users u ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
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
      `SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`,
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

  /* ---------------- 1.4.0 用户管理增强（第 1 项：封禁 / 解封） ---------------- */

  /**
   * 封禁用户。
   *
   * 语义：`status='disabled'` + `ban_reason` 非空（理由见 migrate-v2.js 的列注释，
   * 不新增 ENUM 值以免破坏既有消费方）。可选 `hours` / `until` 指定到期时间，不传 = 永久。
   *
   * 副作用：吊销该用户全部 refresh token（与「禁用」一致），使其立即掉线。
   */
  app.post('/api/admin/users/:id/ban', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const body = parse(banUserSchema, req.body, '封禁信息');
    if (id === req.user.id) throw forbidden('不能封禁自己的账号', 'SELF_BAN');

    const target = await queryOne('SELECT id, username, role, status, ban_reason FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');
    if (target.role === 'admin') {
      const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
      if (Number(adminCount?.total ?? 0) <= 1) throw conflict('系统至少需要保留一个可用的管理员', 'LAST_ADMIN');
    }

    // 到期时间：until 优先于 hours；都不传则永久（NULL）
    let banUntil = null;
    if (body.until) {
      const parsed = new Date(body.until);
      if (Number.isNaN(parsed.getTime())) throw badRequest('封禁到期时间格式不正确', 'VALIDATION_ERROR');
      banUntil = parsed;
      if (parsed.getTime() <= Date.now()) throw badRequest('封禁到期时间必须晚于当前时间', 'VALIDATION_ERROR');
    } else if (body.hours) {
      banUntil = new Date(Date.now() + body.hours * 60 * 60 * 1000);
    }

    await execute(
      "UPDATE users SET status = 'disabled', ban_reason = ?, banned_at = UTC_TIMESTAMP(), ban_until = ? WHERE id = ?",
      [body.reason, banUntil, id],
    );
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    invalidateUserCache(id);
    await audit(req, 'admin.user.ban', `user:${id}`, {
      reason: body.reason,
      banUntil: banUntil ? banUntil.toISOString() : null,
      permanent: !banUntil,
      before: { status: target.status, banReason: target.ban_reason ?? null },
    });

    const updated = await queryOne(`SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
    return ok(reply, {
      user: adminUser(updated),
      message: banUntil
        ? `已封禁 ${target.username}，至 ${banUntil.toISOString()}`
        : `已永久封禁 ${target.username}`,
    });
  });

  /** 解封用户：status→active，清空封禁三列（幂等：未封禁也返回成功） */
  app.post('/api/admin/users/:id/unban', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const target = await queryOne('SELECT id, username, status, ban_reason, ban_until FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    await execute(
      "UPDATE users SET status = 'active', ban_reason = NULL, banned_at = NULL, ban_until = NULL WHERE id = ?",
      [id],
    );
    invalidateUserCache(id);
    await audit(req, 'admin.user.unban', `user:${id}`, {
      before: { status: target.status, banReason: target.ban_reason ?? null, banUntil: target.ban_until ?? null },
    });

    const updated = await queryOne(`SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
    return ok(reply, { user: adminUser(updated), message: `${target.username} 已解封` });
  });

  /* ---------------- 第 2 项：批量操作 ---------------- */

  /**
   * 批量操作：批量禁用 / 启用 / 发放积分 / 调整角色。
   *
   * ## 为什么逐条返回结果而不是「一个事务全成或全败」
   *
   * 勾选里很可能混着「自己」和「最后一个管理员」这类**按规则必须跳过**的项。
   * 若用单一事务，一条不合规就让另外 19 条也失败，运营只能一个个试。
   * 因此这里逐条执行、逐条记录结果，前端展示「成功 N 条 / 跳过 M 条（原因）」。
   *
   * 安全性：每条都独立走与单个接口相同的护栏（不能停用自己、不能取消最后一个管理员）。
   */
  app.post('/api/admin/users/batch', adminOnly, async (req, reply) => {
    const body = parse(batchUserSchema, req.body, '批量操作内容');
    // 去重，避免同一个 id 传两次导致积分翻倍
    const ids = [...new Set(body.ids)];
    const results = [];
    let succeeded = 0;
    let skipped = 0;

    for (const id of ids) {
      try {
        const target = await queryOne('SELECT id, username, role, status, credits FROM users WHERE id = ? LIMIT 1', [id]);
        if (!target) {
          results.push({ id, ok: false, reason: '用户不存在' });
          skipped += 1;
          continue;
        }

        if (body.action === 'disable') {
          if (id === req.user.id) {
            results.push({ id, username: target.username, ok: false, reason: '不能停用自己的账号' });
            skipped += 1;
            continue;
          }
          if (target.role === 'admin') {
            const adminCount = await queryOne(
              "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'",
            );
            if (Number(adminCount?.total ?? 0) <= 1) {
              results.push({ id, username: target.username, ok: false, reason: '系统至少需要保留一个可用管理员' });
              skipped += 1;
              continue;
            }
          }
          await execute("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
          await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
          invalidateUserCache(id);
          results.push({ id, username: target.username, ok: true });
          succeeded += 1;
          continue;
        }

        if (body.action === 'enable') {
          // 启用同时清空封禁信息：批量「启用」的运营语义是「恢复可用」，不该残留封禁原因
          await execute(
            "UPDATE users SET status = 'active', ban_reason = NULL, banned_at = NULL, ban_until = NULL WHERE id = ?",
            [id],
          );
          invalidateUserCache(id);
          results.push({ id, username: target.username, ok: true });
          succeeded += 1;
          continue;
        }

        if (body.action === 'grant') {
          const before = Number(target.credits ?? 0);
          const res = await addCredits(id, body.amount, {
            kind: 'grant',
            ref: body.reason || `admin-batch:${req.user.id}`,
            detail: { reason: body.reason || null, adminId: req.user.id, batch: true, before, after: before + Number(body.amount) },
          });
          if (!res) {
            results.push({ id, username: target.username, ok: false, reason: '发放失败' });
            skipped += 1;
            continue;
          }
          results.push({ id, username: target.username, ok: true, delta: res.delta, balance: res.balance });
          succeeded += 1;
          continue;
        }

        // role
        if (id === req.user.id && body.role !== 'admin') {
          results.push({ id, username: target.username, ok: false, reason: '不能取消自己的管理员身份' });
          skipped += 1;
          continue;
        }
        if (target.role === 'admin' && body.role === 'user') {
          const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
          if (Number(adminCount?.total ?? 0) <= 1) {
            results.push({ id, username: target.username, ok: false, reason: '系统至少需要保留一个管理员' });
            skipped += 1;
            continue;
          }
        }
        await execute('UPDATE users SET role = ? WHERE id = ?', [body.role, id]);
        invalidateUserCache(id);
        results.push({ id, username: target.username, ok: true, role: body.role });
        succeeded += 1;
      } catch (err) {
        results.push({ id, ok: false, reason: err?.message ?? '执行失败' });
        skipped += 1;
      }
    }

    await audit(req, 'admin.user.batch', `users:${ids.join(',')}`, {
      action: body.action,
      amount: body.amount ?? null,
      role: body.role ?? null,
      reason: body.reason || null,
      requested: ids.length,
      succeeded,
      skipped,
    });

    return ok(reply, {
      action: body.action,
      requested: ids.length,
      succeeded,
      skipped,
      results,
      message: `批量${body.action === 'disable' ? '禁用' : body.action === 'enable' ? '启用' : body.action === 'grant' ? '发放积分' : '调整角色'}：成功 ${succeeded} 个，跳过 ${skipped} 个`,
    });
  });

  /* ---------------- 用户状态统一入口（PUT /:id/status） ---------------- */

  /**
   * 统一的用户状态变更入口。
   *
   * ## 为什么在已经有 ban / unban 之外再加这一个
   *
   * `ban` / `unban` 是**语义化动作**（内部知道「封禁 = disabled + 写原因」），
   * 后台 UI 用它最直接；但对外/对 QA 来说，一个 `PUT /api/admin/users/:id/status`
   * 的 REST 语义更自然，也更适合脚本化调用（一次请求表达「停用并附封禁信息」）。
   *
   * 两者**共用同一套数据约定**，不是两套实现：
   *   - `status='disabled'` + 有 `banReason` → 封禁（可带 `banUntil` 到期）；
   *   - `status='disabled'` 无 `banReason` → 人工停用（并清空任何残留封禁字段）；
   *   - `status='active'` → 解封/启用（同时清空封禁三列）。
   *
   * 护栏与 ban/unban 完全一致（不能停用自己、不能移除最后一个可用管理员）。
   * 审计动作统一记为 `admin.user.status`，detail 里带 before/after，便于回溯。
   */
  app.put('/api/admin/users/:id/status', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const body = parse(userStatusSchema, req.body, '用户状态');
    if (id === req.user.id && body.status !== 'active') {
      throw forbidden('不能停用自己的账号', 'SELF_DISABLE');
    }

    const target = await queryOne(
      'SELECT id, username, role, status, ban_reason, ban_until FROM users WHERE id = ? LIMIT 1',
      [id],
    );
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    if (body.status !== 'active' && target.role === 'admin') {
      const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
      if (Number(adminCount?.total ?? 0) <= 1) {
        throw conflict('系统至少需要保留一个可用的管理员', 'LAST_ADMIN');
      }
    }

    let banUntil = null;
    if (body.status !== 'active') {
      if (body.banUntil) {
        const parsed = new Date(body.banUntil);
        if (Number.isNaN(parsed.getTime())) throw badRequest('封禁到期时间格式不正确', 'VALIDATION_ERROR');
        if (parsed.getTime() <= Date.now()) throw badRequest('封禁到期时间必须晚于当前时间', 'VALIDATION_ERROR');
        banUntil = parsed;
      } else if (body.hours) {
        banUntil = new Date(Date.now() + body.hours * 60 * 60 * 1000);
      }
    }

    if (body.status === 'active') {
      await execute(
        "UPDATE users SET status = 'active', ban_reason = NULL, banned_at = NULL, ban_until = NULL WHERE id = ?",
        [id],
      );
    } else {
      const reason = (body.banReason ?? '').trim();
      if (reason) {
        await execute(
          "UPDATE users SET status = 'disabled', ban_reason = ?, banned_at = UTC_TIMESTAMP(), ban_until = ? WHERE id = ?",
          [reason, banUntil, id],
        );
      } else {
        // 人工停用：不写封禁原因，并清掉可能残留的封禁字段（避免「已解封却还显示封禁」）
        await execute(
          "UPDATE users SET status = 'disabled', ban_reason = NULL, banned_at = NULL, ban_until = NULL WHERE id = ?",
          [id],
        );
      }
      await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    }
    invalidateUserCache(id);

    await audit(req, 'admin.user.status', `user:${id}`, {
      before: { status: target.status, banReason: target.ban_reason ?? null, banUntil: target.ban_until ?? null },
      after: { status: body.status, banReason: body.banReason ?? null, banUntil: banUntil ? banUntil.toISOString() : null },
      username: target.username,
    });

    const updated = await queryOne(`SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
    return ok(reply, {
      user: adminUser(updated),
      message:
        body.status === 'active'
          ? `${target.username} 已启用`
          : body.banReason
            ? `${target.username} 已封禁${banUntil ? `至 ${banUntil.toISOString()}` : '（永久）'}`
            : `${target.username} 已停用`,
    });
  });

  /* ---------------- 第 3 项：角色调整（独立接口） ---------------- */
  /**
   * 单独的角色调整接口。
   *
   * 为什么不直接复用 `PUT /api/admin/users/:id`：那个接口一次能改 role/status/quota，
   * 审计里只能记成一条笼统的 `admin.user.update`。角色是高权限变更，
   * 需要独立、可筛选的审计动作（`admin.user.role`），事后审计才能一眼看出
   * 「谁在什么时候把谁提成了管理员」。护栏与原来保持一致。
   */
  app.post('/api/admin/users/:id/role', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const body = parse(userRoleSchema, req.body, '角色信息');
    const target = await queryOne('SELECT id, username, role FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    if (id === req.user.id && body.role !== 'admin') throw forbidden('不能取消自己的管理员身份', 'SELF_DEMOTE');
    if (target.role === 'admin' && body.role === 'user') {
      const adminCount = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'");
      if (Number(adminCount?.total ?? 0) <= 1) throw conflict('系统至少需要保留一个管理员', 'LAST_ADMIN');
    }

    if (target.role !== body.role) {
      await execute('UPDATE users SET role = ? WHERE id = ?', [body.role, id]);
      invalidateUserCache(id);
    }
    await audit(req, 'admin.user.role', `user:${id}`, { before: target.role, after: body.role, username: target.username });

    const updated = await queryOne(`SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
    return ok(reply, {
      user: adminUser(updated),
      changed: target.role !== body.role,
      message: target.role === body.role ? `${target.username} 已是该角色` : `${target.username} 的角色已更新`,
    });
  });

  /* ---------------- 第 4 项：登录记录 / 最后活跃 ---------------- */

  /**
   * 用户登录记录（来自审计表聚合，不新增表）。
   *
   * 数据源：`audit_logs` 里 `action='auth.login'`（成功）与 `'auth.login_failed'`（失败），
   * 这两类事件 auth.js 一直在写，只是此前没有后台入口去读。
   * `detail_json` 里的 `reason` 字段解释了失败原因（not_found / bad_password / disabled）。
   */
  app.get('/api/admin/users/:id/logins', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const { page, pageSize, failuresOnly } = parse(loginHistoryQuerySchema, req.query, '登录记录查询参数');
    const target = await queryOne('SELECT id, username, email, last_login_at, last_login_ip FROM users WHERE id = ? LIMIT 1', [id]);
    if (!target) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const actions = failuresOnly ? ['auth.login_failed'] : ['auth.login', 'auth.login_failed'];
    const where = `WHERE user_id = ? AND action IN (${actions.map(() => '?').join(',')})`;
    const params = [id, ...actions];
    const offset = (page - 1) * pageSize;

    const [rows, totalRow, summaryRow] = await Promise.all([
      query(
        `SELECT id, action, detail_json, ip, created_at FROM audit_logs ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      ),
      queryOne(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params),
      queryOne(
        `SELECT
           SUM(CASE WHEN action = 'auth.login' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN action = 'auth.login_failed' THEN 1 ELSE 0 END) AS failed,
           MAX(CASE WHEN action = 'auth.login' THEN created_at END) AS last_success_at
         FROM audit_logs WHERE user_id = ? AND action IN ('auth.login','auth.login_failed')`,
        [id],
      ),
    ]);

    return ok(reply, {
      user: {
        id: Number(target.id),
        username: target.username,
        email: target.email,
        lastLoginAt: target.last_login_at ?? null,
        lastLoginIp: target.last_login_ip ?? null,
      },
      items: rows.map((r) => {
        let detail = null;
        try {
          detail = r.detail_json ? JSON.parse(r.detail_json) : null;
        } catch {
          detail = null;
        }
        return {
          id: Number(r.id),
          action: r.action,
          success: r.action === 'auth.login',
          reason: detail?.reason ?? null,
          deviceId: detail?.deviceId ?? null,
          ip: r.ip ?? null,
          createdAt: r.created_at ?? null,
        };
      }),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
      summary: {
        success: Number(summaryRow?.success ?? 0),
        failed: Number(summaryRow?.failed ?? 0),
        lastSuccessAt: summaryRow?.last_success_at ?? null,
      },
    });
  });

  /* ---------------- 第 5 项：用户数据概览 ---------------- */

  /**
   * 用户数据概览：仓库 / 文档 / 分享 / 发布 / AI 用量 / 积分 / 存储。
   *
   * 与 `/api/admin/users/:id` 的区别：那个接口返回**明细列表**（最近 50 条流水/分享/发布），
   * 适合「点进去逐个看」；本接口返回**聚合数字**，适合在弹窗顶部快速判断
   * 「这个用户是重度用户还是空号」，避免为了看 4 个数字拉几百行明细。
   */
  app.get('/api/admin/users/:id/overview', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '用户编号');
    const row = await queryOne(`SELECT ${USER_SELECT_COLUMNS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
    if (!row) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const [vaultAgg, shareAgg, publishAgg, aiAgg, ledgerAgg, commentAgg, loginAgg] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS vaults,
                COALESCE(SUM(doc_count), 0) AS docs,
                COALESCE(SUM(bytes), 0) AS bytes,
                SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_vaults
         FROM user_vaults WHERE user_id = ?`,
        [id],
      ),
      queryOne(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
                COALESCE(SUM(view_count), 0) AS views
         FROM shares WHERE user_id = ?`,
        [id],
      ),
      queryOne(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM publishes WHERE user_id = ?`,
        [id],
      ),
      queryOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                MAX(created_at) AS last_at
         FROM ai_usage WHERE user_id = ?`,
        [id],
      ),
      queryOne(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS outflow
         FROM credit_ledger WHERE user_id = ?`,
        [id],
      ),
      queryOne('SELECT COUNT(*) AS total FROM share_comments WHERE user_id = ?', [id]).catch(() => null),
      queryOne(
        `SELECT MAX(CASE WHEN action = 'auth.login' THEN created_at END) AS last_login_event,
                MAX(created_at) AS last_active
         FROM audit_logs WHERE user_id = ?`,
        [id],
      ),
    ]);

    const user = adminUser(row);
    return ok(reply, {
      user,
      overview: {
        vaults: {
          total: Number(vaultAgg?.vaults ?? 0),
          disabled: Number(vaultAgg?.disabled_vaults ?? 0),
          documents: Number(vaultAgg?.docs ?? 0),
          bytes: Number(vaultAgg?.bytes ?? 0),
        },
        shares: {
          total: Number(shareAgg?.total ?? 0),
          active: Number(shareAgg?.active ?? 0),
          views: Number(shareAgg?.views ?? 0),
          comments: Number(commentAgg?.total ?? 0),
        },
        publishes: { total: Number(publishAgg?.total ?? 0), active: Number(publishAgg?.active ?? 0) },
        ai: {
          calls: Number(aiAgg?.calls ?? 0),
          inTokens: Number(aiAgg?.in_tokens ?? 0),
          outTokens: Number(aiAgg?.out_tokens ?? 0),
          cost: Number(aiAgg?.cost ?? 0),
          errors: Number(aiAgg?.errors ?? 0),
          lastUsedAt: aiAgg?.last_at ?? null,
        },
        credits: {
          balance: user.credits,
          inflow: Number(ledgerAgg?.inflow ?? 0),
          outflow: Number(ledgerAgg?.outflow ?? 0),
          entries: Number(ledgerAgg?.entries ?? 0),
        },
        activity: {
          lastLoginAt: loginAgg?.last_login_event ?? user.lastLoginAt,
          lastActiveAt: loginAgg?.last_active ?? user.lastActiveAt,
        },
        quota: {
          quotaBytes: user.quotaBytes,
          storageBytes: user.storageBytes,
          usageRatio:
            user.quotaBytes > 0 ? Math.min(1, Number((user.storageBytes / user.quotaBytes).toFixed(4))) : 0,
        },
      },
    });
  });

  /* ---------------- 第 6 项：导出用户列表 CSV ---------------- */

  /**
   * 导出用户列表 CSV。
   *
   * ## 为什么带 BOM
   *
   * 导出的是中文表头与中文昵称，Excel 在 Windows 上默认按系统 ANSI（GBK）解码 CSV，
   * 没有 UTF-8 BOM 就会整片乱码 —— 这是中文 CSV 导出最常见的投诉。
   * 加 `\uFEFF` 前缀后 Excel 能正确识别 UTF-8。
   *
   * ## 为什么不用流式
   *
   * 用户量级（当前 3 个，即使上万）一次性拼字符串完全可承受，代码也更简单可审计。
   * 若将来达到十万级再改流式，届时导出本身也该换成异步任务。
   *
   * ## CSV 注入防护
   *
   * 以 `= + - @` 开头的单元格会被 Excel 当成公式执行。用单引号前缀强制当文本。
   */
  app.get('/api/admin/users/export.csv', adminOnly, async (req, reply) => {
    const q = parse(exportUsersQuerySchema, req.query, '导出筛选条件');
    const filters = [];
    const params = [];
    if (q.search) {
      filters.push('(u.email LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    }
    if (q.status) {
      filters.push('u.status = ?');
      params.push(q.status);
    }
    if (q.role) {
      filters.push('u.role = ?');
      params.push(q.role);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const orderBy = {
      created: 'u.created_at DESC, u.id DESC',
      lastLogin: 'u.last_login_at DESC, u.id DESC',
      credits: 'u.credits DESC, u.id DESC',
      documents: 'doc_count DESC, u.id DESC',
    }[q.sort] ?? 'u.created_at DESC, u.id DESC';

    const rows = await query(
      `SELECT ${USER_SELECT_COLUMNS},
              (SELECT COUNT(*) FROM user_vaults v2 WHERE v2.user_id = u.id) AS vault_total
       FROM users u ${where} ORDER BY ${orderBy} LIMIT 50000`,
      params,
    );

    const header = [
      'ID',
      '用户名',
      '邮箱',
      '昵称',
      '角色',
      '状态',
      '封禁原因',
      '封禁到期',
      '积分',
      '仓库数',
      '文档数',
      '分享数',
      '发布数',
      '存储字节',
      '注册时间',
      '最后登录',
      '最后活跃',
    ];

    /** CSV 单元格转义：防公式注入 + 双引号包裹 + 内部引号翻倍 */
    const cell = (value) => {
      let s = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };

    const lines = [header.map(cell).join(',')];
    for (const r of rows) {
      const u = adminUser(r);
      lines.push(
        [
          cell(u.id),
          cell(u.username),
          cell(u.email),
          cell(u.nickname),
          cell(u.role === 'admin' ? '管理员' : '普通用户'),
          cell(u.banned ? '已封禁' : u.status === 'active' ? '正常' : '已禁用'),
          cell(u.banReason),
          cell(u.banUntil),
          cell(u.credits),
          cell(Number(r.vault_total ?? 0)),
          cell(u.documentCount),
          cell(u.shareCount),
          cell(u.publishCount),
          cell(u.storageBytes),
          cell(u.createdAt),
          cell(u.lastLoginAt),
          cell(u.lastActiveAt),
        ].join(','),
      );
    }

    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    await audit(req, 'admin.user.export', 'users:export', {
      rows: rows.length,
      filters: { search: q.search || null, status: q.status ?? null, role: q.role ?? null, sort: q.sort },
    });

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="neomd-users-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    reply.header('cache-control', 'no-store');
    return reply.send(csv);
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

  // 平台 AI 供应商配置（密钥只回布尔值，包含内置供应商与后台新增自定义供应商）
  app.get('/api/admin/ai', adminOnly, async (_req, reply) => {
    const rows = await listProviderRows();
    const map = new Map(rows.map((row) => [row.provider, row]));
    const allDefs = mergeAllProviderDefs(rows);
    return ok(reply, {
      providers: allDefs.map((def) => adminProviderItem(map.get(def.provider), def)),
    });
  });

  // 修改或新增单个供应商（apiKey 传空串表示清除；支持自定义供应商标识）
  app.put('/api/admin/ai/:provider', adminOnly, async (req, reply) => {
    const providerId = String(req.params.provider ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-_]{1,39}$/i.test(providerId)) {
      throw badRequest(`供应商标识格式不正确：${providerId}（仅限字母、数字、短横线、下划线，2-40位）`, 'INVALID_PROVIDER_ID');
    }
    const body = parse(aiProviderSchema, req.body, '供应商配置');

    const saved = await saveProvider(providerId, body);
    if (!saved) throw notFound(`未知的 AI 供应商：${providerId}`, 'UNKNOWN_PROVIDER');
    await audit(req, 'admin.ai.update', `ai:${saved.provider}`, {
      name: saved.name,
      baseUrl: saved.baseUrl,
      enabled: saved.enabled,
      apiKeyChanged: body.apiKey !== undefined,
      apiKeyCleared: body.apiKey === '',
    });
    return ok(reply, { provider: saved });
  });

  // 删除后台新增的自定义供应商（内置供应商不可删除）
  app.delete('/api/admin/ai/:provider', adminOnly, async (req, reply) => {
    const providerId = String(req.params.provider ?? '').trim();
    if (findProvider(providerId)) {
      throw badRequest('系统内置供应商不可删除，若不使用可将其禁用', 'BUILTIN_PROVIDER');
    }
    const deleted = await deleteProvider(providerId);
    if (!deleted) throw notFound(`自定义供应商不存在：${providerId}`, 'UNKNOWN_PROVIDER');
    await audit(req, 'admin.ai.delete', `ai:${providerId}`);
    return ok(reply, { provider: providerId, deleted: true });
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
    const allDefs = mergeAllProviderDefs(rows);
    const items = allDefs.map((def) => adminProviderItem(map.get(def.provider), def))
      .map((item) => ({
        provider: item.provider,
        name: item.name,
        isCustom: item.isCustom,
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
   */
  app.put('/api/admin/ai-providers-meta', adminOnly, async (req, reply) => {
    const body = parse(aiProvidersMetaSchema, req.body, '供应商展示配置');
    const rows = await listProviderRows();
    const rowMap = new Map(rows.map((r) => [r.provider, r]));

    // 先全部校验，确认无未知 provider 与重复项，再落库
    const seen = new Set();
    for (const item of body.providers) {
      const providerId = String(item.provider ?? '').trim();
      if (!findProvider(providerId) && !rowMap.has(providerId)) {
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
    const allDefs = mergeAllProviderDefs(rows);

    const providers = allDefs.map((def) => {
      const row = map.get(def.provider) ?? null;
      const item = adminProviderItem(row, def);
      const models = item.models ?? [];
      return {
        provider: item.provider,
        name: item.name,
        isCustom: item.isCustom,
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
    const currentRow = await getProviderRow(providerId);
    const def = resolveProviderDef(providerId, currentRow);
    if (!def || (!findProvider(providerId) && !currentRow)) {
      throw notFound(`未知的 AI 供应商：${providerId}`, 'UNKNOWN_PROVIDER');
    }
    const body = parse(aiModelConfigSchema, req.body, '平台模型配置');

    // defaultModel 必须在模型列表内（避免前台预选到一个不存在的模型）
    if (body.defaultModel !== undefined && body.defaultModel !== '') {
      // 模型列表以「本次提交的 models」优先，否则取库里现值
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

  /**
   * 客户端分发清单（1.4.0 重做）。
   *
   * ## 1.4.0 之前的三个真实问题（这就是「后台看不到最新版本」的根因）
   *
   * 1. **只列对象存储**：老实现只 `listObjects(mdadmin/releases/)`，完全没有引用
   *    `download.js` 的 `DOWNLOAD_FILES`。于是本地 `services/api/releases/` 里的
   *    历史 APK（1.1.8 及更早**只存在于本地磁盘**，从未上传 OSS）在后台**完全不可见**；
   *    管理员会以为「那些版本没发过」。
   * 2. **没有「当前版本」概念**：列表按 lastModified 倒序，但没有一处说明
   *    「哪个才是现在该发出去的版本」。当前版本的事实源只有
   *    `services/api/package.json` 的 `version`，老代码没有读它。
   * 3. **拿不到 version / 下载次数 / 可用性**：只返回 key/size/lastModified/url，
   *    前端只能渲染 4 列，无法判断「这一版是否真的能下」。
   *
   * ## 现在的做法（单一数据源，不再有第二份清单）
   *
   * - 当前版本的三条：直接复用 `download.js` 的 `DOWNLOAD_FILES`（已 export）；
   * - 历史 APK：直接复用 `download.js` 的 `listHistoricalApks()`（已 export，1.4.0 加）；
   * - OSS 实际对象：`listObjects` 列举，用来判断「OSS 上有 / 本地有 / 两者都有」；
   * - 下载次数：`release_downloads` 表按天聚合（`download.js` 的埋点写入）。
   *
   * 三处按**文件名**合并成一行一个文件，因此后台看到的集合 = 客户端能下到的集合 ∪ OSS 上的对象，
   * 不会出现「后台有、客户端 404」或反之。
   *
   * ## 可用性（是否可下载）
   *
   * `available` 的判定：
   *  - 当前版本清单内的文件：只要「本地有」或「OSS 有」就算可用（客户端会按需回退）；
   *  - 历史 APK：本地有 → 可用；否则看 OSS；
   *  - 仅在 OSS 上的历史 windows 包：`DOWNLOAD_FILES` 与 `listHistoricalApks` 都不认它
   *    （历史 zip/exe 不在白名单内），因此标记 `downloadable: false` 并说明原因 ——
   *    这正是「后台能看到但客户端下不到」的诚实呈现，避免管理员误判。
   */
  app.get('/api/admin/releases', adminOnly, async (req, reply) => {
    const prefix = `${adminPrefix('releases')}/`;

    // 1) OSS 列举（失败不阻断：本地文件仍然要展示）
    let listing = { objects: [] };
    let ossMessage = null;
    try {
      listing = await listObjects(platformConfig(), prefix, 1000);
    } catch (err) {
      req.log.warn({ err, prefix }, '列举发布包失败');
      ossMessage = `列举对象存储失败：${err.message}`;
    }

    const ossByFile = new Map();
    for (const item of listing.objects) {
      if (!item?.key || item.key.endsWith('/')) continue;
      const file = item.key.slice(prefix.length);
      ossByFile.set(file, {
        key: item.key,
        size: Number(item.size ?? 0),
        lastModified: item.lastModified ?? null,
        url: platformPublicUrl(item.key),
      });
    }

    // 2) 本地磁盘实际文件（只 stat，不读内容）
    const localByFile = new Map();
    try {
      const names = await fs.readdir(LOCAL_DIR);
      for (const name of names) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
        try {
          const st = await fs.stat(path.join(LOCAL_DIR, name));
          if (!st.isFile()) continue;
          localByFile.set(name, { size: st.size, modifiedAt: st.mtime.toISOString() });
        } catch {
          /* 单个文件 stat 失败忽略 */
        }
      }
    } catch {
      /* 目录不存在（未部署 releases/）：本地视图为空 */
    }

    // 3) 下载次数（按天聚合 → 汇总到文件）
    const countByFile = new Map();
    try {
      const rows = await query(
        'SELECT file, SUM(count) AS total, MAX(last_at) AS last_at FROM release_downloads GROUP BY file',
      );
      for (const r of rows) {
        countByFile.set(String(r.file), { total: Number(r.total ?? 0), lastAt: r.last_at ?? null });
      }
    } catch (err) {
      req.log.warn({ err }, '读取下载统计失败（表可能尚未迁移）');
    }

    // 4) 组装：以「客户端清单 ∪ 历史 APK ∪ OSS 对象 ∪ 本地文件」的并集为全集
    const files = new Map();
    const ensure = (file) => {
      if (!files.has(file)) {
        files.set(file, {
          file,
          version: null,
          platform: null,
          title: null,
          size: null,
          lastModified: null,
          url: null,
          isCurrent: false,
          inCurrentManifest: false,
          historical: false,
          onOss: false,
          onLocal: false,
          downloadable: false,
          available: false,
          downloads: 0,
          lastDownloadAt: null,
          note: null,
        });
      }
      return files.get(file);
    };

    // 4a) 当前版本（DOWNLOAD_FILES：唯一事实源）
    for (const item of DOWNLOAD_FILES) {
      const row = ensure(item.file);
      row.version = APP_VERSION;
      row.platform = item.platform;
      row.title = item.title;
      row.inCurrentManifest = true;
      row.isCurrent = true;
    }

    // 4b) 历史 APK（listHistoricalApks：与客户端白名单同一份）
    for (const item of await listHistoricalApks()) {
      const row = ensure(item.file);
      row.platform = item.platform;
      row.title = item.title;
      row.historical = true;
      row.version = row.version ?? (APK_RE.exec(item.file)?.[1] ?? null);
    }

    // 4c) OSS 对象（含未被任何清单认领的遗留文件）
    for (const [file, meta] of ossByFile) {
      const row = ensure(file);
      row.onOss = true;
      row.size = meta.size;
      row.lastModified = meta.lastModified;
      row.url = meta.url;
      if (!row.version) {
        const m = /^NeoMD-(\d+(?:\.\d+)*)/.exec(file);
        if (m) row.version = m[1];
      }
      if (!row.title) {
        row.title = file.endsWith('.apk')
          ? `Android APK（${row.version ?? '未知版本'}）`
          : file.includes('setup.exe')
            ? `Windows 安装包（${row.version ?? '未知版本'}）`
            : file.includes('win-x64.zip')
              ? `Windows 绿色版（${row.version ?? '未知版本'}）`
              : file;
      }
      if (!row.platform) row.platform = file.endsWith('.apk') ? 'android' : 'windows';
    }

    // 4d) 本地磁盘文件
    for (const [file, meta] of localByFile) {
      const row = ensure(file);
      row.onLocal = true;
      // 本地大小优先于 OSS（本地是实际会被 APK 代理直出的那份）
      row.size = meta.size;
      row.lastModified = row.lastModified ?? meta.modifiedAt;
      if (!row.version) {
        const m = /^NeoMD-(\d+(?:\.\d+)*)/.exec(file);
        if (m) row.version = m[1];
      }
      if (!row.platform) row.platform = file.endsWith('.apk') ? 'android' : 'windows';
      if (!row.title) row.title = file;
    }

    // 5) 计算可用性与下载次数
    for (const row of files.values()) {
      const stat = countByFile.get(row.file);
      if (stat) {
        row.downloads = stat.total;
        row.lastDownloadAt = stat.lastAt;
      }
      /*
       * 客户端能否下到这个文件，取决于它是否在 download.js 的白名单里。
       * 但「在白名单里」不等于「真的能下」，还要看它**走哪条分发链路**：
       *
       *   - APK（proxy=true）：download.js 优先读本地 `services/api/releases/`，
       *     本地缺失时回退到 OSS 代理下载 —— 而**阿里云禁止 APK 经 OSS 端点公开分发**
       *     （返回 `ApkDownloadForbidden`）。所以只有 `onLocal` 的 APK 才是真的可下载；
       *   - zip / exe（proxy=false）：302 跳到 OSS 预签名地址，客户端直连对象存储，
       *     因此只有 `onOss` 的才可下载（本地留不留都不影响这条链路）。
       *
       * 这个区分是 1.4.0 排查时实测出来的：NeoMD-1.3.1.apk 确实存在于 OSS，
       * 但本地目录只到 1.1.8，结果客户端下载 404。如果这里简单按「OSS 有 = 可用」
       * 标记，后台就会对着一个下不动的安装包显示「可下载」——那比不显示更糟。
       */
      const whitelisted = row.inCurrentManifest || row.historical;
      const isApk = row.file.endsWith('.apk');
      row.downloadable = whitelisted;
      row.available = whitelisted && (isApk ? row.onLocal : row.onOss);

      if (!row.downloadable) {
        row.note = '不在客户端下载白名单内（历史 Windows 包仅存档，客户端无法下载）';
      } else if (isApk && !row.onLocal && row.onOss) {
        row.note = 'APK 仅在对象存储上：阿里云禁止 APK 经 OSS 端点分发，且本地 releases/ 缺失 → 客户端会 404';
      } else if (!row.available) {
        row.note = 'OSS 与本地均无可分发的副本，客户端会返回 404';
      } else if (row.onOss && row.onLocal) {
        row.note = 'OSS 与本地均存在';
      } else if (row.onLocal) {
        row.note = isApk ? '本地直出（APK 正常链路）' : '仅本地存在（该类型不分发本地副本）';
      } else {
        row.note = '仅 OSS 存在（客户端 302 直连对象存储）';
      }
    }

    const all = [...files.values()].sort((a, b) => {
      // 当前版本永远置顶，其次按版本号倒序，最后按修改时间倒序
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const va = a.version ?? '';
      const vb = b.version ?? '';
      if (va !== vb) return vb.localeCompare(va, undefined, { numeric: true });
      return String(b.lastModified ?? '').localeCompare(String(a.lastModified ?? ''));
    });

    const current = all.filter((f) => f.isCurrent);
    const history = all.filter((f) => !f.isCurrent);

    return ok(reply, {
      prefix,
      /** 当前版本号：直接来自 services/api/package.json，唯一事实源 */
      currentVersion: APP_VERSION,
      files: all,
      current,
      history,
      summary: {
        total: all.length,
        current: current.length,
        history: history.length,
        downloadable: all.filter((f) => f.downloadable).length,
        available: all.filter((f) => f.available).length,
        onOss: all.filter((f) => f.onOss).length,
        onLocal: all.filter((f) => f.onLocal).length,
        both: all.filter((f) => f.onOss && f.onLocal).length,
        ossOnly: all.filter((f) => f.onOss && !f.onLocal).length,
        localOnly: all.filter((f) => f.onLocal && !f.onOss).length,
        totalDownloads: all.reduce((s, f) => s + f.downloads, 0),
      },
      ...(ossMessage ? { message: ossMessage } : {}),
    });
  });

  /**
   * 单个安装包的可用性探测（HEAD）。
   *
   * 与「列表里带 available 标记」的区别：列表的 available 是**静态推断**
   * （OSS 列举 + 本地 stat，按分发链路规则判定）；这里做的是**真实请求** ——
   * 对 `/api/download/:file` 发 HEAD，看这条客户端路径当下是否真的通。
   * 两者不一致时（例如 OSS 对象被删、白名单与磁盘脱节），这里能当场暴露。
   *
   * ## 为什么探测本机监听地址而不是 publicBaseUrl
   *
   * 最初版本打的是 `config.publicBaseUrl`（`https://md.zhengl.vip`），结果在本机实测
   * 拿到 **502** —— 那是生产前置 nginx 的健康问题，与「这个文件能不能下」无关，
   * 反而会让后台把所有文件都标成不可用。本接口要回答的是「本服务的分发逻辑是否正常」，
   * 因此直接打自身监听地址（`127.0.0.1:PORT`），把 nginx/域名问题留给 `/api/admin/status`。
   *
   * 注意：`download.js` 已排除 HEAD 请求的下载计数，因此本探测不会污染统计。
   */
  app.get('/api/admin/releases/:file/probe', adminOnly, async (req, reply) => {
    const file = String(req.params.file ?? '');
    if (!/^[A-Za-z0-9._-]+$/.test(file)) throw badRequest('安装包文件名不合法', 'VALIDATION_ERROR');

    const localOrigin = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}`;
    const url = `${localOrigin}/api/download/${encodeURIComponent(file)}`;
    const publicUrl = `${String(config.publicBaseUrl).replace(/\/+$/, '')}/api/download/${encodeURIComponent(file)}`;
    const startedAt = Date.now();
    try {
      // redirect: manual —— Windows 包会 302 到 OSS 预签名地址，我们只关心「服务端是否认这个文件」
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const reachable = res.status === 200 || res.status === 302 || res.status === 307;
      return ok(reply, {
        file,
        url,
        publicUrl,
        status: res.status,
        reachable,
        contentType: res.headers.get('content-type') ?? null,
        contentLength: Number(res.headers.get('content-length') ?? 0) || null,
        latencyMs: Date.now() - startedAt,
        message: reachable ? '客户端下载链路可用' : `客户端下载返回 HTTP ${res.status}`,
      });
    } catch (err) {
      return ok(reply, {
        file,
        url,
        publicUrl,
        status: 0,
        reachable: false,
        contentType: null,
        contentLength: null,
        latencyMs: Date.now() - startedAt,
        message: `探测失败：${err?.message ?? String(err)}`,
      });
    }
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

  /* ------------------------- 知识库令牌治理（1.1.9） ------------------------- */

  /**
   * 管理员视角的知识库令牌列表。
   *
   * 为什么需要：用户侧的 `/api/knowledge/tokens` 只能看到自己的令牌，
   * 一旦出现「某账号的令牌在外部被滥用」「离职账号还留着有效令牌」这类问题，
   * 运营没有任何入口。本接口补齐全局视角：分页 + 按用户/状态/名称筛选 + 风险标记。
   *
   * 安全约定（与用户侧一致，直接复用 `tokenItem` 投影）：
   * **绝不返回 token_hash 或明文**，只有前 12 位前缀用于人工辨认。
   */
  app.get('/api/admin/knowledge-tokens', adminOnly, async (req, reply) => {
    const { page, pageSize, search, userId, status } = parse(knowledgeTokenQuerySchema, req.query, '令牌查询参数');
    const filters = [];
    const params = [];
    if (userId) {
      filters.push('t.user_id = ?');
      params.push(userId);
    }
    /*
     * 状态筛选的三元互斥判定必须与 `tokenItem()` 完全一致：
     * revoked 优先于 expired（已吊销的令牌即使同时过期，也按「已吊销」归类），
     * 否则同一枚令牌会在两个筛选项里同时出现。
     */
    if (status === 'active') {
      filters.push('t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > NOW())');
    } else if (status === 'revoked') {
      filters.push('t.revoked_at IS NOT NULL');
    } else if (status === 'expired') {
      filters.push('t.revoked_at IS NULL AND t.expires_at IS NOT NULL AND t.expires_at <= NOW()');
    }
    if (search) {
      filters.push('(t.name LIKE ? OR t.token_prefix LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, totalRow, summaryRow] = await Promise.all([
      query(
        `SELECT t.*, u.username, u.email, u.status AS user_status
         FROM knowledge_tokens t LEFT JOIN users u ON u.id = t.user_id
         ${where}
         ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      ),
      queryOne(`SELECT COUNT(*) AS total FROM knowledge_tokens t LEFT JOIN users u ON u.id = t.user_id ${where}`, params),
      /*
       * 汇总永远是**全库**口径（不受筛选影响），
       * 这样管理员在筛选某个用户时，顶部仍然能看到全局风险总量。
       */
      queryOne(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
                SUM(CASE WHEN revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW() THEN 1 ELSE 0 END) AS expired,
                SUM(CASE WHEN scope = 'write' THEN 1 ELSE 0 END) AS write_scope,
                COUNT(DISTINCT user_id) AS users
         FROM knowledge_tokens`,
      ),
    ]);

    const items = rows.map((row) => {
      const item = tokenItem(row);
      return {
        ...item,
        userId: Number(row.user_id),
        username: row.username ?? null,
        email: row.email ?? null,
        ownerStatus: row.user_status ?? null,
        /** 风险审计标记（见下方 riskLevel 的判定顺序） */
        risk: auditTokenRisk(item, row),
      };
    });

    return ok(reply, {
      items,
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
      summary: {
        total: Number(summaryRow?.total ?? 0),
        active: Number(summaryRow?.active ?? 0),
        revoked: Number(summaryRow?.revoked ?? 0),
        expired: Number(summaryRow?.expired ?? 0),
        writeScope: Number(summaryRow?.write_scope ?? 0),
        users: Number(summaryRow?.users ?? 0),
        // 风险计数基于当前页样本，仅作「有没有异常」的直观提示，详细排查靠筛选 + 风险列
        riskyOnPage: items.filter((it) => it.risk.level !== 'none').length,
        writeScopeOnPage: items.filter((it) => it.risk.signals.includes('write_scope')).length,
        neverUsedOnPage: items.filter((it) => it.risk.signals.includes('never_used')).length,
        ownerDisabledOnPage: items.filter((it) => it.risk.signals.includes('owner_disabled')).length,
      },
    });
  });

  /**
   * 管理员吊销任意用户的知识库令牌（软删除，保留审计痕迹）。
   *
   * 与用户侧 `DELETE /api/knowledge/tokens/:id` 的差别只有一处：
   * 不校验 owner（管理员跨用户操作），但必须写一条带 `byAdmin` 的审计日志，
   * 事后能追到「谁在什么时候吊销了谁的令牌」。
   */
  app.delete('/api/admin/knowledge-tokens/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '令牌编号');
    const row = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('令牌不存在', 'TOKEN_NOT_FOUND');

    if (row.revoked_at) {
      // 幂等：已吊销的重复吊销直接返回当前状态，不重复写审计
      return ok(reply, { item: tokenItem(row), alreadyRevoked: true });
    }

    await execute('UPDATE knowledge_tokens SET revoked_at = NOW() WHERE id = ?', [id]);
    await audit(req, 'admin.knowledge_token.revoke', `kb-token:${id}`, {
      ownerUserId: Number(row.user_id),
      name: row.name,
      scope: row.scope,
      tokenPrefix: row.token_prefix ?? '',
      byAdmin: true,
    });

    const saved = await queryOne('SELECT * FROM knowledge_tokens WHERE id = ? LIMIT 1', [id]);
    return ok(reply, { item: tokenItem(saved), alreadyRevoked: false });
  });

  /* ---------------------- AI 运营分析（1.1.9） ---------------------- */

  /**
   * AI 运营分析：按天 / 模型 / 供应商三个维度，给出调用量、失败率、
   * 平均与 **p95** 延迟、token 与积分消耗。
   *
   * 与 `/api/admin/dashboard` 的分工：
   *  - dashboard 是「首页概览」，指标以今日/累计为主，够用即可；
   *  - 本接口是「运营分析」，允许指定 7 / 30 天窗口，并且要把长尾延迟（p95）
   *    与模型维度成本单独拆出来 —— 这才是判断「哪个模型在拖慢/烧钱」的依据。
   *
   * p95 用 MySQL 8 窗口函数计算（ROW_NUMBER + 分组计数），
   * 不用 `PERCENTILE_CONT`（MySQL 只提供窗口形态，聚合形态在 MariaDB/低版本会报语法错），
   * 也不用「把全部 latency 取回 Node 排序」（数据量一大就把内存打爆）。
   */
  app.get('/api/admin/ai-analytics', adminOnly, async (req, reply) => {
    const { days } = parse(dashboardQuerySchema, req.query, '分析查询参数');
    const span = Math.max(0, days - 1);

    /**
     * 延迟统计片段：给定分组表达式，返回 {group, samples, avgLatency, p95Latency}。
     * 只统计 status='ok' 且 latency_ms > 0 的样本（失败调用的耗时不代表模型性能）。
     */
    const latencySql = (groupExpr, partitionExpr) => `
      SELECT ${groupExpr} AS grp, COUNT(*) AS samples,
             ROUND(AVG(latency_ms)) AS avg_latency,
             MAX(CASE WHEN rn = GREATEST(1, CEIL(cnt * 0.95)) THEN latency_ms END) AS p95_latency
      FROM (
        SELECT ${partitionExpr === groupExpr ? groupExpr : `${groupExpr}, ${partitionExpr}`}, latency_ms,
               ROW_NUMBER() OVER (PARTITION BY ${partitionExpr} ORDER BY latency_ms) AS rn,
               COUNT(*) OVER (PARTITION BY ${partitionExpr}) AS cnt
        FROM ai_usage
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${span} DAY)
          AND status = 'ok' AND latency_ms > 0
          AND ${partitionExpr} IS NOT NULL AND ${partitionExpr} <> ''
      ) s
      GROUP BY ${groupExpr}`;

    const [
      totalsRow,
      dailyRows,
      modelRows,
      providerRows,
      // 模型 → 实际承载它的供应商（同一模型可能被多个供应商承载，取调用量最高的那个）
      modelProviderRows,
      modelLatencyRows,
      providerLatencyRows,
      tokenHealthRow,
      conversionRow,
      lowBalanceRows,
    ] = await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COUNT(DISTINCT user_id) AS users
         FROM ai_usage WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [span],
      ).catch(() => null),
      query(
        `WITH RECURSIVE day_series AS (
           SELECT DATE_SUB(CURDATE(), INTERVAL ? DAY) AS d
           UNION ALL
           SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM day_series WHERE d < CURDATE()
         )
         SELECT DATE_FORMAT(ds.d, '%Y-%m-%d') AS day,
                COALESCE(u.calls, 0) AS calls,
                COALESCE(u.errors, 0) AS errors,
                COALESCE(u.in_tokens, 0) AS in_tokens,
                COALESCE(u.out_tokens, 0) AS out_tokens,
                COALESCE(u.cost, 0) AS cost,
                COALESCE(u.avg_latency, 0) AS avg_latency,
                COALESCE(u.p95_latency, 0) AS p95_latency
         FROM day_series ds
         LEFT JOIN (
           SELECT DATE(created_at) AS d, COUNT(*) AS calls,
                  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                  COALESCE(SUM(in_tokens), 0) AS in_tokens,
                  COALESCE(SUM(out_tokens), 0) AS out_tokens,
                  COALESCE(SUM(cost), 0) AS cost,
                  ROUND(AVG(CASE WHEN status = 'ok' AND latency_ms > 0 THEN latency_ms END)) AS avg_latency,
                  MAX(CASE WHEN rn = GREATEST(1, CEIL(cnt * 0.95)) THEN latency_ms END) AS p95_latency
           FROM (
             SELECT created_at, status, in_tokens, out_tokens, cost, latency_ms,
                    CASE WHEN status = 'ok' AND latency_ms > 0
                         THEN ROW_NUMBER() OVER (PARTITION BY DATE(created_at) ORDER BY latency_ms) END AS rn,
                    CASE WHEN status = 'ok' AND latency_ms > 0
                         THEN COUNT(*) OVER (PARTITION BY DATE(created_at)) END AS cnt
             FROM ai_usage WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           ) raw
           GROUP BY DATE(created_at)
         ) u ON u.d = ds.d
         ORDER BY ds.d ASC`,
        [span, span],
      ).catch(() => []),
      query(
        `SELECT model, COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COUNT(DISTINCT user_id) AS users
         FROM ai_usage
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND model IS NOT NULL AND model <> ''
         GROUP BY model ORDER BY cost DESC, calls DESC LIMIT 30`,
        [span],
      ).catch(() => []),
      query(
        `SELECT provider, COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(in_tokens), 0) AS in_tokens,
                COALESCE(SUM(out_tokens), 0) AS out_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COUNT(DISTINCT user_id) AS users
         FROM ai_usage
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND provider IS NOT NULL AND provider <> ''
         GROUP BY provider ORDER BY cost DESC, calls DESC LIMIT 20`,
        [span],
      ).catch(() => []),
      query(
        // 模型 → 承载它的供应商：同一模型可能被多个供应商承载，ORDER BY calls DESC 让第一条就是主力渠道
        `SELECT model, provider, COUNT(*) AS calls
         FROM ai_usage
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND model IS NOT NULL AND model <> '' AND provider IS NOT NULL AND provider <> ''
         GROUP BY model, provider ORDER BY model ASC, calls DESC`,
        [span],
      ).catch(() => []),
      query(latencySql('model', 'model'), []).catch(() => []),
      query(latencySql('provider', 'provider'), []).catch(() => []),
      // 令牌健康（全库口径，与时间窗口无关）
      queryOne(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
                SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
                              AND last_used_at IS NULL THEN 1 ELSE 0 END) AS never_used,
                SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
                              AND expires_at IS NULL THEN 1 ELSE 0 END) AS never_expires,
                SUM(CASE WHEN last_used_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS used_7d,
                COUNT(DISTINCT user_id) AS users
         FROM knowledge_tokens`,
      ).catch(() => null),
      // 付费转化：有过充值流水的用户数 / 总用户数
      queryOne(
        `SELECT (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind = 'recharge') AS paying,
                (SELECT COUNT(DISTINCT user_id) FROM credit_ledger WHERE kind IN ('recharge','grant')) AS credited,
                (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE kind = 'recharge') AS recharged_credits`,
      ).catch(() => null),
      // 低余额用户（余额 < 50 且仍活跃），提示运营主动跟进
      query(
        `SELECT id, username, email, credits FROM users
         WHERE credits < 50 AND status = 'active'
         ORDER BY credits ASC, id ASC LIMIT 20`,
      ).catch(() => []),
    ]);

    const latencyOf = (rows, key) => {
      const map = new Map();
      for (const row of rows) {
        map.set(String(row.grp), {
          avgLatency: Number(row.avg_latency ?? 0),
          p95Latency: Number(row.p95_latency ?? 0),
          latencySamples: Number(row.samples ?? 0),
        });
      }
      return (value) => map.get(String(value)) ?? { avgLatency: 0, p95Latency: 0, latencySamples: 0 };
    };
    const modelLatency = latencyOf(modelLatencyRows, 'model');
    const providerLatency = latencyOf(providerLatencyRows, 'provider');
    // model -> 主力供应商（modelProviderRows 已按 model ASC, calls DESC 排序，首次出现即为最大）
    const modelProviderMap = new Map();
    for (const row of modelProviderRows) {
      const key = String(row.model);
      if (!modelProviderMap.has(key)) modelProviderMap.set(key, String(row.provider));
    }

    const totalCalls = Number(totalsRow?.calls ?? 0);
    const totalErrors = Number(totalsRow?.errors ?? 0);
    const totalCost = Number(totalsRow?.cost ?? 0);

    const byModel = modelRows.map((row) => {
      const calls = Number(row.calls ?? 0);
      const errors = Number(row.errors ?? 0);
      const lat = modelLatency(row.model);
      // 主力供应商：优先取真实调用记录里承载该模型的那个供应商，而不是靠模型名猜
      const providerId = modelProviderMap.get(String(row.model)) ?? null;
      const def = providerId ? findProvider(providerId) : null;
      return {
        model: row.model,
        provider: providerId,
        providerName: def?.name ?? providerId,
        calls,
        errors,
        failRate: calls > 0 ? Math.round((errors / calls) * 10000) / 10000 : 0,
        inTokens: Number(row.in_tokens ?? 0),
        outTokens: Number(row.out_tokens ?? 0),
        cost: Number(row.cost ?? 0),
        costShare: totalCost > 0 ? Math.round((Number(row.cost ?? 0) / totalCost) * 10000) / 10000 : 0,
        users: Number(row.users ?? 0),
        avgLatency: lat.avgLatency,
        p95Latency: lat.p95Latency,
        latencySamples: lat.latencySamples,
      };
    });

    const byProvider = providerRows.map((row) => {
      const calls = Number(row.calls ?? 0);
      const errors = Number(row.errors ?? 0);
      const lat = providerLatency(row.provider);
      const def = findProvider(row.provider);
      return {
        provider: row.provider,
        name: def?.name ?? row.provider,
        calls,
        errors,
        failRate: calls > 0 ? Math.round((errors / calls) * 10000) / 10000 : 0,
        inTokens: Number(row.in_tokens ?? 0),
        outTokens: Number(row.out_tokens ?? 0),
        cost: Number(row.cost ?? 0),
        costShare: totalCost > 0 ? Math.round((Number(row.cost ?? 0) / totalCost) * 10000) / 10000 : 0,
        users: Number(row.users ?? 0),
        avgLatency: lat.avgLatency,
        p95Latency: lat.p95Latency,
        latencySamples: lat.latencySamples,
      };
    });

    // 全窗口的平均/ p95：按天样本做加权（避免「先算每天 p95 再取平均」这种失真做法）
    const dailySamples = dailyRows.reduce((sum, row) => sum + Number(row.calls ?? 0), 0);
    const weightedAvg =
      dailySamples > 0
        ? Math.round(
            dailyRows.reduce((sum, row) => sum + Number(row.avg_latency ?? 0) * Number(row.calls ?? 0), 0) / dailySamples,
          )
        : 0;
    const dailyP95 = dailyRows.reduce((max, row) => Math.max(max, Number(row.p95_latency ?? 0)), 0);
    const peakCalls = dailyRows.reduce((max, row) => Math.max(max, Number(row.calls ?? 0)), 0);

    const tokenHealth = tokenHealthRow
      ? {
          total: Number(tokenHealthRow.total ?? 0),
          active: Number(tokenHealthRow.active ?? 0),
          revoked: Number(tokenHealthRow.revoked ?? 0),
          neverUsed: Number(tokenHealthRow.never_used ?? 0),
          neverExpires: Number(tokenHealthRow.never_expires ?? 0),
          used7d: Number(tokenHealthRow.used_7d ?? 0),
          users: Number(tokenHealthRow.users ?? 0),
        }
      : { total: 0, active: 0, revoked: 0, neverUsed: 0, neverExpires: 0, used7d: 0, users: 0 };

    const totalUsers = Number(conversionRow?.users ?? 0);
    const payingUsers = Number(conversionRow?.paying ?? 0);

    return ok(reply, {
      range: { days, span },
      totals: {
        calls: totalCalls,
        errors: totalErrors,
        failRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 10000) / 10000 : 0,
        inTokens: Number(totalsRow?.in_tokens ?? 0),
        outTokens: Number(totalsRow?.out_tokens ?? 0),
        cost: totalCost,
        activeUsers: Number(totalsRow?.users ?? 0),
        avgLatency: weightedAvg,
        p95Latency: dailyP95,
        peakCallsPerDay: peakCalls,
        /** 日均调用，便于判断容量水位（保留 1 位小数，避免小样本被整数截断成 0） */
        avgCallsPerDay: dailyRows.length > 0 ? Math.round((totalCalls / dailyRows.length) * 10) / 10 : 0,
      },
      daily: dailyRows.map((row) => {
        const calls = Number(row.calls ?? 0);
        const errors = Number(row.errors ?? 0);
        return {
          date: String(row.day),
          calls,
          errors,
          failRate: calls > 0 ? Math.round((errors / calls) * 10000) / 10000 : 0,
          inTokens: Number(row.in_tokens ?? 0),
          outTokens: Number(row.out_tokens ?? 0),
          cost: Number(row.cost ?? 0),
          avgLatency: Number(row.avg_latency ?? 0),
          p95Latency: Number(row.p95_latency ?? 0),
        };
      }),
      byModel,
      byProvider,
      knowledgeTokens: tokenHealth,
      /** 付费转化：付费用户 / 总用户，以及累计充值积分 */
      conversion: {
        users: totalUsers,
        payingUsers,
        creditedUsers: Number(conversionRow?.credited ?? 0),
        rate: totalUsers > 0 ? Math.round((payingUsers / totalUsers) * 10000) / 10000 : 0,
        rechargedCredits: Number(conversionRow?.recharged_credits ?? 0),
      },
      lowBalanceUsers: lowBalanceRows.map((row) => ({
        id: Number(row.id),
        username: row.username ?? null,
        email: row.email ?? null,
        credits: Number(row.credits ?? 0),
      })),
      generatedAt: new Date().toISOString(),
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
