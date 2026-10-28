/**
 * MySQL 连接池与查询/事务辅助。
 * DATETIME 统一以字符串返回，避免时区二次转换带来的偏移。
 */
import mysql from 'mysql2/promise';
import config from '../config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  maxIdle: config.db.connectionLimit,
  idleTimeout: 60_000,
  queueLimit: 0,
  charset: 'utf8mb4_0900_ai_ci',
  timezone: 'Z',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  multipleStatements: false,
  namedPlaceholders: false,
});

/** 执行查询，返回结果行 */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 执行查询并只取第一行 */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 执行写入，返回 ResultSetHeader */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * 事务包装：fn 收到一个带 query/execute 的连接句柄，
 * 抛出异常自动回滚。
 */
export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const handle = {
      query: async (sql, params = []) => {
        const [rows] = await conn.query(sql, params);
        return rows;
      },
      execute: async (sql, params = []) => {
        const [result] = await conn.execute(sql, params);
        return result;
      },
    };
    const result = await fn(handle);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* 回滚失败不掩盖原始异常 */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** 健康检查：SELECT 1 */
export async function ping() {
  const rows = await query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

/** 关闭连接池 */
export async function closePool() {
  await pool.end();
}

export default pool;
