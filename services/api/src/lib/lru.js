/**
 * 极简 TTL + LRU 缓存。没有 Redis，进程内 Map 即可满足读多写少的缓存需求。
 */
export class LruCache {
  /**
   * @param {object} [options]
   * @param {number} [options.max=1000] 最大条目数
   * @param {number} [options.ttlMs=60000] 默认存活毫秒
   */
  constructor(options = {}) {
    this.max = Math.max(1, Number(options.max) || 1000);
    this.ttlMs = Math.max(0, Number(options.ttlMs ?? 60_000));
    /** @type {Map<string, {value: unknown, expireAt: number}>} */
    this.store = new Map();
  }

  /** 读取，过期项视为不存在 */
  get(key) {
    const item = this.store.get(key);
    if (!item) return undefined;
    if (item.expireAt !== 0 && item.expireAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // 命中后移到队尾，维持 LRU 顺序
    this.store.delete(key);
    this.store.set(key, item);
    return item.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * 写入，ttlMs 省略时使用默认值，0 表示永不过期
   */
  set(key, value, ttlMs) {
    if (this.store.has(key)) this.store.delete(key);
    const ttl = ttlMs === undefined ? this.ttlMs : Number(ttlMs);
    this.store.set(key, {
      value,
      expireAt: ttl > 0 ? Date.now() + ttl : 0,
    });
    this.evict();
    return this;
  }

  /** 读取不存在时用 factory 生成并缓存 */
  async remember(key, factory, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    if (value !== undefined) this.set(key, value, ttlMs);
    return value;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }

  /** 清理过期项，并按 LRU 淘汰溢出条目 */
  evict() {
    const now = Date.now();
    for (const [key, item] of this.store) {
      if (item.expireAt !== 0 && item.expireAt <= now) this.store.delete(key);
    }
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

export default LruCache;
