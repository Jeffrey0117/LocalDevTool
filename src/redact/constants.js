'use strict';

/**
 * 遮蔽相關的共用常數（規格 §5）。
 *
 * 集中保存流量 = 集中保存憑證的風險。這裡的預設值決定了整個專案的安全姿態，
 * 改動前請先讀 docs/SPEC.md §5 與 test/redact-*.test.js。
 */

/** 被遮蔽的值一律換成這個標記，讓使用者知道「有東西但我們刻意不存」。 */
const REDACTED = '[REDACTED]';

/** 規格 §5.1：這些 header 的值一律不落地。 */
const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'api-key',
]);

/** 規格 §5.1：JSON body 裡命中這些 key 的值要遮蔽。 */
const SENSITIVE_BODY_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'password',
  'secret',
  'client_secret',
]);

/**
 * 規格 §5.2：URL query 出現這些參數視為簽章網址（signed-url）。
 * 比對時一律小寫。
 */
const SIGNED_URL_PARAMS = new Set([
  'token',
  'expires',
  'signature',
  'policy',
  'hdnts',
  'x-amz-signature',
]);

/** JWT payload 裡屬於個資、只能記「有這個 claim」不能記值的欄位之外，白名單才是安全做法。 */
const JWT_SAFE_CLAIMS = ['iss', 'exp', 'iat'];

module.exports = {
  REDACTED,
  SENSITIVE_HEADERS,
  SENSITIVE_BODY_KEYS,
  SIGNED_URL_PARAMS,
  JWT_SAFE_CLAIMS,
};
