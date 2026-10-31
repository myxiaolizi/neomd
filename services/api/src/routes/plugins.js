/**
 * 插件市场与插件开放平台路由：
 *  - GET /api/plugins/market           获取公开插件市场列表（内置 24 款 + 社区开发者发布插件）
 *  - GET /api/plugins/my               获取当前登录用户发布的插件及下载/星标数据统计
 *  - POST /api/plugins                 登录用户发布新插件
 *  - PUT /api/plugins/:pluginId        作者更新已发布插件（版本、描述、代码、README）
 *  - DELETE /api/plugins/:pluginId     作者或管理员删除插件
 *  - POST /api/plugins/:pluginId/download 记录一次下载/导入并返回完整插件代码包
 *  - POST /api/plugins/:pluginId/star  点赞插件
 *  - GET /api/admin/plugins            管理员查看全部社区插件
 *  - GET /api/admin/plugins/:id        管理员查看单个插件（编辑弹窗取最新值）
 *  - PUT /api/admin/plugins/:id        管理员编辑插件元数据与代码（1.4.0）
 *  - PUT /api/admin/plugins/:id/status 管理员审核/上下架插件
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const PLUGIN_CATEGORIES = ['core', 'navigation', 'writing', 'data', 'visual', 'collab'];

const publishPluginSchema = z.object({
  pluginId: z
    .string({ error: '请填写插件标识（英文、数字与短横线）' })
    .trim()
    .min(3, { message: '插件标识至少 3 个字符' })
    .max(64, { message: '插件标识最多 64 个字符' })
    .regex(/^[a-z0-9][a-z0-9-_]*$/, { message: '插件标识只能使用小写字母、数字、短横线或下划线' }),
  name: z.string({ error: '请填写插件名称' }).trim().min(1).max(80),
  version: z.string().trim().min(1).max(32).optional().default('1.0.0'),
  category: z.enum(PLUGIN_CATEGORIES).optional().default('writing'),
  icon: z.string().trim().max(255).optional().default('layers'),
  description: z.string({ error: '请填写插件简介' }).trim().min(2).max(500),
  readmeMd: z.string().max(200_000).optional().default(''),
  codeJs: z.string({ error: '请提供插件脚本代码' }).min(10, { message: '插件代码过短' }).max(500_000),
});

const updatePluginSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().min(1).max(32).optional(),
  category: z.enum(PLUGIN_CATEGORIES).optional(),
  icon: z.string().trim().max(255).optional(),
  description: z.string().trim().min(2).max(500).optional(),
  readmeMd: z.string().max(200_000).optional(),
  codeJs: z.string().min(10).max(500_000).optional(),
});

/**
 * 标签：最多 8 个，每个 1~24 字符，去重后保序。
 *
 * 为什么单独定 schema 而不是复用 `z.array(z.string())`：
 * 后台表单是逗号分隔的输入框，中文标点（，、；）也常被误输入，服务端统一规范化，
 * 避免「同一个标签在库里出现三种写法」导致筛选失效。
 */
const pluginTagsSchema = z
  .array(z.string().trim().min(1).max(24))
  .max(8, { message: '标签最多 8 个' });

