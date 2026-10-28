/**
 * 积分：余额与流水查询、兑换码核销、公开计费配置。
 *
 * 兑换码核销整体放在一个事务里：先锁码行，标记已用，再给用户加积分并写流水，
 * 因此并发重复提交只会成功一次。
 */
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { conflict, notFound, ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { userRateLimit } from '../middleware/rate.js';
import { ledgerItem, loadBilling, readBalance } from '../lib/platform.js';

/** 流水默认返回条数 */
const LEDGER_LIMIT = 50;

const redeemSchema = z.object({
  code: z
    .string({ error: '请输入兑换码' })
    .trim()
    .min(4, { message: '兑换码至少 4 个字符' })
    .max(24, { message: '兑换码最多 24 个字符' })
    .regex(/^[A-Za-z0-9-]+$/, { message: '兑换码只能包含字母、数字与短横线' })
    .transform((value) => value.toUpperCase()),
});

export async function creditsRoutes(app) {
  // 公开计费配置
  app.get('/api/credits/pricing', async (_req, reply) => {
    const billing = await loadBilling();
    return ok(reply, billing);
  });

  // 余额 + 最近流水
  app.get('/api/credits', { preHandler: [app.authenticate] }, async (req, reply) => {
    const [balance, rows] = await Promise.all([
      readBalance(req.user.id),
      query('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?', [req.user.id, LEDGER_LIMIT]),
    ]);
    return ok(reply, { balance, ledger: rows.map(ledgerItem) });
  });

  // 兑换码核销（每用户每小时 5 次）
  app.post(
    '/api/credits/redeem',
    { preHandler: [app.authenticate, userRateLimit('redeem')] },
    async (req, reply) => {
      const body = parse(redeemSchema, req.body, '兑换码');

      const result = await tx(async (conn) => {
        const rows = await conn.query(
          'SELECT id, code, credits, used_by, used_at FROM redeem_codes WHERE code = ? LIMIT 1 FOR UPDATE',
          [body.code],
        );
        const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        if (!row) return { status: 'missing' };
        if (row.used_by !== null && row.used_by !== undefined) return { status: 'used' };

        // 条件更新：即便并发抢到同一行，也只有一次 affectedRows = 1
        const updated = await conn.execute(
          'UPDATE redeem_codes SET used_by = ?, used_at = NOW() WHERE id = ? AND used_by IS NULL',
          [req.user.id, row.id],
        );
        if (Number(updated?.affectedRows ?? 0) === 0) return { status: 'used' };

        const credits = Number(row.credits ?? 0);
        const userRows = await conn.query('SELECT credits FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [req.user.id]);
        const current = Number(userRows?.[0]?.credits ?? 0);
        const balance = current + credits;
        await conn.execute('UPDATE users SET credits = ? WHERE id = ?', [balance, req.user.id]);
        await conn.execute(
          `INSERT INTO credit_ledger (user_id, delta, balance_after, kind, ref, detail_json, created_at)
           VALUES (?, ?, ?, 'recharge', ?, ?, NOW())`,
          [req.user.id, credits, balance, row.code, JSON.stringify({ code: row.code, credits })],
        );

        return { status: 'ok', added: credits, balance, code: row.code };
      });

      if (result.status === 'missing') throw notFound('兑换码不存在，请核对后重试', 'REDEEM_CODE_NOT_FOUND');
      if (result.status === 'used') throw conflict('该兑换码已被使用', 'REDEEM_CODE_USED');

      await audit(req, 'credits.redeem', `redeem:${result.code}`, {
        added: result.added,
        balance: result.balance,
        code: result.code,
      });

      return ok(reply, { added: result.added, balance: result.balance });
    },
  );
}

export default creditsRoutes;
