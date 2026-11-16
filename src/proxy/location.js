'use strict';

/**
 * 3xx 的 `location` 改寫（規格 §6，同 LocalMonkey §4.3）。
 * 指向 target_origin → 改成 /p/<siteId>/...；指向別的網域 → 原樣保留。
 */

/**
 * @param {string} location
 * @param {{ targetOrigin: string, siteId: string }} options
 * @returns {string}
 */
function rewriteLocation(location, options) {
  if (typeof location !== 'string' || location === '') return location;

  const { targetOrigin, siteId } = options;
  const prefix = `/p/${siteId}`;

  // protocol-relative（//cdn/x）視為跨網域，不動。
  if (location.startsWith('//')) return location;

  // 根絕對路徑：不改會打到代理根路徑，只能靠 cookie fallback 猜，很脆。
  if (location.startsWith('/')) {
    if (location === prefix || location.startsWith(`${prefix}/`)) return location;
    return `${prefix}${location}`;
  }

  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    // 相對路徑（next-page.html）或壞掉的值：交給瀏覽器照原本的規則解析。
    return location;
  }

  if (parsed.origin !== targetOrigin) return location;
  return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

module.exports = { rewriteLocation };