/** 管理员编辑插件：所有字段可选，但至少要提交一项（避免空 PUT 写一条无意义审计） */
const adminPluginUpdateSchema = z
  .object({
    name: z.string().trim().min(1, { message: '插件名称不能为空' }).max(80, { message: '插件名称最多 80 个字符' }).optional(),
    version: z
      .string()
      .trim()
      .min(1, { message: '版本号不能为空' })
      .max(32, { message: '版本号最多 32 个字符' })
      .regex(/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/, { message: '版本号格式不正确（示例：1.2.0）' })
      .optional(),
    category: z.enum(PLUGIN_CATEGORIES, { message: `分类必须是 ${PLUGIN_CATEGORIES.join(' / ')} 之一` }).optional(),
    icon: z.string().trim().max(255).optional(),
    description: z
      .string()
      .trim()
      .min(2, { message: '插件简介至少 2 个字符' })
      .max(500, { message: '插件简介最多 500 个字符' })
      .optional(),
    readmeMd: z.string().max(200_000, { message: 'README 最多 200000 个字符' }).optional(),
    codeJs: z
      .string()
      .min(10, { message: '插件代码过短' })
      .max(500_000, { message: '插件代码最多 500000 个字符' })
      .optional(),
    tags: pluginTagsSchema.optional(),
    status: z.enum(['published', 'pending', 'rejected', 'disabled']).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.version !== undefined ||
      v.category !== undefined ||
      v.icon !== undefined ||
      v.description !== undefined ||
      v.readmeMd !== undefined ||
      v.codeJs !== undefined ||
      v.tags !== undefined ||
      v.status !== undefined,
    { message: '至少需要提交一个可编辑字段' },
  );

const statusSchema = z.object({
  status: z.enum(['published', 'pending', 'rejected', 'disabled']),
});

/**
 * 从 `manifest_json` 里安全读出标签数组。
 *
 * 为什么标签存 manifest_json 而不加列：`manifest_json` 从 1.0 起就是「插件自描述清单」的
 * 预留字段，一直是 NULL 闲置；标签属于典型的低频元数据，为它单开一列 + 一条迁移不值得，
 * 且 manifest_json 本来就是 TEXT，扩展性更好。解析失败一律当空数组（坏数据不能阻断列表）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function readTags(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const list = Array.isArray(parsed?.tags) ? parsed.tags : [];
    return list.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

/** 把标签写回 manifest_json（合并而不是覆盖，保留未来其它清单字段） */
function mergeManifest(raw, tags) {
  let base = {};
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch {
      /* 坏 JSON：丢弃旧内容而不是让保存失败 */
    }
  }
  return JSON.stringify({ ...base, tags });
}

