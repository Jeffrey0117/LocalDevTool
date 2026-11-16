'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');

test('預設值符合規格 §2 / §4 / §5', () => {
  const config = loadConfig({});
  assert.equal(config.port, 30700);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.bodyCap, 256 * 1024);
  assert.equal(config.captureSecrets, false, '預設必須遮蔽');
  assert.equal(config.allowPrivate, false, '預設必須擋私網');
  assert.equal(config.retentionDays, 7);
  assert.equal(config.retentionMax, 50000);
  assert.equal(config.inspectWaitMs, 8000);
  assert.equal(config.maxInspectJobs, 2);
  assert.equal(config.eventPayloadCap, 64 * 1024);
});

test('沒有 hardcoded 預設 admin token', () => {
  assert.equal(loadConfig({}).adminToken, null);
});

test('PORT / HOST 可覆蓋', () => {
  const config = loadConfig({ PORT: '41000', HOST: '0.0.0.0' });
  assert.equal(config.port, 41000);
  assert.equal(config.host, '0.0.0.0');
});

test('危險開關只認字串 "1"，其他值都視為關閉', () => {
  assert.equal(loadConfig({ LOCALDEVTOOL_CAPTURE_SECRETS: '1' }).captureSecrets, true);
  for (const value of ['0', 'true', 'yes', '', 'TRUE', '2']) {
    assert.equal(
      loadConfig({ LOCALDEVTOOL_CAPTURE_SECRETS: value }).captureSecrets,
      false,
      `${JSON.stringify(value)} 不該被當成開啟`,
    );
  }
  assert.equal(loadConfig({ LOCALDEVTOOL_ALLOW_PRIVATE: '1' }).allowPrivate, true);
  assert.equal(loadConfig({ LOCALDEVTOOL_ALLOW_PRIVATE: 'true' }).allowPrivate, false);
});

test('數值 env 可覆蓋，無效值退回預設', () => {
  assert.equal(loadConfig({ LOCALDEVTOOL_BODY_CAP: '1024' }).bodyCap, 1024);
  assert.equal(loadConfig({ LOCALDEVTOOL_BODY_CAP: 'abc' }).bodyCap, 256 * 1024);
  assert.equal(loadConfig({ LOCALDEVTOOL_BODY_CAP: '-5' }).bodyCap, 256 * 1024);
  assert.equal(loadConfig({ LOCALDEVTOOL_RETENTION_DAYS: '30' }).retentionDays, 30);
  assert.equal(loadConfig({ LOCALDEVTOOL_RETENTION_MAX: '100' }).retentionMax, 100);
});

test('adminToken 從 env 讀，空白視為未設定', () => {
  assert.equal(loadConfig({ LOCALDEVTOOL_ADMIN_TOKEN: 'abc123' }).adminToken, 'abc123');
  assert.equal(loadConfig({ LOCALDEVTOOL_ADMIN_TOKEN: '   ' }).adminToken, null);
});

test('config 是凍結的，不能被執行期偷改', () => {
  const config = loadConfig({});
  assert.throws(() => {
    'use strict';
    config.captureSecrets = true;
  }, TypeError);
});

test('dbPath 預設在 data/localdevtool.db', () => {
  assert.match(loadConfig({}).dbPath.replace(/\\/g, '/'), /data\/localdevtool\.db$/);
});
