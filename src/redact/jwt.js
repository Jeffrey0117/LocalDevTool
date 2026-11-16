'use strict';

const { JWT_SAFE_CLAIMS } = require('./constants');

/**
 * JWT 的 header 與 payload 是 base64url，不是加密 —— 任何人都讀得到，
 * 所以 decode 它們本身不洩漏額外資訊。但本模組刻意**只**輸出非個資欄位。
 *
 * 絕對不做的事（規格 §5.2）：
 *  - 不聲稱簽章有效（我們沒有金鑰，根本驗不了）
 *  - 不輸出 sub / email / name 這類 claim 的值，只輸出「有哪些 claim」
 */

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/** @param {string} segment @returns {unknown|null} */
function decodeSegment(segment) {
  if (typeof segment !== 'string' || !SEGMENT_PATTERN.test(segment)) return null;
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 三段 base64url，且第一段 decode 後是帶 `alg` 的 JSON（規格 §5.2 的判定條件）。
 * @param {unknown} token
 * @returns {boolean}
 */
function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const header = decodeSegment(parts[0]);
  return Boolean(header && typeof header.alg === 'string');
}

/**
 * 保守地取出 JWT 的非機密資訊。
 *
 * @param {unknown} token
 * @returns {null | {
 *   alg: string, typ: string|null, iss: string|null, exp: number|null, iat: number|null,
 *   claims: string[], signatureVerified: false, note: string
 * }}
 */
function decodeJwtSafe(token) {
  if (!looksLikeJwt(token)) return null;

  const [headerSegment, payloadSegment] = token.split('.');
  const header = decodeSegment(headerSegment);
  const payload = decodeSegment(payloadSegment);

  const safe = {};
  for (const claim of JWT_SAFE_CLAIMS) {
    safe[claim] = payload && claim in payload ? payload[claim] : null;
  }

  return {
    alg: header.alg,
    typ: typeof header.typ === 'string' ? header.typ : null,
    ...safe,
    claims: payload ? Object.keys(payload) : [],
    signatureVerified: false,
    note: '觀察到 Bearer Token，結構符合 JWT（未驗證簽章）',
  };
}

module.exports = { looksLikeJwt, decodeJwtSafe };
