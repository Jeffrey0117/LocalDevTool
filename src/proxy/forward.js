'use strict';

const { assertSafeTarget } = require('../net/ssrf');
const { buildUpstreamHeaders } = require('./request-headers');

/**
 * 實際往上游發請求（規格 §6）。
 *
 * `durationMs` 的定義很重要：這是 **Node 發出請求到取得回應標頭** 的時間，
 * 不是瀏覽器完整載入時間。面板的欄位名與 tooltip 必須講清楚（規格 §4）。
 */

/**
 * @param {object} input
 * @param {string} input.targetOrigin
 * @param {string} input.method
 * @param {string} input.pathWithQuery 一定以 / 開頭，含 query，原樣不做正規化
 * @param {Record<string, string|string[]>} input.incomingHeaders
 * @param {Buffer|null} input.body
 * @param {boolean} input.allowPrivate
 * @param {number} input.timeoutMs
 * @returns {Promise<{
 *   status: number, headers: Headers, bodyBuffer: Buffer,
 *   durationMs: number, upstreamUrl: string, host: string, path: string
 * }>}
 */
async function forwardUpstream(input) {
  const {
    targetOrigin,
    method,
    pathWithQuery,
    incomingHeaders,
    body,
    allowPrivate,
    timeoutMs,
  } = input;

  // 每次請求都重驗一次 —— 只在登記 site 時驗的話擋不住 DNS rebinding（規格 §6.2）。
  await assertSafeTarget(targetOrigin, { allowPrivate });

  // 刻意用字串串接而不是 new URL()：URL 會把 `/a/../b` 正規化、也可能動到
  // 百分號編碼，而代理的義務是把使用者的請求原樣送到上游。
  const upstreamUrl = `${targetOrigin}${pathWithQuery}`;
  const parsed = new URL(upstreamUrl);

  const headers = buildUpstreamHeaders(incomingHeaders, { upstreamHost: parsed.host });
  const hasBody = body !== null && body !== undefined && body.length > 0;
  const upperMethod = String(method).toUpperCase();
  const bodyAllowed = upperMethod !== 'GET' && upperMethod !== 'HEAD';

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: upperMethod,
      headers,
      body: hasBody && bodyAllowed ? body : undefined,
      // 一定要 manual：自動跟隨會讓我們看不到 3xx，也就無法改寫 location。
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const wrapped = new Error(`上游請求失敗：${error.message}`);
    wrapped.code = 'UPSTREAM_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
  // fetch 在「標頭到手」時 resolve，所以這裡量到的就是規格定義的 duration。
  const durationMs = Date.now() - startedAt;

  const bodyBuffer = Buffer.from(await response.arrayBuffer());

  return {
    status: response.status,
    headers: response.headers,
    bodyBuffer,
    durationMs,
    upstreamUrl,
    host: parsed.host,
    path: parsed.pathname,
  };
}

module.exports = { forwardUpstream };
