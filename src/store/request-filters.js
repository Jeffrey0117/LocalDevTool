'use strict';

/**
 * 把面板的篩選條件翻成 SQL（規格 §9）。
 * 抽成獨立模組是為了讓 requests.js 不被字串拼接淹掉，也方便單獨測。
 *
 * 全部走具名參數，沒有任何字串插值進 SQL —— 使用者輸入不會變成語法。
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const STATUS_GROUPS = {
  '1xx': [100, 200],
  '2xx': [200, 300],
  '3xx': [300, 400],
  '4xx': [400, 500],
  '5xx': [500, 600],
};

/** @param {unknown} value @param {number} fallback @returns {number} */
function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/**
 * @param {object} filters
 * @returns {{ where: string, params: object, limit: number, offset: number }}
 */
function listFilterSql(filters = {}) {
  const clauses = [];
  const params = {};

  const simple = [
    ['method', 'method = @method', (v) => String(v).toUpperCase()],
    ['siteId', 'site_id = @siteId', String],
    ['sessionId', 'session_id = @sessionId', String],
    ['corrId', 'corr_id = @corrId', String],
    ['source', 'source = @source', String],
    ['host', 'host = @host', String],
    ['replayOf', 'replay_of = @replayOf', String],
  ];
  for (const [key, clause, cast] of simple) {
    if (filters[key] === undefined || filters[key] === null || filters[key] === '') continue;
    clauses.push(clause);
    params[key] = cast(filters[key]);
  }

  if (filters.status !== undefined && filters.status !== null && filters.status !== '') {
    const group = STATUS_GROUPS[String(filters.status).toLowerCase()];
    if (group) {
      clauses.push('status >= @statusMin AND status < @statusMax');
      params.statusMin = group[0];
      params.statusMax = group[1];
    } else if (Number.isFinite(Number(filters.status))) {
      clauses.push('status = @status');
      params.status = Number(filters.status);
    }
  }

  if (typeof filters.urlContains === 'string' && filters.urlContains !== '') {
    clauses.push("url LIKE @urlContains ESCAPE '\\'");
    params.urlContains = `%${filters.urlContains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }

  if (typeof filters.contentType === 'string' && filters.contentType !== '') {
    clauses.push("content_type LIKE @contentType ESCAPE '\\'");
    params.contentType = `%${filters.contentType.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }

  if (typeof filters.since === 'string' && filters.since !== '') {
    clauses.push('ts >= @since');
    params.since = filters.since;
  }
  if (typeof filters.until === 'string' && filters.until !== '') {
    clauses.push('ts < @until');
    params.until = filters.until;
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    limit: clampLimit(filters.limit, DEFAULT_LIMIT),
    offset: Math.max(0, Number(filters.offset) || 0),
  };
}

module.exports = { listFilterSql, STATUS_GROUPS, DEFAULT_LIMIT, MAX_LIMIT };
