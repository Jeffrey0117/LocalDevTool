'use strict';

const { REDACTED, SENSITIVE_HEADERS } = require('./constants');

/**
 * 遮蔽 header 中的憑證（規格 §5.1）。
 *
 * 回傳新物件，不修改輸入。陣列值（例如多條 set-cookie）逐條遮蔽，
 * 保留條目數量這個「形狀」資訊，但不保留任何值。
 *
 * @param {Record<string, string|string[]>} headers
 * @param {{ captureSecrets?: boolean }} [options]
 *   captureSecrets=true 會讓憑證明文落地到 SQLite —— 危險選項，預設 false。
 * @returns {Record<string, string|string[]>}
 */
function redactHeaders(headers, options = {}) {
  if (!headers || typeof headers !== 'object') return {};

  const captureSecrets = options.captureSecrets === true;
  const entries = Object.entries(headers).map(([name, value]) => {
    if (captureSecrets) return [name, value];
    if (!SENSITIVE_HEADERS.has(name.toLowerCase())) return [name, value];
    return [name, Array.isArray(value) ? value.map(() => REDACTED) : REDACTED];
  });

  return Object.fromEntries(entries);
}

module.exports = { redactHeaders, SENSITIVE_HEADERS, REDACTED };
