'use strict';

const { isoNow } = require('../util/ids');

/** 保留路徑不能被當成 site slug，否則代理會把後台吃掉。 */
const RESERVED_SLUGS = ['admin', 'p', '__ldt'];
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** @param {unknown} id @returns {string} */
function assertSlug(id) {
  // 保留字先判，否則 `__ldt` 會先撞格式檢查（它本來就不符 slug 格式），
  // 錯誤訊息會變成「格式錯誤」而不是「這是保留路徑」，使用者看不懂為什麼。
  if (typeof id === 'string' && RESERVED_SLUGS.includes(id)) {
    throw new Error(`「${id}」是保留路徑，不能當作 site slug`);
  }
  if (typeof id !== 'string' || !SLUG_PATTERN.test(id)) {
    throw new Error('slug 格式錯誤：只接受小寫英數與連字號，長度 1–40');
  }
  return id;
}

/** @param {unknown} name @returns {string} */
function assertName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('name 不可為空');
  }
  return name.trim();
}

/**
 * 只留 origin，丟掉 path/query —— 代理時 path 來自使用者的請求，不是設定。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('target_origin 不可為空，必須是 http(s) origin');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`target_origin 不是合法的 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`target_origin 只接受 http(s)，收到 ${parsed.protocol}`);
  }
  return parsed.origin;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, name: string, targetOrigin: string, enabled?: number }} input
 * @returns {object} 建好的 row
 */
function createSite(db, input) {
  const id = assertSlug(input.id);
  const name = assertName(input.name);
  const targetOrigin = normalizeOrigin(input.targetOrigin);
  const now = isoNow();
  const enabled = input.enabled === 0 ? 0 : 1;

  try {
    db.prepare(
      `INSERT INTO sites (id, name, target_origin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, targetOrigin, enabled, now, now);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      throw new Error(`site「${id}」已存在`);
    }
    throw error;
  }
  return getSite(db, id);
}

/** @param {import('better-sqlite3').Database} db @param {string} id */
function getSite(db, id) {
  if (typeof id !== 'string') return null;
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id) || null;
}

/** @param {import('better-sqlite3').Database} db */
function listSites(db) {
  return db.prepare('SELECT * FROM sites ORDER BY created_at, id').all();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{ name?: string, targetOrigin?: string, enabled?: number }} patch
 * @returns {object|null} 更新後的 row，site 不存在回 null
 */
function updateSite(db, id, patch) {
  const existing = getSite(db, id);
  if (existing === null) return null;

  const next = {
    name: patch.name === undefined ? existing.name : assertName(patch.name),
    target_origin:
      patch.targetOrigin === undefined ? existing.target_origin : normalizeOrigin(patch.targetOrigin),
    enabled: patch.enabled === undefined ? existing.enabled : Number(patch.enabled) ? 1 : 0,
  };

  db.prepare(
    'UPDATE sites SET name = ?, target_origin = ?, enabled = ?, updated_at = ? WHERE id = ?',
  ).run(next.name, next.target_origin, next.enabled, isoNow(), id);

  return getSite(db, id);
}

/** @returns {boolean} 是否真的刪到東西 */
function deleteSite(db, id) {
  return db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  createSite,
  getSite,
  listSites,
  updateSite,
  deleteSite,
  normalizeOrigin,
  RESERVED_SLUGS,
  SLUG_PATTERN,
};
