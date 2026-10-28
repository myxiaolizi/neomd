/**
 * 分享：登录用户生成文档快照分享链接，游客凭令牌阅读与评论。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import config from '../config.js';
import { ipHash, randomToken } from '../lib/crypto.js';
import { HttpError, forbidden, notFound, ok } from '../lib/http.js';
import { parse, parseId, paginationSchema } from '../lib/validate.js';
import { renderHtml } from '../lib/markdown.js';
import { audit, clientIp } from '../lib/audit.js';
import { ipRateLimit } from '../middleware/rate.js';

const TOKEN_RE = /^[A-Za-z0-9]{10,64}$/;

const createSchema = z.object({
  docId: z.string().trim().min(1, { message: '缺少文档标识' }).max(64),
  title: z.string().trim().max(255).optional().default('未命名文档'),
  markdown: z.string().max(4_000_000, { message: '文档内容过大，无法分享' }),
  mode: z.enum(['read', 'comment']).optional().default('comment'),
  allowComment: z.boolean().optional().default(true),
  expiresInDays: z.coerce.number().int().min(1).max(3650).optional().nullable(),
  accessCode: z.string().trim().max(64).optional().nullable(),
  style: z.any().optional().nullable(),
});

const commentSchema = z.object({
  authorName: z.string().trim().max(64).optional().default('匿名读者'),
  body: z
    .string({ error: '评论内容不能为空' })
    .trim()
    .min(1, { message: '评论内容不能为空' })
    .max(4000, { message: '评论内容最多 4000 个字符' }),
  annotation: z
    .object({
      quote: z.string().trim().max(2000).optional().default(''),
      selector: z.any().optional(),
    })
    .optional(),
});

/** 是否已过期 */
function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const text = String(expiresAt).replace(' ', 'T');
  const time = new Date(text.endsWith('Z') ? text : `${text}Z`).getTime();
  return Number.isFinite(time) ? time <= Date.now() : false;
}

/** 分享链接地址 */
function shareUrl(token) {
  return `${config.publicBaseUrl}/s/${token}`;
}

/** 生成不冲突的分享令牌 */
async function createUniqueToken() {
  for (let i = 0; i < 8; i += 1) {
    const token = randomToken(24);
    const exists = await queryOne('SELECT id FROM shares WHERE token = ? LIMIT 1', [token]);
    if (!exists) return token;
  }
  throw new HttpError(500, 'TOKEN_GENERATE_FAILED', '分享链接生成失败，请稍后重试');
}

/** 分享的对外投影 */
function publicShare(row) {
  return {
    id: Number(row.id),
    token: row.token,
    docId: row.doc_id,
    title: row.title,
    mode: row.mode,
    allowComment: Number(row.allow_comment) === 1,
    hasPassword: Boolean(row.access_code && String(row.access_code).trim() !== ''),
    viewCount: Number(row.view_count ?? 0),
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at ?? null,
    revokedAt: row.revoked_at ?? null,
    url: shareUrl(row.token),
  };
}

/** 按令牌读取有效分享，失效时抛出对应错误 */
async function loadActiveShare(token) {
  if (!TOKEN_RE.test(String(token ?? ''))) throw notFound('分享链接格式不正确', 'SHARE_NOT_FOUND');
  const row = await queryOne('SELECT * FROM shares WHERE token = ? LIMIT 1', [token]);
  if (!row) throw notFound('分享不存在或已被作者取消', 'SHARE_NOT_FOUND');
  if (row.revoked_at) throw notFound('分享已被作者取消', 'SHARE_REVOKED');
  if (isExpired(row.expires_at)) throw new HttpError(410, 'SHARE_EXPIRED', '分享链接已过期');
  return row;
}

