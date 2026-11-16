'use strict';

const { ensureFts } = require('./search');

/**
 * 資料模型（規格 §4）。單向 schema 版本，用 `PRAGMA user_version` 當版本戳。
 *
 * 刻意說明：`requests.site_id` / `requests.session_id` **沒有**外鍵約束。
 * 流量擷取是代理回應送出之後才做的事，若因為 site 被刪掉就讓寫入拋錯，
 * 代理本身會變得脆弱 —— 紀錄留著成為孤兒比弄壞代理好。
 */

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  site_id    TEXT,
  label      TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id             TEXT PRIMARY KEY,
  session_id     TEXT,
  site_id        TEXT,
  ts             TEXT NOT NULL,
  source         TEXT NOT NULL,
  method         TEXT NOT NULL,
  url            TEXT NOT NULL,
  host           TEXT NOT NULL,
  path           TEXT NOT NULL,
  status         INTEGER,
  duration_ms    INTEGER,
  content_type   TEXT,
  res_bytes      INTEGER,
  req_headers    TEXT,
  res_headers    TEXT,
  req_body       TEXT,
  res_body       TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  auth_shape     TEXT,
  corr_id        TEXT,
  replay_of      TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_ts         ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_session_ts ON requests(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_requests_host_path  ON requests(host, path);
CREATE INDEX IF NOT EXISTS idx_requests_corr       ON requests(corr_id);
CREATE INDEX IF NOT EXISTS idx_findings_session    ON findings(session_id);
`;

/**
 * 建表 / 建索引 / 建 FTS。可重複執行（全部 IF NOT EXISTS）。
 * @param {import('better-sqlite3').Database} db
 */
function migrate(db) {
  db.exec(DDL);
  ensureFts(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

module.exports = { migrate, SCHEMA_VERSION, DDL };
