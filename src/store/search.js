'use strict';

/**
 * res_body 的全文搜尋（規格 §4）。
 *
 * 優先用 SQLite 內建的 FTS5；建不起來就退回 `LIKE` 並在 log 說一聲。
 * FTS 查詢一律包成「片語」，因為使用者輸入的是 URL / ID 片段而不是 FTS 語法；
 * 直接把輸入丟進 MATCH 會讓 `AND` `*` `(` 這些字元變成查詢語法甚至語法錯誤。
 */

/** @type {WeakMap<object, boolean>} 每個 db 連線的 FTS 可用性，只偵測一次。 */
const ftsState = new WeakMap();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * 嘗試建立 FTS5 虛擬表。
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} FTS 是否可用
 */
function ensureFts(db) {
  if (ftsState.has(db)) return ftsState.get(db);
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(req_id UNINDEXED, body)');
    ftsState.set(db, true);
  } catch (error) {
    console.warn(
      `[LocalDevTool] FTS5 無法建立，body 搜尋退回 LIKE（較慢但功能相同）：${error.message}`,
    );
    ftsState.set(db, false);
  }
  return ftsState.get(db);
}

/** @param {import('better-sqlite3').Database} db @returns {boolean} */
function isFtsAvailable(db) {
  return ensureFts(db);
}

/**
 * 把一筆 body 寫進全文索引。body 為 null（binary / 未擷取）時什麼都不做。
 * @param {import('better-sqlite3').Database} db
 * @param {string} reqId
 * @param {string|null} body
 */
function indexBody(db, reqId, body) {
  if (typeof body !== 'string' || body === '') return;
  if (!ensureFts(db)) return;
  try {
    db.prepare('INSERT INTO requests_fts (req_id, body) VALUES (?, ?)').run(reqId, body);
  } catch (error) {
    console.warn(`[LocalDevTool] 寫入全文索引失敗（搜尋會漏掉這筆）：${error.message}`);
  }
}

/**
 * 從全文索引移除紀錄，避免保留策略清掉 requests 後留下孤兒索引。
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} reqIds
 */
function removeFromIndex(db, reqIds) {
  if (reqIds.length === 0 || !ensureFts(db)) return;
  const statement = db.prepare('DELETE FROM requests_fts WHERE req_id = ?');
  const run = db.transaction((ids) => {
    for (const id of ids) statement.run(id);
  });
  try {
    run(reqIds);
  } catch (error) {
    console.warn(`[LocalDevTool] 清理全文索引失敗：${error.message}`);
  }
}

/** FTS5 片語查詢：整串包在雙引號裡，內部的雙引號加倍轉義。 */
function toPhraseQuery(needle) {
  return `"${needle.replace(/"/g, '""')}"`;
}

/** LIKE 查詢：% _ \ 都要轉義，否則使用者輸入的 % 會變成萬用字元。 */
function toLikePattern(needle) {
  const escaped = needle.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

const SELECT_COLUMNS = `
  id, session_id AS sessionId, site_id AS siteId, ts, source, method, url, host, path,
  status, duration_ms AS durationMs, content_type AS contentType, res_bytes AS resBytes,
  auth_shape AS authShape, corr_id AS corrId, replay_of AS replayOf,
  body_truncated AS bodyTruncated
`;

/** @param {import('better-sqlite3').Database} db */
function searchWithFts(db, needle, limit) {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM requests
       WHERE id IN (SELECT req_id FROM requests_fts WHERE requests_fts MATCH ?)
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(toPhraseQuery(needle), limit);
}

/** @param {import('better-sqlite3').Database} db */
function searchWithLike(db, needle, limit) {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM requests
       WHERE res_body LIKE ? ESCAPE '\\'
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(toLikePattern(needle), limit);
}

/**
 * 在擷取到的 res_body 裡搜尋一段字串。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} needle 使用者輸入的原始字串（URL 片段、ID…），不是 FTS 語法
 * @param {{ limit?: number, forceLike?: boolean }} [options]
 * @returns {object[]}
 */
function searchBodies(db, needle, options = {}) {
  if (typeof needle !== 'string' || needle.trim() === '') return [];

  const limit = Math.min(Math.max(1, options.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const trimmed = needle.trim();

  if (!options.forceLike && ensureFts(db)) {
    try {
      return searchWithFts(db, trimmed, limit);
    } catch (error) {
      // 使用者輸入的片段可能 tokenize 後是空的（例如只有標點），FTS 會語法錯誤。
      console.warn(`[LocalDevTool] FTS 查詢失敗，這次退回 LIKE：${error.message}`);
    }
  }
  return searchWithLike(db, trimmed, limit);
}

module.exports = {
  ensureFts,
  isFtsAvailable,
  indexBody,
  removeFromIndex,
  searchBodies,
  SELECT_COLUMNS,
};
