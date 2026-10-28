/**
 * 请求体校验：统一用 zod，失败时返回可读的中文 400 提示。
 */
import { z } from 'zod';
import { badRequest } from './http.js';

/** 把 zod 错误整理成一行可读文本 */
export function formatIssues(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) return '请求参数不正确';
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '';
      const message = issue.message || '参数不正确';
      return path ? `${path}: ${message}` : message;
    })
    .join('；');
}

/**
 * 解析并校验输入，失败抛 400。
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} input
 * @param {string} [label]
 * @returns {T}
 */
export function parse(schema, input, label = '请求参数') {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw badRequest(`${label}校验失败：${formatIssues(result.error)}`, 'VALIDATION_ERROR');
  }
  return result.data;
}

export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,32}$/;
export const URL_RE = /^https?:\/\/[^\s]+$/i;

/** 邮箱 */
export const emailSchema = z
  .string({ error: '邮箱必须是字符串' })
  .trim()
  .min(3, { message: '邮箱不能为空' })
  .max(190, { message: '邮箱长度不能超过 190 个字符' })
  .regex(EMAIL_RE, { message: '邮箱格式不正确' })
  .transform((value) => value.toLowerCase());

/** 用户名 */
export const usernameSchema = z
  .string({ error: '用户名必须是字符串' })
  .trim()
  .min(2, { message: '用户名至少 2 个字符' })
  .max(32, { message: '用户名最多 32 个字符' })
  .regex(USERNAME_RE, { message: '用户名只能包含中英文、数字、下划线和短横线' });

/** 口令 */
export const passwordSchema = z
  .string({ error: '密码必须是字符串' })
  .min(8, { message: '密码至少 8 个字符' })
  .max(128, { message: '密码最多 128 个字符' });

/** 设备标识 */
export const deviceIdSchema = z
  .string()
  .trim()
  .max(64, { message: '设备标识最多 64 个字符' })
  .optional()
  .nullable();

/** 分页参数（查询串里都是字符串，统一转换） */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().max(120).optional().default(''),
});

/** 路径中的数字 id */
export function parseId(value, label = '编号') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw badRequest(`${label}不合法`, 'VALIDATION_ERROR');
  }
  return n;
}

/** 可选 URL */
export const urlSchema = z
  .string()
  .trim()
  .max(512)
  .regex(URL_RE, { message: '地址必须以 http:// 或 https:// 开头' });

export { z };

export default { parse, formatIssues, parseId, z };
