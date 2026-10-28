/**
 * 审计日志：所有管理员变更与认证事件都落库，失败不影响主流程。
 */
import { execute } from '../db/pool.js';

/**
 * 写入一条审计记录。
 * @param {object} req Fastify 请求对象（可空）
 * @param {string} action 动作标识，如 auth.login / admin.user.update
 * @param {string|null} target 作用对象
 * @param {object|string|null} detail 附加信息
 * @param {number|null} userId 显式指定用户 id，默认取 req.user
 */
export async function audit(req, action, target = null, detail = null, userId = null) {
  const actorId = userId ?? req?.user?.id ?? null;
  const ip = req ? clientIp(req) : null;
  let detailJson = null;
  if (detail !== null && detail !== undefined) {
    try {
      detailJson = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch {
      detailJson = String(detail);
    }
    if (detailJson && detailJson.length > 8000) detailJson = `${detailJson.slice(0, 8000)}…`;
  }
  try {
    await execute(
      'INSERT INTO audit_logs (user_id, action, target, detail_json, ip, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [actorId, String(action).slice(0, 64), target === null ? null : String(target).slice(0, 255), detailJson, ip],
    );
  } catch (err) {
    req?.log?.warn?.({ err }, '写入审计日志失败');
  }
}

/** 取真实客户端 IP（考虑反向代理） */
export function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const first = String(raw).split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  const real = req?.headers?.['x-real-ip'];
  if (real) return String(real).slice(0, 64);
  return String(req?.ip ?? req?.raw?.socket?.remoteAddress ?? '').slice(0, 64);
}

export default { audit, clientIp };
