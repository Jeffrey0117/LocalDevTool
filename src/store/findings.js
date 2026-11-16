'use strict';

const { newId, isoNow } = require('../util/ids');

/**
 * Findings 是「觀察到的結論」，由 inspector / trace 產生（規格 §4）。
 * detail 存 JSON 字串；讀出來時解析回物件。
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ sessionId?: string|null, kind: string, label: string, detail?: unknown }} input
 * @returns {object}
 */
function createFinding(db, input) {
  if (typeof input.kind !== 'string' || input.kind === '') throw new Error('finding.kind 為必填');
  if (typeof input.label !== 'string' || input.label === '') throw new Error('finding.label 為必填');

  const id = newId('fnd');
  db.prepare(
    'INSERT INTO findings (id, session_id, kind, label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.sessionId ?? null,
    input.kind,
    input.label,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    isoNow(),
  );
  return getFinding(db, id);
}

/** @param {object|null} row */
function parseFinding(row) {
  if (!row) return null;
  let detail = null;
  if (typeof row.detail === 'string') {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return { ...row, detail };
}

/** @returns {object|null} */
function getFinding(db, id) {
  return parseFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(id) || null);
}

/** @returns {object[]} */
function listFindings(db, sessionId = null, limit = 200) {
  const capped = Math.min(Math.max(1, Number(limit) || 200), 500);
  const rows =
    sessionId === null
      ? db.prepare('SELECT * FROM findings ORDER BY created_at DESC LIMIT ?').all(capped)
      : db
          .prepare('SELECT * FROM findings WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(sessionId, capped);
  return rows.map(parseFinding);
}

module.exports = { createFinding, getFinding, listFindings };
