'use strict';

/**
 * 判斷一個 content-type 要不要擷取 body（規格 §5.3）。
 *
 * 只擷取文字類型。影片、圖片這類 binary 只記 metadata ——
 * 一方面 SQLite 不是用來放影片的，另一方面本專案的目的是理解實作，不是把內容搬走。
 */

/** 規格 §5.3 明列的可擷取類型。 */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
]);

/**
 * 去掉 `; charset=...` 參數並轉小寫。
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeContentType(raw) {
  if (typeof raw !== 'string') return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return base === '' ? null : base;
}

/**
 * @param {unknown} raw content-type header 原值
 * @returns {boolean} true 表示可以安全地當成文字存起來
 */
function isTextCapturable(raw) {
  const type = normalizeContentType(raw);
  if (type === null) return false;
  if (type.startsWith('text/')) return true;
  if (TEXT_TYPES.has(type)) return true;
  // application/problem+json、application/atom+xml 這類結構化後綴仍是文字。
  return type.endsWith('+json') || type.endsWith('+xml');
}

module.exports = { isTextCapturable, normalizeContentType, TEXT_TYPES };
