'use strict';

const { searchBodies } = require('../store/search');
const { listRequests } = require('../store/requests');
const { detectAuthShape } = require('../redact/auth-shape');

/**
 * 右鍵挖掘的伺服器端關聯（規格 §7.2）。
 *
 * 回答的是：「我看到這個影片 / 圖片 / 價格，是哪支 API 給出這個網址的？」
 *
 * 最重要的設計約束：**不准把猜測當事實。**
 *  - `confirmed` = 真的在某筆 res_body 裡找到這個網址（有證據）
 *  - `likely`    = 只是時間相近（沒有證據，只是巧合的可能性）
 * 兩者嚴格分開，而且每一項都附上 `evidence` 說明憑什麼這樣說。
 */

/** 時間相近的判定窗。超過這個距離就連「疑似」都不算。 */
const PROXIMITY_MS = 3000;
/** 片段太短會命中一堆無關的東西，反而害使用者誤判。 */
const MIN_FRAGMENT_LENGTH = 8;

/**
 * 由一個 URL 推出可以拿去搜尋的片段，由精確到寬鬆。
 *
 * 為什麼需要「寬鬆」那幾層：API 回應裡常常只有相對路徑或 ID，
 * 不會原封不動地寫出瀏覽器最後請求的完整 URL（query 上的簽章是 CDN 加的）。
 *
 * @param {unknown} url
 * @returns {string[]}
 */
function deriveNeedles(url) {
  if (typeof url !== 'string' || url.trim() === '') return [];
  const trimmed = url.trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [trimmed];
  }

  const basename = parsed.pathname.split('/').filter(Boolean).pop() || '';
  const withoutExtension = basename.replace(/\.[a-z0-9]{1,8}$/i, '');

  const candidates = [trimmed, parsed.pathname, basename];
  // 去掉副檔名之後常常就是「資源 ID」，但太短的（master、index）會造成大量假命中。
  if (withoutExtension.length >= MIN_FRAGMENT_LENGTH) candidates.push(withoutExtension);

  return [...new Set(candidates.filter((value) => typeof value === 'string' && value !== ''))];
}

/** @param {object} row @param {string} needle @returns {object} */
function asConfirmed(row, needle) {
  return { ...row, confidence: 'confirmed', evidence: `res_body 裡找到「${needle}」` };
}

/** @param {object} row @returns {object} */
function asLikely(row) {
  return {
    ...row,
    confidence: 'likely',
    evidence: `時間相近（${PROXIMITY_MS}ms 內）—— 這不是證據，只是順序上有可能`,
  };
}

/** 找出「正在被追查的那個請求」本身，它不是給出網址的人。 */
function findAnchorRow(db, url, siteId) {
  if (typeof url !== 'string' || url === '') return null;
  const filters = siteId ? { urlContains: url, siteId } : { urlContains: url };
  const rows = listRequests(db, { ...filters, limit: 50 }).rows;
  return rows.find((row) => row.url === url) || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ url?: string, corrId?: string, sessionId?: string, needle?: string, siteId?: string }} input
 * @returns {{
 *   needle: string|null, needlesTried: string[],
 *   confirmed: object[], likely: object[], timeline: object[],
 *   auth: { signedUrl: boolean, shapes: string[] },
 *   note: string
 * }}
 */
function trace(db, input = {}) {
  const siteId = typeof input.siteId === 'string' && input.siteId !== '' ? input.siteId : null;
  const inSite = (row) => siteId === null || row.siteId === siteId;

  const needles =
    typeof input.needle === 'string' && input.needle !== ''
      ? [input.needle]
      : deriveNeedles(input.url);

  const anchor = findAnchorRow(db, input.url, siteId);

  // 1. 誰給的 —— 由精確到寬鬆依序試，第一個有命中的就停。
  const needlesTried = [];
  let confirmed = [];
  let matchedNeedle = null;

  for (const needle of needles) {
    needlesTried.push(needle);
    const hits = searchBodies(db, needle, { limit: 200 })
      .filter(inSite)
      // 被追查的那個請求自己不算「給出網址的人」。
      .filter((row) => !(anchor && row.id === anchor.id));

    if (hits.length > 0) {
      confirmed = hits.map((row) => asConfirmed(row, needle));
      matchedNeedle = needle;
      break;
    }
  }

  // 2. 時間相近的 —— 以被追查的請求為錨，沒有錨就用第一個已證實的。
  const confirmedIds = new Set(confirmed.map((row) => row.id));
  const anchorTs = anchor ? anchor.ts : confirmed.length > 0 ? confirmed[0].ts : null;

  let likely = [];
  let timeline = [];

  if (typeof input.corrId === 'string' && input.corrId !== '') {
    // corr_id 是客戶端給的明確關聯，比時間猜測可靠得多。
    timeline = listRequests(db, { corrId: input.corrId, limit: 200 }).rows.filter(inSite);
  } else if (anchorTs !== null) {
    const anchorTime = Date.parse(anchorTs);
    const window = {
      since: new Date(anchorTime - PROXIMITY_MS).toISOString(),
      until: new Date(anchorTime + PROXIMITY_MS + 1).toISOString(),
      limit: 200,
    };
    if (siteId !== null) window.siteId = siteId;

    const nearby = listRequests(db, window).rows.filter(inSite);
    timeline = [...nearby].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    likely = nearby
      .filter((row) => !confirmedIds.has(row.id))
      .filter((row) => !(anchor && row.id === anchor.id))
      .map(asLikely);
  }

  // 3. 怎麼授權的
  const mediaShape = detectAuthShape({ headers: {}, url: input.url || '' });
  const shapes = [
    ...new Set(
      [mediaShape, ...confirmed.map((row) => row.authShape)].filter(
        (shape) => typeof shape === 'string' && shape !== '',
      ),
    ),
  ];

  return {
    needle: matchedNeedle,
    needlesTried,
    confirmed,
    likely,
    timeline,
    auth: {
      signedUrl: mediaShape !== null && mediaShape.includes('signed-url'),
      shapes,
    },
    note:
      'confirmed 表示在擷取到的回應內容裡真的找到這個網址；' +
      'likely 只代表時間相近，不構成證據。',
  };
}

module.exports = { trace, deriveNeedles, PROXIMITY_MS };
