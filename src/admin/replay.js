'use strict';

const { getRequest, insertRequest } = require('../store/requests');
const { forwardUpstream } = require('../proxy/forward');
const { HOP_BY_HOP } = require('../proxy/request-headers');
const { REDACTED } = require('../redact/constants');
const { newId } = require('../util/ids');
const { headersToObject } = require('../proxy/capture');

/**
 * 重送一筆擷取到的請求（規格 §9）。
 *
 * ⚠️ Replay 是**會產生副作用**的動作：重複下單、重複發文、重複寄信。
 * 所以非 GET/HEAD 一定要二次確認（`confirm: true`），由呼叫端負責讓使用者看到警告。
 *
 * 另一個誠實度問題：被遮蔽過的 Authorization / Cookie **無法重放** ——
 * 值已經不在資料庫裡了。這時候不能靜默送出一個註定失敗的請求讓人困惑，
 * 要明確告訴使用者「這會以未授權狀態送出」。
 */

const SIDE_EFFECT_WARNING =
  '這可能在目標網站產生真實副作用（例如重複下單、重複發文）。確認後才會送出。';

/** @param {unknown} value @returns {boolean} */
function isRedacted(value) {
  if (value === REDACTED) return true;
  return Array.isArray(value) && value.some((item) => item === REDACTED);
}

/**
 * 重建可以送出的 header，並回報哪些憑證已經不在了。
 * @param {Record<string, unknown>} original
 * @returns {{ headers: Record<string, string>, warnings: string[] }}
 */
function rebuildHeaders(original) {
  const headers = {};
  const warnings = [];

  for (const [name, value] of Object.entries(original || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;

    if (isRedacted(value)) {
      warnings.push(
        `此請求的 ${lower} 已遮蔽，值已經不在資料庫裡 —— replay 會以未授權狀態送出，` +
          '目標很可能回 401/403。',
      );
      continue; // 絕不把字面的 [REDACTED] 當成憑證送出去
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  return { headers, warnings };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @param {{ id: string, confirm?: boolean }} input
 * @returns {Promise<object>} 結果或 { notFound } / { needsConfirmation }
 */
async function replayRequest(db, config, input) {
  const original = getRequest(db, input.id);
  if (original === null) return { notFound: true };

  const method = String(original.method || 'GET').toUpperCase();
  const isSafeMethod = method === 'GET' || method === 'HEAD';

  if (!isSafeMethod && input.confirm !== true) {
    return { needsConfirmation: true, method, warning: SIDE_EFFECT_WARNING };
  }

  const { headers, warnings } = rebuildHeaders(original.reqHeaders);

  let target;
  try {
    target = new URL(original.url);
  } catch {
    return { badUrl: true, message: `原請求的 URL 無法解析：${original.url}` };
  }

  const upstream = await forwardUpstream({
    targetOrigin: target.origin,
    method,
    pathWithQuery: `${target.pathname}${target.search}`,
    incomingHeaders: headers,
    body: typeof original.reqBody === 'string' ? Buffer.from(original.reqBody, 'utf8') : null,
    allowPrivate: config.allowPrivate,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const requestId = newId('req');
  insertRequest(
    db,
    {
      id: requestId,
      sessionId: original.sessionId,
      siteId: original.siteId,
      ts: new Date().toISOString(),
      source: 'replay',
      method,
      url: upstream.upstreamUrl,
      host: upstream.host,
      path: upstream.path,
      status: upstream.status,
      durationMs: upstream.durationMs,
      resBytes: upstream.bodyBuffer.length,
      reqHeaders: headers,
      resHeaders: headersToObject(upstream.headers),
      reqBody: original.reqBody,
      resBody: upstream.bodyBuffer,
      corrId: original.corrId,
      replayOf: original.id,
    },
    { captureSecrets: config.captureSecrets, bodyCap: config.bodyCap },
  );

  return {
    requestId,
    replayOf: original.id,
    status: upstream.status,
    durationMs: upstream.durationMs,
    warnings,
  };
}

module.exports = { replayRequest, rebuildHeaders, SIDE_EFFECT_WARNING };