export async function shareRoutes(app) {
  /* ---------------- 登录用户 ---------------- */

  // 创建分享
  app.post('/api/shares', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(createSchema, req.body, '分享内容');
    const allowComment = body.mode === 'read' ? false : body.allowComment !== false;
    const token = await createUniqueToken();
    const html = renderHtml(body.markdown);
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + Number(body.expiresInDays) * 24 * 60 * 60 * 1000)
      : null;
    const accessCode = body.accessCode && String(body.accessCode).trim() ? String(body.accessCode).trim().slice(0, 64) : null;
    const styleJson = body.style ? JSON.stringify(body.style) : null;

    let result;
    try {
      result = await execute(
        `INSERT INTO shares (user_id, doc_id, token, title, mode, snapshot_md, snapshot_html, allow_comment, access_code, style_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          req.user.id,
          body.docId,
          token,
          body.title || '未命名文档',
          body.mode ?? 'comment',
          body.markdown,
          html,
          allowComment ? 1 : 0,
          accessCode,
          styleJson,
          expiresAt,
        ],
      );
    } catch {
      result = await execute(
        `INSERT INTO shares (user_id, doc_id, token, title, mode, snapshot_md, snapshot_html, allow_comment, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          req.user.id,
          body.docId,
          token,
          body.title || '未命名文档',
          body.mode ?? 'comment',
          body.markdown,
          html,
          allowComment ? 1 : 0,
          expiresAt,
        ],
      );
    }
    await audit(req, 'share.create', `share:${result.insertId}`, { docId: body.docId, mode: body.mode });

    const row = await queryOne('SELECT * FROM shares WHERE id = ? LIMIT 1', [Number(result.insertId)]);
    return ok(reply, publicShare(row), 201);
  });

  // 我的分享列表
  app.get('/api/shares', { preHandler: [app.authenticate] }, async (req, reply) => {
    const queryParams = parse(paginationSchema, req.query, '分页参数');
    const filters = ['s.user_id = ?', 's.revoked_at IS NULL'];
    const params = [req.user.id];
    if (queryParams.search) {
      filters.push('s.title LIKE ?');
      params.push(`%${queryParams.search}%`);
    }
    const where = filters.join(' AND ');
    const offset = (queryParams.page - 1) * queryParams.pageSize;

    const rows = await query(
      `SELECT s.*, (SELECT COUNT(*) FROM share_comments c WHERE c.share_id = s.id AND c.status = 'visible') AS comment_count
       FROM shares s WHERE ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
      [...params, queryParams.pageSize, offset],
    );
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM shares s WHERE ${where}`, params);

    return ok(reply, {
      items: rows.map((row) => ({
        ...publicShare(row),
        commentCount: Number(row.comment_count ?? 0),
      })),
      page: queryParams.page,
      pageSize: queryParams.pageSize,
      total: Number(totalRow?.total ?? 0),
    });
  });

  // 取消分享
  app.delete('/api/shares/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '分享编号');
    const row = await queryOne('SELECT id, user_id, revoked_at FROM shares WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('分享不存在', 'SHARE_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('只能取消自己的分享', 'SHARE_FORBIDDEN');
    }
    if (!row.revoked_at) {
      await execute('UPDATE shares SET revoked_at = NOW() WHERE id = ?', [id]);
      await audit(req, 'share.revoke', `share:${id}`);
    }
    return ok(reply, { id, revoked: true });
  });

  // 作者查看单条分享下的评论列表
  app.get('/api/shares/:id/comments', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '分享编号');
    const row = await queryOne('SELECT id, user_id, title, token FROM shares WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('分享不存在', 'SHARE_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('无权查看该分享评论', 'SHARE_FORBIDDEN');
    }
    const comments = await query(
      `SELECT c.id, c.author_name, c.body, c.created_at, c.status, a.quote
       FROM share_comments c
       LEFT JOIN share_annotations a ON a.comment_id = c.id
       WHERE c.share_id = ?
       ORDER BY c.id DESC LIMIT 500`,
      [id],
    );
    return ok(reply, {
      items: comments.map((c) => ({
        id: Number(c.id),
        authorName: c.author_name ?? '匿名读者',
        body: c.body,
        quote: c.quote ?? '',
        status: c.status,
        createdAt: c.created_at ?? null,
      })),
    });
  });

  /* ---------------- 游客访问 ---------------- */

  // 读取分享内容（含密码校验、作者分享样式配置与评论）
  app.get('/api/public/shares/:token', async (req, reply) => {
    const share = await loadActiveShare(req.params.token);
    const requiredCode = share.access_code ? String(share.access_code).trim() : '';
    const givenCode = String(req.query?.code ?? req.headers['x-share-code'] ?? '').trim();

    // 读取作者的公开昵称/头像与个人分享样式设置
    const [authorRow, settingRow] = await Promise.all([
      queryOne('SELECT username, nickname, avatar_url FROM users WHERE id = ? LIMIT 1', [Number(share.user_id)]).catch(() => null),
      queryOne('SELECT payload_json FROM user_settings WHERE user_id = ? LIMIT 1', [Number(share.user_id)]).catch(() => null),
    ]);
    const userPayload = safeParseJson(settingRow?.payload_json);
    const shareStyle = safeParseJson(share.style_json) || userPayload?.shareStyle || null;
    const author = {
      username: authorRow?.username ?? '',
      nickname: authorRow?.nickname || authorRow?.username || '作者',
      avatarUrl: authorRow?.avatar_url ?? null,
    };

    if (requiredCode && givenCode !== requiredCode) {
      throw new HttpError(
        403,
        givenCode ? 'SHARE_PASSWORD_INVALID' : 'SHARE_PASSWORD_REQUIRED',
        givenCode ? '访问密码不正确，请重试' : '该分享设置了访问密码，请输入密码后查看',
      );
    }

    const comments = await query(
      `SELECT c.id, c.author_name, c.body, c.created_at, c.status,
              a.quote, a.selector_json, a.created_at AS annotation_created_at
       FROM share_comments c
       LEFT JOIN share_annotations a ON a.comment_id = c.id
       WHERE c.share_id = ? AND c.status = 'visible'
       ORDER BY c.id ASC LIMIT 500`,
      [Number(share.id)],
    );

    return ok(reply, {
      token: share.token,
      docId: share.doc_id,
      title: share.title,
      mode: share.mode,
      allowComment: Number(share.allow_comment) === 1,
      hasPassword: Boolean(requiredCode),
      viewCount: Number(share.view_count ?? 0),
      createdAt: share.created_at ?? null,
      expiresAt: share.expires_at ?? null,
      author,
      shareStyle,
      html: share.snapshot_html ?? '',
      markdown: share.snapshot_md ?? '',
      comments: comments.map((row) => ({
        id: Number(row.id),
        authorName: row.author_name ?? '匿名读者',
        body: row.body,
        createdAt: row.created_at ?? null,
        status: row.status,
        annotation: row.selector_json || row.quote
          ? {
              quote: row.quote ?? '',
              selector: safeParseJson(row.selector_json),
              createdAt: row.annotation_created_at ?? null,
            }
          : null,
      })),
    });
  });

  // 新增评论（可带划词批注）
  app.post(
    '/api/public/shares/:token/comments',
    { preHandler: [ipRateLimit('comment')] },
    async (req, reply) => {
      const share = await loadActiveShare(req.params.token);
      if (Number(share.allow_comment) !== 1) {
        throw forbidden('该分享未开放评论', 'SHARE_COMMENT_CLOSED');
      }
      const body = parse(commentSchema, req.body, '评论内容');
      const hash = ipHash(clientIp(req));

      const result = await execute(
        'INSERT INTO share_comments (share_id, author_name, body, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [Number(share.id), body.authorName || '匿名读者', body.body, hash, 'visible'],
      );
      const commentId = Number(result.insertId);

      let annotation = null;
      if (body.annotation && (body.annotation.quote || body.annotation.selector)) {
        const selectorJson = body.annotation.selector ? JSON.stringify(body.annotation.selector) : null;
        await execute(
          'INSERT INTO share_annotations (comment_id, share_id, quote, selector_json, created_at) VALUES (?, ?, ?, ?, NOW())',
          [commentId, Number(share.id), String(body.annotation.quote ?? '').slice(0, 2000), selectorJson],
        );
        annotation = {
          quote: body.annotation.quote ?? '',
          selector: body.annotation.selector ?? null,
        };
      }

      return ok(
        reply,
        {
          id: commentId,
          shareId: Number(share.id),
          authorName: body.authorName || '匿名读者',
          body: body.body,
          createdAt: new Date().toISOString(),
          status: 'visible',
          annotation,
        },
        201,
      );
    },
  );

  // 浏览量 +1
  app.post('/api/public/shares/:token/view', async (req, reply) => {
    const share = await loadActiveShare(req.params.token);
    await execute('UPDATE shares SET view_count = view_count + 1 WHERE id = ?', [Number(share.id)]);
    const row = await queryOne('SELECT view_count FROM shares WHERE id = ? LIMIT 1', [Number(share.id)]);
    return ok(reply, { token: share.token, viewCount: Number(row?.view_count ?? 0) });
  });
}

/** 解析 JSON 字段，损坏时返回 null */
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

export default shareRoutes;
