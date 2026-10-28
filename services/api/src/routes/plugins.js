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
 *  - PUT /api/admin/plugins/:id/status 管理员审核/上下架插件
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { conflict, forbidden, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

const publishPluginSchema = z.object({
  pluginId: z
    .string({ error: '请填写插件标识（英文、数字与短横线）' })
    .trim()
    .min(3, { message: '插件标识至少 3 个字符' })
    .max(64, { message: '插件标识最多 64 个字符' })
    .regex(/^[a-z0-9][a-z0-9-_]*$/, { message: '插件标识只能使用小写字母、数字、短横线或下划线' }),
  name: z.string({ error: '请填写插件名称' }).trim().min(1).max(80),
  version: z.string().trim().min(1).max(32).optional().default('1.0.0'),
  category: z.enum(['core', 'navigation', 'writing', 'data', 'visual', 'collab']).optional().default('writing'),
  icon: z.string().trim().max(255).optional().default('layers'),
  description: z.string({ error: '请填写插件简介' }).trim().min(2).max(500),
  readmeMd: z.string().max(200_000).optional().default(''),
  codeJs: z.string({ error: '请提供插件脚本代码' }).min(10, { message: '插件代码过短' }).max(500_000),
});

const updatePluginSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().min(1).max(32).optional(),
  category: z.enum(['core', 'navigation', 'writing', 'data', 'visual', 'collab']).optional(),
  icon: z.string().trim().max(255).optional(),
  description: z.string().trim().min(2).max(500).optional(),
  readmeMd: z.string().max(200_000).optional(),
  codeJs: z.string().min(10).max(500_000).optional(),
});

const statusSchema = z.object({
  status: z.enum(['published', 'pending', 'rejected', 'disabled']),
});

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
    ...(includeCode ? { codeJs: row.code_js ?? '' } : {}),
    status: row.status,
    downloads: Number(row.downloads ?? 0),
    stars: Number(row.stars ?? 0),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
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
  // 公开插件市场列表
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
    const rows = await query(
      `SELECT * FROM community_plugins WHERE ${filters.join(' AND ')} ORDER BY downloads DESC, id DESC LIMIT 200`,
      params,
    );
    return ok(reply, { items: rows.map((r) => formatPlugin(r, true)) });
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
}

export default pluginRoutes;
