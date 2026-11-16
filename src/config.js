'use strict';

const path = require('node:path');

/**
 * 全部設定集中在這裡，從 env 讀一次就凍結。
 *
 * 兩個危險開關（captureSecrets / allowPrivate）刻意只認字串 `'1'`：
 * `'true'`、`'yes'`、`'0'` 一律視為關閉。理由是「不小心打開」比「不小心沒打開」危險得多 ——
 * 前者會讓憑證明文落地到 SQLite，後者只是功能少一點。
 */

const PROJECT_ROOT = path.resolve(__dirname, '..');

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** 只有字串 '1' 代表開啟。 @param {unknown} value @returns {boolean} */
function isEnabled(value) {
  return value === '1';
}

/** @param {unknown} value @returns {string|null} */
function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<object>}
 */
function loadConfig(env = process.env) {
  return Object.freeze({
    port: positiveInt(env.PORT, 30700),
    host: nonEmpty(env.HOST) || '127.0.0.1',
    dbPath:
      nonEmpty(env.LOCALDEVTOOL_DB) || path.join(PROJECT_ROOT, 'data', 'localdevtool.db'),
    reportsDir: nonEmpty(env.LOCALDEVTOOL_REPORTS_DIR) || path.join(PROJECT_ROOT, 'reports'),

    /** 危險：開啟後憑證會明文存進 SQLite（規格 §5.1） */
    captureSecrets: isEnabled(env.LOCALDEVTOOL_CAPTURE_SECRETS),
    /** 危險：開啟後可代理私網位址（規格 §6.2） */
    allowPrivate: isEnabled(env.LOCALDEVTOOL_ALLOW_PRIVATE),

    bodyCap: positiveInt(env.LOCALDEVTOOL_BODY_CAP, 256 * 1024),
    retentionDays: positiveInt(env.LOCALDEVTOOL_RETENTION_DAYS, 7),
    retentionMax: positiveInt(env.LOCALDEVTOOL_RETENTION_MAX, 50000),

    adminToken: nonEmpty(env.LOCALDEVTOOL_ADMIN_TOKEN),

    upstreamTimeoutMs: positiveInt(env.LOCALDEVTOOL_UPSTREAM_TIMEOUT_MS, 30000),
    inspectWaitMs: positiveInt(env.LOCALDEVTOOL_INSPECT_WAIT_MS, 8000),
    maxInspectJobs: positiveInt(env.LOCALDEVTOOL_MAX_INSPECT_JOBS, 2),

    eventPayloadCap: positiveInt(env.LOCALDEVTOOL_EVENT_PAYLOAD_CAP, 64 * 1024),
    eventRateLimitPerMinute: positiveInt(env.LOCALDEVTOOL_EVENT_RATE_LIMIT, 600),
  });
}

module.exports = { loadConfig, PROJECT_ROOT };
