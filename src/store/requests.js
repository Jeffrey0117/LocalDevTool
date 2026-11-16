'use strict';

const { redactHeaders } = require('../redact/headers');
const { redactBodyText } = require('../redact/body');
const { detectAuthShape } = require('../redact/auth-shape');
const { isTextCapturable, normalizeContentType } = require('../util/body-type');
const { isoNow } = require('../util/ids');
const { indexBody, SELECT_COLUMNS } = require('./search');
const { listFilterSql } = require('./request-filters');

/** 規格 §4：source 只有這三種來源。 */
const SOURCES = new Set(['proxy', 'playwright', 'replay']);
const DEFAULT_BODY_CAP = 256 * 1024;

/** @param {unknown} headers @param {string} wanted @returns {string|null} */
function headerValue(headers, wanted) {
  if (!headers || typeof headers !== 'object') return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value.join('; ') : String(value);
  }
  return null;
}

/**
 * 決定一個 body 要不要存、怎麼遮、怎麼截（規格 §5.1 + §5.3）。
 *
 * **順序很重要：先遮蔽再截斷。** 反過來做的話，一個超過上限的 JSON 回應
 * 在截斷後就不再是合法 JSON、遮蔽會整個跳過，尾端的 access_token 就明文落地了。
 * test/store-requests.test.js 的「遮蔽先於截斷」就是在釘住這個順序。
 *
 * @param {Buffer|string|null|undefined} raw
 * @param {string|null} contentType
 * @param {{ bodyCap: number, captureSecrets: boolean }} options
 * @returns {{ text: string|null, truncated: 0|1 }}
 */
function prepareBody(raw, contentType, options) {
  if (raw === null || raw === undefined) return { text: null, truncated: 0 };
  if (!isTextCapturable(contentType)) return { text: null, truncated: 0 };

  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const full = buffer.toString('utf8');
  const redacted = redactBodyText(full, { captureSecrets: options.captureSecrets }).text;

  const outBuffer = Buffer.from(redacted, 'utf8');
  if (outBuffer.length <= options.bodyCap) return { text: redacted, truncated: 0 };
  return { text: outBuffer.subarray(0, options.bodyCap).toString('utf8'), truncated: 1 };
}

/** @param {object} record */
function assertRecord(record) {
  for (const field of ['method', 'url', 'host', 'path']) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`requests.${field} 為必填`);
    }
  }
  if (!SOURCES.has(record.source)) {
    throw new Error(`requests.source 只接受 ${[...SOURCES].join(' / ')}，收到 ${record.source}`);
  }
  if (typeof record.id !== 'string' || record.id === '') {
    throw new Error('requests.id 為必填');
  }
}

/**
 * 寫入一筆流量紀錄。遮蔽、body 上限、auth_shape 都在這裡一次做掉 ——
 * 呼叫端（proxy / inspector / replay）不需要、也不應該各自實作一份遮蔽。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} record 見 test/helpers/temp-db.js 的 requestFixture
 * @param {{ captureSecrets?: boolean, bodyCap?: number }} [options]
 * @returns {string} 寫入的 id
 */
function insertRequest(db, record, options = {}) {
  assertRecord(record);

  const captureSecrets = options.captureSecrets === true;
  const bodyCap = Number.isFinite(options.bodyCap) ? options.bodyCap : DEFAULT_BODY_CAP;
  const bodyOptions = { bodyCap, captureSecrets };

  // auth_shape 必須在遮蔽之前算，因為它要看原始 header 才判斷得出形狀。
  const authShape = detectAuthShape({ headers: record.reqHeaders || {}, url: record.url });

  const redactedReqHeaders = redactHeaders(record.reqHeaders, { captureSecrets });
  const redactedResHeaders = redactHeaders(record.resHeaders, { captureSecrets });

  const resContentType =
    normalizeContentType(record.contentType) ||
    normalizeContentType(headerValue(record.resHeaders, 'content-type'));
  const reqContentType = normalizeContentType(headerValue(record.reqHeaders, 'content-type'));

  const reqBody = prepareBody(record.reqBody, reqContentType, bodyOptions);
  const resBody = prepareBody(record.resBody, resContentType, bodyOptions);

  db.prepare(
    `INSERT INTO requests (
       id, session_id, site_id, ts, source, method, url, host, path,
       status, duration_ms, content_type, res_bytes,
       req_headers, res_headers, req_body, res_body, body_truncated,
       auth_shape, corr_id, replay_of
     ) VALUES (
       @id, @sessionId, @siteId, @ts, @source, @method, @url, @host, @path,
       @status, @durationMs, @contentType, @resBytes,
       @reqHeaders, @resHeaders, @reqBody, @resBody, @bodyTruncated,
       @authShape, @corrId, @replayOf
     )`,
  ).run({
    id: record.id,
    sessionId: record.sessionId ?? null,
    siteId: record.siteId ?? null,
    ts: isoNow(record.ts),
    source: record.source,
    method: record.method,
    url: record.url,
    host: record.host,
    path: record.path,
    status: record.status ?? null,
    durationMs: record.durationMs ?? null,
    contentType: resContentType,
    resBytes: record.resBytes ?? null,
    reqHeaders: JSON.stringify(redactedReqHeaders),
    resHeaders: JSON.stringify(redactedResHeaders),
    reqBody: reqBody.text,
    resBody: resBody.text,
    bodyTruncated: reqBody.truncated || resBody.truncated ? 1 : 0,
    authShape,
    corrId: record.corrId ?? null,
    replayOf: record.replayOf ?? null,
  });

  indexBody(db, record.id, resBody.text);
  return record.id;
}

/** @param {object} row @returns {object} */
function parseRow(row) {
  if (!row) return null;
  const safeParse = (text) => {
    if (typeof text !== 'string') return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  return {
    id: row.id,
    sessionId: row.session_id,
    siteId: row.site_id,
    ts: row.ts,
    source: row.source,
    method: row.method,
    url: row.url,
    host: row.host,
    path: row.path,
    status: row.status,
    durationMs: row.duration_ms,
    contentType: row.content_type,
    resBytes: row.res_bytes,
    reqHeaders: safeParse(row.req_headers),
    resHeaders: safeParse(row.res_headers),
    reqBody: row.req_body,
    resBody: row.res_body,
    bodyTruncated: row.body_truncated,
    authShape: row.auth_shape,
    corrId: row.corr_id,
    replayOf: row.replay_of,
  };
}

/** 單筆詳情（含 body）。 @returns {object|null} */
function getRequest(db, id) {
  if (typeof id !== 'string') return null;
  return parseRow(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));
}

/**
 * 列表查詢。刻意**不**回傳 body —— 面板表格不需要，撈出來只是浪費記憶體。
 * @param {import('better-sqlite3').Database} db
 * @param {object} filters 見 src/store/request-filters.js
 * @returns {{ rows: object[], total: number, limit: number, offset: number }}
 */
function listRequests(db, filters = {}) {
  const { where, params, limit, offset } = listFilterSql(filters);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM requests ${where}`).get(params).c;
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM requests ${where} ORDER BY ts DESC, id DESC LIMIT @_limit OFFSET @_offset`,
    )
    .all({ ...params, _limit: limit, _offset: offset });

  return { rows, total, limit, offset };
}

module.exports = {
  insertRequest,
  getRequest,
  listRequests,
  prepareBody,
  parseRow,
  SOURCES,
  DEFAULT_BODY_CAP,
};
