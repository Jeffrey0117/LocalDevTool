'use strict';

const { removeFromIndex } = require('./search');

/**
 * 保留策略（規格 §4）：預設 7 天 / 50000 筆，取先到者。
 * 啟動時與每小時各掃一次。
 */

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_MAX = 50000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** @param {import('better-sqlite3').Database} db @param {string[]} ids */
function deleteIds(db, ids) {
  if (ids.length === 0) return;
  const statement = db.prepare('DELETE FROM requests WHERE id = ?');
  const run = db.transaction((list) => {
    for (const id of list) statement.run(id);
  });
  run(ids);
  removeFromIndex(db, ids);
}

/**
 * 清掉過期與超量的紀錄。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ retentionDays?: number, retentionMax?: number }} [options]
 * @returns {{ deletedByAge: number, deletedByCount: number }}
 */
function sweep(db, options = {}) {
  const days = Number.isFinite(options.retentionDays)
    ? options.retentionDays
    : DEFAULT_RETENTION_DAYS;
  const max = Number.isFinite(options.retentionMax) ? options.retentionMax : DEFAULT_RETENTION_MAX;

  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const expired = db
    .prepare('SELECT id FROM requests WHERE ts < ?')
    .all(cutoff)
    .map((row) => row.id);
  deleteIds(db, expired);

  // LIMIT -1 OFFSET n = 「跳過最新的 n 筆，剩下的全要」
  const excess = db
    .prepare('SELECT id FROM requests ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?')
    .all(Math.max(0, max))
    .map((row) => row.id);
  deleteIds(db, excess);

  return { deletedByAge: expired.length, deletedByCount: excess.length };
}

/**
 * 啟動定時清理。回傳停止函式，讓測試與關機流程能收乾淨。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {() => void}
 */
function startRetentionLoop(db, config) {
  const run = () => {
    try {
      const result = sweep(db, config);
      if (result.deletedByAge + result.deletedByCount > 0) {
        console.log(
          `[LocalDevTool] 保留策略清理：過期 ${result.deletedByAge} 筆、超量 ${result.deletedByCount} 筆`,
        );
      }
    } catch (error) {
      console.error('[LocalDevTool] 保留策略清理失敗:', error.message);
    }
  };

  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  sweep,
  startRetentionLoop,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_MAX,
  SWEEP_INTERVAL_MS,
};
