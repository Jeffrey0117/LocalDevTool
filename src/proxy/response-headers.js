'use strict';

/**
 * 回傳給瀏覽器的回應 header（規格 §6）。
 *
 * CSP 一定要拿掉 —— 不然注入的 inspector.js 會被原站的 policy 擋下來，
 * 而且症狀是「注入看起來成功了但什麼都沒發生」，很難查。
 */

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  // body 已經被 undici 解壓、HTML 還可能被改寫過，長度與編碼都不再成立
  'content-encoding',
  'content-length',
  'transfer-encoding',
  // 本機是 http，HSTS 會讓瀏覽器以後強制走 https
  'strict-transport-security',
  'report-to',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  // set-cookie 走 cookies.js 逐條 append，不能跟一般 header 混在一起
  'set-cookie',
]);

/**
 * @param {Headers|Record<string, string|string[]>} headers
 * @returns {Record<string, string>}
 */
function filterResponseHeaders(headers) {
  const entries =
    headers && typeof headers.forEach === 'function' && typeof headers.get === 'function'
      ? [...headers.entries()]
      : Object.entries(headers || {});

  const result = {};
  for (const [name, value] of entries) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

module.exports = { filterResponseHeaders, DROPPED_RESPONSE_HEADERS };
