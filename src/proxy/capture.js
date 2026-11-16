'use strict';

const { insertRequest } = require('../store/requests');
const { newId } = require('../util/ids');

/**
 * 把一次轉送變成一筆 `requests` 紀錄（規格 §6.1）。
 *
 * 兩個硬性要求：
 *  1. 寫入必須在**回應送出之後**才做，不能拖慢代理
 *  2. 寫入失敗**絕對不能**影響已經送出的回應 —— 觀測工具弄壞被觀測的流量是最糟的失敗
 */

/** fetch 的 Headers → 普通物件，set-cookie 保留成陣列（多條各自一筆）。 */
function headersToObject(headers) {
  if (!headers || typeof headers.forEach !== 'function') return { ...(headers || {}) };

  const result = {};
  for (const [name, value] of headers.entries()) {
    result[name] = value;
  }
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) result['set-cookie'] = cookies;
  }
  return result;
}

/**
 * 純函式：組出要寫進 DB 的 record。遮蔽與 body 上限由 store 層負責。
 *
 * @param {object} input
 * @returns {object}
 */
function buildProxyRecord(input) {
  const resHeaders = headersToObject(input.resHeaders);
  return {
    id: newId('req'),
    sessionId: input.sessionId ?? null,
    siteId: input.siteId ?? null,
    ts: new Date().toISOString(),
    source: input.source || 'proxy',
    method: String(input.method || 'GET').toUpperCase(),
    url: input.upstreamUrl,
    host: input.host,
    path: input.path,
    status: input.status ?? null,
    durationMs: input.durationMs ?? null,
    resBytes: input.resBodyBuffer ? input.resBodyBuffer.length : null,
    reqHeaders: { ...(input.reqHeaders || {}) },
    resHeaders,
    reqBody: input.reqBodyBuffer && input.reqBodyBuffer.length > 0 ? input.reqBodyBuffer : null,
    resBody: input.resBodyBuffer ?? null,
    corrId: input.corrId ?? null,
    replayOf: input.replayOf ?? null,
  };
}

/**
 * 寫入紀錄，吞掉所有錯誤。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} record
 * @param {{ captureSecrets: boolean, bodyCap: number }} options
 * @returns {string|null} 寫入的 id，失敗回 null
 */
function persistRecord(db, record, options) {
  try {
    return insertRequest(db, record, options);
  } catch (error) {
    // 代理已經把回應送出去了，這裡只能記 log —— 不能讓觀測失敗變成代理失敗。
    console.error(`[LocalDevTool] 流量紀錄寫入失敗（代理本身未受影響）：${error.message}`);
    return null;
  }
}

module.exports = { buildProxyRecord, persistRecord, headersToObject };
