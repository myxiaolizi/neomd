/**
 * HTTP 响应约定与业务异常。
 * 成功：{ ok: true, data }
 * 失败：{ ok: false, error: { code, message } }
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code 机器可读错误码
   * @param {string} message 面向用户的中文提示
   * @param {unknown} [detail] 附加信息（仅开发环境输出）
   */
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const unauthorized = (message = '未登录或登录已过期', code = 'UNAUTHORIZED') => new HttpError(401, code, message);
export const forbidden = (message = '没有操作权限', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = '资源不存在', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message);
export const tooManyRequests = (message = '请求过于频繁，请稍后再试', code = 'RATE_LIMITED', retryAfter) => {
  const err = new HttpError(429, code, message);
  err.retryAfter = retryAfter;
  return err;
};
export const serverError = (message = '服务内部错误，请稍后再试', code = 'INTERNAL_ERROR') => new HttpError(500, code, message);

/** 成功响应 */
export function ok(reply, data, status = 200) {
  return reply.code(status).send({ ok: true, data: data === undefined ? null : data });
}

/** 失败响应（一般交给全局错误处理器，特殊场景可直接调用） */
export function fail(reply, status, code, message, extra) {
  return reply.code(status).send({
    ok: false,
    error: { code, message, ...(extra ? { detail: extra } : {}) },
  });
}

export default { HttpError, ok, fail, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests, serverError };
