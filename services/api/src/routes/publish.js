/**
 * 发布：把文档渲染成带导出样式的独立 HTML，上传到平台桶 mdadmin/publish/<slug>.html，
 * 对外通过 https://<域名>/p/<slug> 访问。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import config from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { buildStandaloneHtml } from '../lib/export-css.js';
import { escapeHtml } from '../lib/markdown.js';
import { adminPrefix, deletePlatformObject, getPlatformObject, platformConfig, platformPublicUrl, putPlatformObject } from '../lib/oss.js';
import { audit } from '../lib/audit.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,110}[a-z0-9]$/;

const publishSchema = z.object({
  docId: z.string().trim().min(1, { message: '缺少文档标识' }).max(64),
  title: z.string().trim().max(255).optional().default('未命名文档'),
  markdown: z.string().max(4_000_000, { message: '文档内容过大，无法发布' }),
  slug: z.string().trim().max(120).optional(),
  rev: z.coerce.number().int().min(1).max(2147483647).optional(),
  toc: z.boolean().optional().default(false),
});

/** 对外发布页地址 */
function publishUrl(slug) {
  return `${config.publicBaseUrl}/p/${slug}`;
}

/** 对象键：mdadmin/publish/<slug>.html */
function publishKey(slug) {
  return `${adminPrefix('publish')}/${slug}.html`;
}

/** 把标题转成可用 slug；中文等非 ASCII 字符会被剥离 */
function toSlug(input) {
  const text = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return text.slice(0, 110);
}

/** 生成全局唯一 slug */
async function ensureSlug(desired, userId, docId) {
  let base = toSlug(desired);
  if (!SLUG_RE.test(base)) base = `doc-${randomToken(10).toLowerCase()}`;
  let candidate = base;
  for (let i = 0; i < 8; i += 1) {
    const row = await queryOne('SELECT id, user_id, doc_id FROM publishes WHERE slug = ? LIMIT 1', [candidate]);
    if (!row) return candidate;
    // 同一用户同一文档允许覆盖发布
    if (Number(row.user_id) === Number(userId) && row.doc_id === docId) return candidate;
    candidate = `${base.slice(0, 100)}-${randomToken(4).toLowerCase()}`;
  }
  return `${base.slice(0, 100)}-${randomToken(8).toLowerCase()}`;
}

