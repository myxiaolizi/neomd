/**
 * 加密相关工具：argon2 口令哈希、AES-256-GCM 字段加密、sha256、随机令牌。
 */
import crypto from 'node:crypto';
import argon2 from 'argon2';
import config from '../config.js';

/** argon2id 参数：约 19MiB 内存、2 轮，兼顾安全与登录耗时 */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

/** 生成口令哈希 */
export async function hashPassword(password) {
  return argon2.hash(String(password), ARGON_OPTIONS);
}

/** 校验口令，任何异常都视为校验失败 */
export async function verifyPassword(hash, password) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, String(password));
  } catch {
    return false;
  }
}

/** AES-256-GCM 主密钥 */
function secretsKey() {
  return Buffer.from(config.secretsKey, 'base64');
}

/**
 * 加密任意可序列化对象，返回 `v1.<iv>.<ciphertext>.<tag>`（base64url）。
 */
export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretsKey(), iv);
  const plain = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** 解密 encryptJson 的结果；失败时抛出异常 */
export function decryptJson(payload) {
  if (payload === null || payload === undefined || payload === '') return null;
  const text = String(payload);
  const parts = text.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('密文格式不正确');
  }
  const [, ivB64, dataB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretsKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

/** 宽松解密：损坏或缺失时返回 null，避免读接口整体失败 */
export function decryptJsonSafe(payload) {
  try {
    return decryptJson(payload);
  } catch {
    return null;
  }
}

/** sha256 十六进制 */
export function sha256(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 生成 URL 安全随机令牌，默认 24 位。
 * @param {number} len
 * @param {string} alphabet
 */
export function randomToken(len = 24, alphabet = TOKEN_ALPHABET) {
  const n = Math.max(1, Math.trunc(len));
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

/** 生成强口令：至少含大写、小写、数字与符号各一 */
export function randomPassword(len = 20) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*-_=+?';
  const all = upper + lower + digit + symbol;
  const size = Math.max(12, Math.trunc(len));
  const chars = [
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    digit[crypto.randomInt(0, digit.length)],
    symbol[crypto.randomInt(0, symbol.length)],
  ];
  while (chars.length < size) chars.push(all[crypto.randomInt(0, all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** IP 指纹：加盐后取 sha256 前 32 位，用于评论记录而不泄露真实 IP */
export function ipHash(ip) {
  return sha256(`${config.jwt.secret.slice(0, 16)}|${String(ip ?? '')}`).slice(0, 32);
}

/** 稳定比较，避免时序侧信道 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default {
  hashPassword,
  verifyPassword,
  encryptJson,
  decryptJson,
  decryptJsonSafe,
  sha256,
  randomToken,
  randomPassword,
  ipHash,
  safeEqual,
};
