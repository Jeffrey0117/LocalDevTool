'use strict';

const { SIGNED_URL_PARAMS } = require('./constants');
const { looksLikeJwt } = require('./jwt');

/**
 * 判定「授權的形狀」（規格 §5.2）。
 *
 * 這是遮蔽的補償機制：使用者問「這站有沒有 JWT / session？」要答得出來，
 * 但我們不需要、也不應該存下 token 本身。所以這裡輸出的字串**永不包含任何憑證值**。
 *
 * 多種形狀同時成立時以 `+` 串接，顯著度高的排前面（Authorization > signed-url > cookie）。
 * 規格的 auth_shape 範例是單值，但一支帶 Bearer 的請求同時用 cookie 維持 session 是常見事實，
 * 丟掉其中一個會讓答案失真。
 */

/** @param {string} value @returns {string} */
function authorizationShape(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';

  const [scheme, ...rest] = trimmed.split(/\s+/);
  const credentials = rest.join(' ');
  const lowered = scheme.toLowerCase();

  if (lowered === 'bearer') {
    return looksLikeJwt(credentials) ? 'bearer:jwt-like' : 'bearer:opaque';
  }
  if (lowered === 'basic') return 'basic';
  return 'other';
}

/** 只取 cookie 名稱，值一律丟掉。 @param {string} value @returns {string} */
function cookieShape(value) {
  const names = value
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter((name) => name !== '');

  return names.length > 0 ? `cookie:${names.join(',')}` : '';
}

/** @param {string} url @returns {boolean} */
function hasSignedUrlParams(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_URL_PARAMS.has(key.toLowerCase())) return true;
  }
  return false;
}

/** @param {Record<string, unknown>} headers @param {string} wanted @returns {string} */
function headerValue(headers, wanted) {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    const flat = Array.isArray(value) ? value.join('; ') : value;
    if (typeof flat === 'string') return flat;
  }
  return '';
}

/**
 * @param {{ headers?: Record<string, unknown>, url?: string }} [input]
 * @returns {string|null} 例 'bearer:jwt-like'、'cookie:sid,theme'、'signed-url'，無跡象回 null
 */
function detectAuthShape(input = {}) {
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
  const url = typeof input.url === 'string' ? input.url : '';

  const shapes = [];

  const authorization = headerValue(headers, 'authorization');
  if (authorization !== '') {
    const shape = authorizationShape(authorization);
    if (shape !== '') shapes.push(shape);
  }

  if (url !== '' && hasSignedUrlParams(url)) shapes.push('signed-url');

  const cookie = headerValue(headers, 'cookie');
  if (cookie.trim() !== '') {
    const shape = cookieShape(cookie);
    if (shape !== '') shapes.push(shape);
  }

  return shapes.length > 0 ? shapes.join('+') : null;
}

module.exports = { detectAuthShape, SIGNED_URL_PARAMS };
