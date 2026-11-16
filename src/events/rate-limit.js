'use strict';

/**
 * 極簡的固定視窗 rate limit（規格 §9 對 /__ldt/events 的要求）。
 *
 * 這個端點不需要 admin token，所以必須有量的上限 ——
 * 一個失控（或惡意）的注入腳本可以每秒打上千次，把 SQLite 寫爆。
 * 刻意只用記憶體：重啟歸零是可接受的，為了這個裝 Redis 不值得。
 */

const WINDOW_MS = 60 * 1000;

function createRateLimiter(maxPerWindow, windowMs = WINDOW_MS) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  /** @param {string} key 通常是來源 IP @returns {{ allowed: boolean, retryAfterSeconds: number }} */
  function check(key) {
    const now = Date.now();
    const existing = buckets.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // 不可變更新：換一個新物件，不原地改。
    const next = { count: existing.count + 1, resetAt: existing.resetAt };
    buckets.set(key, next);

    if (next.count > maxPerWindow) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((next.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 清掉過期的 bucket，避免 Map 無限成長。 */
  function prune() {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return { check, prune, size: () => buckets.size };
}

module.exports = { createRateLimiter, WINDOW_MS };
