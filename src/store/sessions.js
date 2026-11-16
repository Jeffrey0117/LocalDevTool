'use strict';

const { newId, isoNow } = require('../util/ids');

/**
 * Session 是「一段觀測」的容器，讓使用者能把某次操作的流量框起來比較。
 * 規格 §4 的 sessions 表。
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ siteId?: string|null, label?: string|null }} [input]
 * @returns {object}
 */
function createSession(db, input = {}) {
  const id = newId('ses');
  db.prepare(
    'INSERT INTO sessions (id, site_id, label, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)',
  ).run(id, input.siteId ?? null, input.label ?? null, isoNow());
  return getSession(db, id);
}

/** @returns {object|null} */
function getSession(db, id) {
  if (typeof id !== 'string') return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

/** @returns {object[]} */
function listSessions(db, limit = 100) {
  return db
    .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(Math.max(1, Number(limit) || 100), 500));
}

/** @returns {object|null} */
function endSession(db, id) {
  const existing = getSession(db, id);
  if (existing === null) return null;
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(isoNow(), id);
  return getSession(db, id);
}

module.exports = { createSession, getSession, listSessions, endSession };