function formatPlugin(row, includeCode = false) {
  return {
    id: Number(row.id),
    pluginId: row.plugin_id,
    userId: Number(row.user_id),
    authorName: row.author_name || '开发者',
    name: row.name,
    version: row.version || '1.0.0',
    category: row.category || 'writing',
    icon: row.icon || 'layers',
    description: row.description,
    readmeMd: row.readme_md ?? '',
    tags: readTags(row.manifest_json),
    ...(includeCode ? { codeJs: row.code_js ?? '' } : {}),
    status: row.status,
    downloads: Number(row.downloads ?? 0),
    stars: Number(row.stars ?? 0),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 插件代码校验（1.4.0 后台编辑功能）                                   */
/* ------------------------------------------------------------------ */

/**
 * 把插件的 `export default {...}` 源码规范成可直接交给 `new Function` 的函数体。
 *
 * **必须与客户端 `EditorPage.vue` 的 `normalizePluginSource()` 保持同一套语义**，
 * 否则会出现「后台校验通过、客户端运行时报错」这种最难排查的分歧。
 * 历史脚本有两种写法，都要兼容且幂等：
 *   - 新写法：`export default { ... }`  → 换成 `return { ... }`
 *   - 旧写法：本来就是函数体（无 export default）→ 原样返回
 *
 * @param {string} codeJs
 * @returns {string}
 */
export function normalizePluginSource(codeJs) {
  const src = String(codeJs ?? '').replace(/^\uFEFF/, '');
  if (!/\bexport\s+default\b/.test(src)) return src;
  const cleaned = src.replace(/^\s*export\s+default\s+/m, 'return ');
  return cleaned.replace(/\bexport\s+default\s+/, 'return ');
}

/**
 * 危险标识符黑名单。
 *
 * ## 这个检查的定位（不要误解成沙箱）
 *
 * 插件代码最终是在**用户浏览器**里通过 `new Function` 执行的，服务端做静态黑名单
 * **不可能替代真正的沙箱**。它的价值只有两点：
 *  1. 拦住「管理员误粘贴了一段 Node 服务器代码 / 恶意脚本」这类明显错误，
 *     让错误在保存那一刻就暴露（而不是等全量用户装上之后）；
 *  2. 给审计日志留一个有意义的拒绝原因。
 *
 * 因此策略是「宁可漏报、不可误报」：只拒绝在浏览器沙箱里**没有任何合法用途**的能力，
 * 不拒绝 `fetch` / `localStorage` / `eval` 这类真实插件可能用得上的东西
 * （真要用它们做坏事，绕过黑名单的方式太多了，收紧只会伤害正常插件）。
 */
const PLUGIN_CODE_DENY = [
  { re: /\brequire\s*\(/, reason: '不允许使用 require()（插件在浏览器中运行，没有 CommonJS 环境）' },
  { re: /\bprocess\s*\.\s*(binding|dlopen|mainModule|exit)\b/, reason: '不允许访问 Node 进程内部对象' },
  { re: /\bchild_process\b/, reason: '不允许引用 child_process' },
  { re: /\bglobalThis\s*\.\s*process\s*\.\s*env\b/, reason: '不允许读取服务端环境变量' },
];

/**
 * 校验插件代码：语法 + 明显危险标识符。
 *
 * 语法校验用 `new Function(normalized)` **只构造不调用** —— 这一步会真正解析代码，
 * 因此能捕获括号/引号不闭合这类最典型的编辑事故，而**不会执行**任何插件逻辑。
 *
 * @param {string} codeJs
 * @returns {{ ok: true, normalized: string } | { ok: false, reason: string }}
 */
export function validatePluginCode(codeJs) {
  const raw = String(codeJs ?? '');
  if (raw.trim().length < 10) return { ok: false, reason: '插件代码过短（至少 10 个字符）' };
  for (const rule of PLUGIN_CODE_DENY) {
    if (rule.re.test(raw)) return { ok: false, reason: rule.reason };
  }
  const normalized = normalizePluginSource(raw);
  try {
    // 只构造，不执行：构造函数会完整解析函数体，语法错误在这里抛出
    // eslint-disable-next-line no-new-func
    new Function(normalized);
  } catch (e) {
    return { ok: false, reason: `语法错误：${e?.message ?? String(e)}` };
  }
  return { ok: true, normalized };
}

/**
 * 计算编辑前后的字段差异（只记录「变了哪些字段」，不存代码全文）。
 *
 * 为什么不把 codeJs 全文写进审计：插件代码动辄几十 KB，`audit_logs.detail_json` 是 TEXT
 * 且超过 8000 字符会被截断（见 lib/audit.js），存全文既没意义又会把其它字段挤掉。
 * 这里改成存「字段名 + 长度 + 长度差」，配合 updated_at 已足以事后追溯。
 *
 * @param {object} before 行数据（数据库列名）
 * @param {object} patch 已校验的请求体（camelCase）
 * @returns {object} 差异描述
 */
function diffPlugin(before, patch) {
  const fieldMap = {
    name: 'name',
    version: 'version',
    category: 'category',
    icon: 'icon',
    description: 'description',
    readmeMd: 'readme_md',
    codeJs: 'code_js',
    status: 'status',
  };
  const changes = {};
  for (const [camel, column] of Object.entries(fieldMap)) {
    if (patch[camel] === undefined) continue;
    const prev = before[column] ?? '';
    const next = patch[camel] ?? '';
    if (String(prev) === String(next)) continue;
    if (camel === 'codeJs' || camel === 'readmeMd') {
      changes[camel] = { lengthBefore: String(prev).length, lengthAfter: String(next).length };
    } else {
      changes[camel] = { before: prev, after: next };
    }
  }
  if (patch.tags !== undefined) {
    const prev = readTags(before.manifest_json);
    if (JSON.stringify(prev) !== JSON.stringify(patch.tags)) changes.tags = { before: prev, after: patch.tags };
  }
  return changes;
}

/** 首次启动时若社区表为空，预置 3 款官方示例社区插件供用户浏览与一键导入体验 */
async function ensureSampleCommunityPlugins() {
  try {
    const countRow = await queryOne('SELECT COUNT(*) AS total FROM community_plugins');
    if (Number(countRow?.total ?? 0) > 0) return;
    const samples = [
      {
        pluginId: 'pomodoro-focus',
        authorName: 'Neo MD 官方团队',
        name: '番茄专注时钟',
        version: '1.2.0',
        category: 'writing',
        icon: 'clock',
        description: '在写作时启动 25 分钟番茄钟倒计时，完成后自动在当前文档末尾插入专注打卡记录。',
        readmeMd: '# 番茄专注时钟\n\n提供 25 分钟沉浸式写作计时器，结束后可将专注时长写入当前 Markdown 笔记。',
        codeJs: `export default {
  id: 'pomodoro-focus',
  name: '番茄专注时钟',
  version: '1.2.0',
  setup(api) {
    api.registerCommand({
      id: 'pomodoro.start',
      title: '启动 25 分钟番茄专注并插入打卡记录',
      run() {
        const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        api.insertMarkdown('\\n> 🍅 番茄专注打卡（开始于 ' + stamp + '，目标 25 分钟）\\n');
        api.notify('已启动番茄专注并插入打卡标记', 'success');
      }
    });
  }
};`,
        downloads: 1280,
        stars: 342,
      },
      {
        pluginId: 'reading-card-generator',
        authorName: 'AI 创作者社区',
        name: '金句读书卡片生成',
        version: '1.0.4',
        category: 'visual',
        icon: 'sparkles',
        description: '一键提取当前笔记中的引用块（Blockquote）与核心要点，汇总生成结构化读书摘录区块。',
        readmeMd: '# 金句读书卡片生成\n\n自动扫描当前文档中的所有 `>` 引用段落，在文档底部汇总生成精美的金句摘录清单。',
        codeJs: `export default {
  id: 'reading-card-generator',
  name: '金句读书卡片生成',
  version: '1.0.4',
  setup(api) {
    api.registerCommand({
      id: 'readingCard.extract',
      title: '提取全文引用生成金句摘录卡',
      run() {
        const md = api.getMarkdown() || '';
        const quotes = md.split(/\\r?\\n/).filter(l => l.trim().startsWith('>')).map(l => l.replace(/^>\\s*/, '').trim()).filter(Boolean);
        if (!quotes.length) {
          api.notify('当前文档未找到 > 引用段落', 'info');
          return;
        }
        const block = '\\n\\n## 📌 金句摘录卡\\n' + quotes.map((q, i) => (i + 1) + '. 「' + q + '」').join('\\n') + '\\n';
        api.insertMarkdown(block);
        api.notify('已提取 ' + quotes.length + ' 条金句生成摘录卡', 'success');
      }
    });
  }
};`,
        downloads: 965,
        stars: 218,
      },
      {
        pluginId: 'meeting-minutes-tpl',
        authorName: '效率工具实验室',
        name: '商务会议纪要模板',
        version: '1.1.0',
        category: 'collab',
        icon: 'calendar',
        description: '快速插入含参会人、核心议题、决议事项与待办跟进表的标准化商务会议纪要结构。',
        readmeMd: '# 商务会议纪要模板\n\n一键在当前光标处或文末插入标准企业级会议纪要 Markdown 表格与任务清单。',
        codeJs: `export default {
  id: 'meeting-minutes-tpl',
  name: '商务会议纪要模板',
  version: '1.1.0',
  setup(api) {
    api.registerCommand({
      id: 'meeting.insertTemplate',
      title: '插入标准商务会议纪要模板',
      run() {
        const date = new Date().toISOString().slice(0, 10);
        const tpl = [
          '## 会议纪要（' + date + '）',
          '',
          '| 项目 | 内容 |',
          '| --- | --- |',
          '| 会议主题 | 产品迭代评审 |',
          '| 参会人员 | @全体成员 |',
          '| 会议主持 | 负责人 |',
          '',
          '### 一、核心结论',
          '- ',
          '',
          '### 二、行动项（Action Items）',
          '- [ ] 待办事项 1（负责人 / 截止日期）',
          '- [ ] 待办事项 2（负责人 / 截止日期）',
          ''
        ].join('\\n');
        api.insertMarkdown('\\n' + tpl);
        api.notify('已插入商务会议纪要模板', 'success');
      }
    });
  }
};`,
        downloads: 1840,
        stars: 419,
      },
    ];
    for (const s of samples) {
      await execute(
        `INSERT INTO community_plugins
         (plugin_id, user_id, author_name, name, version, category, icon, description, readme_md, code_js, status, downloads, stars, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, NOW(), NOW())`,
        [s.pluginId, s.authorName, s.name, s.version, s.category, s.icon, s.description, s.readmeMd, s.codeJs, s.downloads, s.stars],
      );
    }
  } catch {
    /* 表尚未就绪时忽略 */
  }
}

export async function pluginRoutes(app) {
  /*
   * 公开插件市场列表（1.4.0 起支持服务端分页）。
   *
   * ## 向后兼容是硬要求（不是可选项）
   *
   * 1.4.0 之前这个接口**一次性返回全部上架插件**（LIMIT 200），客户端 `pluginsApi.market()`
   * 不传任何分页参数。如果这里改成「不传 page 就只给第 1 页」，那么所有尚未升级的客户端
   * 都会**静默地只看到 20 款插件**——这是典型的「兼容性回归」，且表现得很像「市场里的插件消失了」。
   *
   * 因此约定：
   *  - **不传** page / pageSize → 行为与 1.3.1 完全一致（全量，LIMIT 200），只额外多返回统计字段；
   *  - **传了** page 或 pageSize 任一 → 走真正的 LIMIT/OFFSET 分页（每页默认 20）。
   *
   * `total` 一律来自真实 `COUNT(*)`（不是当前页长度），`hasMore` 由「offset + 本页条数 < total」
   * 推导，这样即使客户端 total 与数组长度出现歧义也能正确翻页。
   */
  app.get('/api/plugins/market', async (req, reply) => {
    await ensureSampleCommunityPlugins();
    const category = String(req.query?.category ?? '').trim();
    const search = String(req.query?.search ?? '').trim();
    const filters = ["status = 'published'"];
    const params = [];
    if (category) {
      filters.push('category = ?');
      params.push(category);
    }
    if (search) {
      filters.push('(name LIKE ? OR description LIKE ? OR plugin_id LIKE ? OR author_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.join(' AND ');

    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM community_plugins WHERE ${where}`, params);
    const total = Number(totalRow?.total ?? 0);

    // 「是否显式要求分页」：任一参数出现即视为分页请求（客户端只需传 pageSize=20 即可）
    const paginated = req.query?.page !== undefined || req.query?.pageSize !== undefined;
    const page = Math.max(1, Math.min(100000, Number(req.query?.page ?? 1) || 1));
    const pageSize = Math.max(1, Math.min(100, Number(req.query?.pageSize ?? 20) || 20));
    const offset = (page - 1) * pageSize;

    const rows = paginated
      ? await query(
          `SELECT * FROM community_plugins WHERE ${where} ORDER BY downloads DESC, id DESC LIMIT ? OFFSET ?`,
          [...params, pageSize, offset],
        )
      : await query(
          `SELECT * FROM community_plugins WHERE ${where} ORDER BY downloads DESC, id DESC LIMIT 200`,
          params,
        );

    return ok(reply, {
      items: rows.map((r) => formatPlugin(r, true)),
      total,
      page: paginated ? page : 1,
      pageSize: paginated ? pageSize : Math.max(rows.length, 1),
      hasMore: (paginated ? offset : 0) + rows.length < total,
    });
  });

  // 开发者：我发布的插件与统计
  app.get('/api/plugins/my', { preHandler: [app.authenticate] }, async (req, reply) => {
    await ensureSampleCommunityPlugins();
    const rows = await query('SELECT * FROM community_plugins WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    const items = rows.map((r) => formatPlugin(r, true));
    const totalDownloads = items.reduce((s, x) => s + x.downloads, 0);
    const totalStars = items.reduce((s, x) => s + x.stars, 0);
    return ok(reply, {
      items,
      stats: {
        publishedCount: items.filter((x) => x.status === 'published').length,
        totalCount: items.length,
        totalDownloads,
        totalStars,
      },
    });
  });

  // 发布新插件
  app.post('/api/plugins', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(publishPluginSchema, req.body, '插件信息');
    const existing = await queryOne('SELECT id FROM community_plugins WHERE plugin_id = ? LIMIT 1', [body.pluginId]);
    if (existing) throw conflict(`插件标识 ${body.pluginId} 已被占用，请更换`, 'PLUGIN_ID_TAKEN');

    const userRow = await queryOne('SELECT username, nickname FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const authorName = userRow?.nickname || userRow?.username || '开发者';

    const res = await execute(
      `INSERT INTO community_plugins
       (plugin_id, user_id, author_name, name, version, category, icon, description, readme_md, code_js, status, downloads, stars, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, NOW(), NOW())`,
      [
        body.pluginId,
        req.user.id,
        authorName,
        body.name,
        body.version,
        body.category,
        body.icon,
        body.description,
        body.readmeMd,
        body.codeJs,
      ],
    );
    await audit(req, 'plugin.publish', `plugin:${body.pluginId}`, { name: body.name, version: body.version });
    const saved = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [Number(res.insertId)]);
    return ok(reply, { plugin: formatPlugin(saved, true) }, 201);
  });

  // 更新已发布插件
  app.put('/api/plugins/:pluginId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const pluginId = String(req.params.pluginId ?? '').trim();
    const row = await queryOne('SELECT * FROM community_plugins WHERE plugin_id = ? LIMIT 1', [pluginId]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('只能修改自己发布的插件', 'PLUGIN_FORBIDDEN');
    }
    const body = parse(updatePluginSchema, req.body, '插件更新内容');

    /*
     * 代码改动必须过语法 + 危险标识符校验（1.4.0 修复「只堵了一个门」）。
     *
     * ## 为什么作者侧也必须校验
     *
     * 验收门禁 B06 抓到一个**安全缺口**：后台侧 `PUT /api/admin/plugins/:id` 会调
     * `validatePluginCode()` 拒绝坏代码（400 PLUGIN_CODE_INVALID），但**作者侧**
     * `PUT /api/plugins/:pluginId` 直接 `body.codeJs ?? row.code_js` 落库，一个字节都不校验。
     *
     * 危害：插件代码最终会在**客户端 `new Function` 里执行**。坏代码写进去之后，
     * 用户点开插件只会看到「插件坏了」这类无可读原因的异常；
     * 而危险标识符（`require` / `child_process` / `process.binding`）与插件
     * 「在浏览器沙箱内运行」的产品前提直接冲突。
     *
     * 两个端点都是「写 codeJs 的入口」，校验口径必须一致 —— 只修后台侧等于没修：
     * 作者（或任何拿到自己插件所有权的账号）可以绕过。**共用同一个校验器**，
     * 不在这里另写第二套规则。
     */
    if (body.codeJs !== undefined) {
      const verdict = validatePluginCode(body.codeJs);
      if (verdict.ok === false) {
        await audit(req, 'plugin.update_rejected', `plugin:${pluginId}`, {
          reason: verdict.reason,
          lengthAfter: String(body.codeJs).length,
        });
        throw badRequest(`插件代码校验未通过：${verdict.reason}`, 'PLUGIN_CODE_INVALID');
      }
    }

    await execute(
      `UPDATE community_plugins
       SET name = ?, version = ?, category = ?, icon = ?, description = ?, readme_md = ?, code_js = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        body.name ?? row.name,
        body.version ?? row.version,
        body.category ?? row.category,
        body.icon ?? row.icon,
        body.description ?? row.description,
        body.readmeMd ?? row.readme_md,
        body.codeJs ?? row.code_js,
        row.id,
      ],
    );
    await audit(req, 'plugin.update', `plugin:${pluginId}`, { version: body.version ?? row.version });
    const updated = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [row.id]);
    return ok(reply, { plugin: formatPlugin(updated, true) });
  });

  // 删除插件
  app.delete('/api/plugins/:pluginId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const pluginId = String(req.params.pluginId ?? '').trim();
    const row = await queryOne('SELECT * FROM community_plugins WHERE plugin_id = ? LIMIT 1', [pluginId]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('无权删除该插件', 'PLUGIN_FORBIDDEN');
    }
    await execute('DELETE FROM community_plugins WHERE id = ?', [row.id]);
    await audit(req, 'plugin.delete', `plugin:${pluginId}`);
    return ok(reply, { deleted: true, pluginId });
  });

  // 下载 / 安装插件（统计下载量并返回代码包）
  app.post('/api/plugins/:pluginId/download', async (req, reply) => {
    const pluginId = String(req.params.pluginId ?? '').trim();
    const row = await queryOne('SELECT * FROM community_plugins WHERE plugin_id = ? LIMIT 1', [pluginId]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    await execute('UPDATE community_plugins SET downloads = downloads + 1 WHERE id = ?', [row.id]);
    const fresh = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [row.id]);
    return ok(reply, { plugin: formatPlugin(fresh, true) });
  });

  // 点赞插件
  app.post('/api/plugins/:pluginId/star', async (req, reply) => {
    const pluginId = String(req.params.pluginId ?? '').trim();
    const row = await queryOne('SELECT * FROM community_plugins WHERE plugin_id = ? LIMIT 1', [pluginId]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    await execute('UPDATE community_plugins SET stars = stars + 1 WHERE id = ?', [row.id]);
    const fresh = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [row.id]);
    return ok(reply, { stars: Number(fresh?.stars ?? 0) });
  });

  /* ---------------- 管理后台：插件审核与管理 ---------------- */
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  app.get('/api/admin/plugins', adminOnly, async (req, reply) => {
    await ensureSampleCommunityPlugins();
    const { page, pageSize, search } = parse(paginationSchema, req.query, '分页参数');
    const filters = [];
    const params = [];
    if (search) {
      filters.push('(name LIKE ? OR plugin_id LIKE ? OR author_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const rows = await query(
      `SELECT * FROM community_plugins ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM community_plugins ${where}`, params);
    return ok(reply, {
      items: rows.map((r) => formatPlugin(r, true)),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  app.put('/api/admin/plugins/:id/status', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '插件编号');
    const body = parse(statusSchema, req.body, '插件状态');
    const row = await queryOne('SELECT id, plugin_id, status FROM community_plugins WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    await execute('UPDATE community_plugins SET status = ?, updated_at = NOW() WHERE id = ?', [body.status, id]);
    await audit(req, 'admin.plugin.status', `plugin:${row.plugin_id}`, { status: body.status, before: row.status });
    return ok(reply, { id, status: body.status });
  });

  /**
   * 管理员查看单个插件（编辑弹窗取最新值）。
   *
   * 为什么编辑前要重新取一次：后台列表可能是几分钟前拉的数据，别的管理员或作者
   * 期间可能已经改过。弹窗打开时以服务端最新值为准，并在响应里带 `updatedAt`，
   * 前端据此提示「该插件已被更新」，避免后写覆盖别人的改动。
   */
  app.get('/api/admin/plugins/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '插件编号');
    const row = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');
    return ok(reply, { plugin: formatPlugin(row, true) });
  });

  /**
   * 管理员编辑插件：元数据（名称/描述/分类/标签/版本/README/图标/状态）+ 代码（codeJs）。
   *
   * ## 安全边界（为什么必须有服务端校验，不能只信前端）
   *
   * `codeJs` 最终会在**所有安装该插件的用户浏览器**里执行。管理员保存的每一个字符
   * 都会被分发出去，所以服务端必须在落库前做一次不可绕过的检查：
   *   - 语法：`new Function(normalized)` 只构造不执行，能抓住括号/引号不闭合；
   *   - 明显危险标识符：见 PLUGIN_CODE_DENY 的说明（这是「拦误操作」不是「沙箱」）。
   *
   * ## 生效时机
   *
   * 保存即生效：`/api/plugins/market` 直接读这张表，没有缓存层，因此客户端市场
   * **下一次拉取就能看到新值**（不需要重启服务或等定时任务）。这一点在验收里实测过。
   *
   * ## 审计
   *
   * 写 `admin.plugin.update`，detail 里记录**变了哪些字段**（代码类字段只记长度差，
   * 不记全文，理由见 diffPlugin 注释），并带上操作者与时间（audit() 自带 user_id/created_at）。
   */
  app.put('/api/admin/plugins/:id', adminOnly, async (req, reply) => {
    const id = parseId(req.params.id, '插件编号');
    const body = parse(adminPluginUpdateSchema, req.body, '插件编辑内容');

    const row = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('插件不存在', 'PLUGIN_NOT_FOUND');

    // 代码改动必须过语法 + 危险标识符校验（未提交 codeJs 时跳过，避免无谓解析）
    if (body.codeJs !== undefined) {
      const verdict = validatePluginCode(body.codeJs);
      if (verdict.ok === false) {
        await audit(req, 'admin.plugin.update_rejected', `plugin:${row.plugin_id}`, {
          reason: verdict.reason,
          lengthAfter: String(body.codeJs).length,
        });
        throw badRequest(`插件代码校验未通过：${verdict.reason}`, 'PLUGIN_CODE_INVALID');
      }
    }

    // 只更新实际提交的字段：未提交的字段保持原值（PATCH 语义，避免前端漏传导致内容被清空）
    const next = {
      name: body.name ?? row.name,
      version: body.version ?? row.version,
      category: body.category ?? row.category,
      icon: body.icon ?? row.icon,
      description: body.description ?? row.description,
      readme_md: body.readmeMd ?? row.readme_md,
      code_js: body.codeJs ?? row.code_js,
      status: body.status ?? row.status,
      manifest_json:
        body.tags === undefined ? row.manifest_json : mergeManifest(row.manifest_json, dedupeTags(body.tags)),
    };

    await execute(
      `UPDATE community_plugins
       SET name = ?, version = ?, category = ?, icon = ?, description = ?, readme_md = ?, code_js = ?,
           status = ?, manifest_json = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        next.name,
        next.version,
        next.category,
        next.icon,
        next.description,
        next.readme_md,
        next.code_js,
        next.status,
        next.manifest_json,
        id,
      ],
    );

    const changes = diffPlugin(row, { ...body, tags: body.tags === undefined ? undefined : dedupeTags(body.tags) });
    await audit(req, 'admin.plugin.update', `plugin:${row.plugin_id}`, {
      changes,
      // 操作者与时间由 audit() 自动落库（user_id / created_at），这里再冗余一份便于审计导出
      operatorId: req.user.id,
      changedFields: Object.keys(changes),
    });

    const updated = await queryOne('SELECT * FROM community_plugins WHERE id = ? LIMIT 1', [id]);
    return ok(reply, {
      plugin: formatPlugin(updated, true),
      changes,
      // 空变更也返回成功（幂等保存），但明确告知前端「没有字段变化」以便给出恰当提示
      unchanged: Object.keys(changes).length === 0,
    });
  });
}

/** 标签去重（保持首次出现顺序），并去掉空白项 */
function dedupeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags ?? []) {
    const t = String(raw ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export default pluginRoutes;
