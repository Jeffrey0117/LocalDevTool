'use strict';

const { getSite } = require('../store/sites');
const { SITE_COOKIE } = require('./cookies');
const { SLUG_PATTERN, RESERVED_SLUGS } = require('../store/sites');

/**
 * 根路徑 fallback 的 siteId 解析（規格 §6 / LocalMonkey §4.1）。
 *
 * 順序：cookie > Referer > 放棄。
 * 解析不到時回 null，呼叫端回 404 加說明 —— 刻意不回 502，
 * 因為 502 會讓人以為代理壞了，實際上只是不知道這個請求屬於哪個 site。
 *
 * 已知限制：同一個瀏覽器同時開兩個代理網站會互搶 cookie（README 有寫）。
 */

/** @param {string} raw cookie header @returns {Record<string,string>} */
function parseCookieHeader(raw) {
  if (typeof raw !== 'string') return {};
  const result = {};
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (name === '') continue;
    result[name] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return result;
}

/** siteId 可能來自 cookie / Referer（都是使用者可控），要先確認格式。 */
function isValidSlug(value) {
  return typeof value === 'string' && SLUG_PATTERN.test(value) && !RESERVED_SLUGS.includes(value);
}

/** @param {string} referer @returns {string|null} */
function siteIdFromReferer(referer) {
  if (typeof referer !== 'string') return null;
  const match = referer.match(/\/p\/([a-z0-9-]{1,40})(?:\/|$|\?)/);
  return match ? match[1] : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ cookie?: string, referer?: string }} headers
 * @returns {{ site: object|null, via: 'cookie'|'referer'|null }}
 */
function resolveSiteFromHeaders(db, headers) {
  const candidates = [
    [parseCookieHeader(headers.cookie)[SITE_COOKIE], 'cookie'],
    [siteIdFromReferer(headers.referer), 'referer'],
  ];

  for (const [candidate, via] of candidates) {
    if (!isValidSlug(candidate)) continue;
    const site = getSite(db, candidate);
    if (site && site.enabled === 1) return { site, via };
  }
  return { site: null, via: null };
}

module.exports = { resolveSiteFromHeaders, parseCookieHeader, siteIdFromReferer, isValidSlug };