/** 发布记录投影 */
function publicPublish(row) {
  return {
    id: Number(row.id),
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    rev: Number(row.rev ?? 1),
    url: row.url || publishUrl(row.slug),
    ossKey: row.oss_key ?? null,
    publicUrl: row.oss_key ? platformPublicUrl(row.oss_key) : null,
    createdAt: row.created_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

/** 简单的 HTML 提示页，供 /p/ 路由使用 */
function htmlError(status, title, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#1a1d21;
font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.box{max-width:520px;padding:40px 28px;text-align:center}
h1{font-size:20px;margin:0 0 12px}
p{color:#5c6370;font-size:14px;line-height:1.7;margin:0}
.badge{display:inline-block;margin-bottom:18px;padding:4px 10px;border-radius:999px;
background:rgba(22,119,255,.08);color:#1677FF;font-size:12px;font-weight:600}</style></head>
<body><div class="box"><div class="badge">Neo MD</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

export async function publishRoutes(app) {
  /* ---------------- 登录用户 ---------------- */

  // 发布文档
  app.post('/api/publish', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(publishSchema, req.body, '发布内容');
    const slug = await ensureSlug(body.slug || body.title || body.docId, req.user.id, body.docId);
    const key = publishKey(slug);

    const html = buildStandaloneHtml({
      title: body.title || '未命名文档',
      markdown: body.markdown,
      toc: Boolean(body.toc),
      footerHtml: `由 <a href="${escapeHtml(config.publicBaseUrl)}" target="_blank" rel="noopener">Neo MD</a> 发布 · ${new Date().toISOString().slice(0, 10)}`,
    });

    try {
      await putPlatformObject(key, html, 'text/html; charset=utf-8');
    } catch (err) {
      throw new HttpError(502, 'OSS_UPLOAD_FAILED', `发布失败：对象存储不可用（${err.message}）`);
    }

    const url = publishUrl(slug);
    const existing = await queryOne('SELECT * FROM publishes WHERE slug = ? LIMIT 1', [slug]);
    let id;
    let rev = Number(body.rev ?? 1);

    if (existing) {
      // 覆盖发布：同一用户同一文档同 slug 时更新对象与版本号
      rev = Math.max(Number(existing.rev ?? 1), rev) + 1;
      await execute(
        "UPDATE publishes SET title = ?, oss_key = ?, url = ?, rev = ?, revoked_at = NULL WHERE id = ?",
        [body.title || '未命名文档', key, url, rev, existing.id],
      );
      id = Number(existing.id);
    } else {
      const result = await execute(
        'INSERT INTO publishes (user_id, doc_id, slug, title, oss_key, url, rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [req.user.id, body.docId, slug, body.title || '未命名文档', key, url, rev],
      );
      id = Number(result.insertId);
    }

    await audit(req, 'publish.save', `publish:${id}`, { docId: body.docId, slug, rev });

    const row = await queryOne('SELECT * FROM publishes WHERE id = ? LIMIT 1', [id]);
    return ok(reply, publicPublish(row), 201);
  });

  // 我的发布列表
  app.get('/api/publish', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { page, pageSize, search } = parse(paginationSchema, req.query, '分页参数');
    const filters = ['user_id = ?'];
    const params = [req.user.id];
    if (search) {
      filters.push('(title LIKE ? OR slug LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = filters.join(' AND ');
    const offset = (page - 1) * pageSize;

    const rows = await query(
      `SELECT * FROM publishes WHERE ${where} AND revoked_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM publishes WHERE ${where} AND revoked_at IS NULL`, params);

    return ok(reply, {
      items: rows.map(publicPublish),
      page,
      pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  // 取消发布（同时删除对象存储上的 HTML）
  app.delete('/api/publish/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '发布编号');
    const row = await queryOne('SELECT * FROM publishes WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('发布记录不存在', 'PUBLISH_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id && req.user.role !== 'admin') {
      throw new HttpError(403, 'PUBLISH_FORBIDDEN', '只能删除自己的发布记录');
    }
    if (row.oss_key) {
      await deletePlatformObject(row.oss_key);
    }
    if (!row.revoked_at) {
      await execute('UPDATE publishes SET revoked_at = NOW() WHERE id = ?', [id]);
    }
    await audit(req, 'publish.revoke', `publish:${id}`, { slug: row.slug });
    return ok(reply, { id, revoked: true, slug: row.slug });
  });

  /* ---------------- 公开访问 /p/:slug ---------------- */

  app.get('/p/:slug', async (req, reply) => {
    const slug = String(req.params.slug ?? '');
    const row = await queryOne('SELECT * FROM publishes WHERE slug = ? LIMIT 1', [slug]);
    if (!row || row.revoked_at) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(htmlError(404, '页面不存在', '该发布已被作者取消，或者链接不正确。'));
    }

    const cfg = platformConfig();
    // 桶允许匿名读时直接跳转公共域名；私有桶由服务端代理输出，避免匿名 403
    if (config.oss.publicRead && cfg.publicDomain) {
      return reply.redirect(platformPublicUrl(row.oss_key), 302);
    }
    try {
      const object = await getPlatformObject(row.oss_key);
      return reply.code(200).type('text/html; charset=utf-8').send(object.buffer);
    } catch (err) {
      return reply
        .code(502)
        .type('text/html; charset=utf-8')
        .send(htmlError(502, '内容暂时不可用', `读取发布内容失败：${err.message}`));
    }
  });
}

export default publishRoutes;
