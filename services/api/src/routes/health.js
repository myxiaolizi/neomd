/**
 * 健康检查：探活数据库并返回进程运行信息。
 * 该接口按约定直接返回 { ok, db, uptime, version }（不走 { ok, data } 包装）。
 */
import { ping } from '../db/pool.js';
import config from '../config.js';

export async function healthRoutes(app) {
  app.get('/api/health', async (_req, reply) => {
    let db = false;
    try {
      db = await ping();
    } catch {
      db = false;
    }
    const body = {
      ok: db,
      db,
      uptime: Math.round(process.uptime()),
      version: config.version,
      env: config.nodeEnv,
      time: new Date().toISOString(),
    };
    return reply.code(db ? 200 : 503).send(body);
  });
}

export default healthRoutes;
