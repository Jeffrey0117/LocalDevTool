'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { migrate } = require('./schema');

/**
 * 開啟（必要時建立）資料庫並跑完 migration。
 *
 * @param {string} dbPath 檔案路徑，或 ':memory:'（測試用）
 * @returns {import('better-sqlite3').Database}
 */
function openDb(dbPath) {
  const inMemory = dbPath === ':memory:';

  if (!inMemory) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new Error(
      `無法開啟資料庫 ${dbPath}：${error.message}\n` +
        '若錯誤提到 bindings，表示 better-sqlite3 的原生模組沒裝好；' +
        '請看 README 的「原生模組」段落。',
    );
  }

  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

module.exports = { openDb };
