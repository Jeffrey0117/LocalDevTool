'use strict';

/**
 * 轉送到上游的請求 header（規格 §6，與 LocalMonkey §4.2 同一套規則）。
 */

/** hop-by-hop 與會打壞上游的 header。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'host',
  'content-length',
  // accept-encoding 也要拿掉：若把瀏覽器的 accept-encoding 轉給上游，undici 就不會
  // 自動解壓（它只解自己協商出來的編碼），而我們又固定丟掉 content-encoding ——
  // 結果是瀏覽器收到壓縮位元組卻以為是純文字，整頁亂碼。
  'accept-encoding',
]);

/**
 * @param {Record<string, string|string[]>} incoming
 * @param {{ upstreamHost: string }} options
 * @returns {Record<string, string>} 給 fetch 用的 header 物件
 */
function buildUpstreamHeaders(incoming, options) {
  const result = {};

  for (const [name, value] of Object.entries(incoming || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  result.host = options.upstreamHost;
  return result;
}

module.exports = { buildUpstreamHeaders, HOP_BY_HOP };
