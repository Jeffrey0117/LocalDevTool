'use strict';

const { openDb } = require('../../src/store/db');
const { createSite } = require('../../src/store/sites');

/** 每個測試一個全新的記憶體資料庫，彼此不互相汙染。 */
function freshDb() {
  return openDb(':memory:');
}

/** 大部分 requests 測試都需要一個 site 存在（外鍵）。 */
function freshDbWithSite(siteId = 'demo') {
  const db = freshDb();
  createSite(db, { id: siteId, name: 'Demo', targetOrigin: 'https://example.com' });
  return db;
}

/** 填一筆最小可用的 request 紀錄，測試只覆寫自己關心的欄位。 */
function requestFixture(overrides = {}) {
  return {
    id: 'req-1',
    sessionId: null,
    siteId: 'demo',
    ts: '2026-11-16T10:00:00.000Z',
    source: 'proxy',
    method: 'GET',
    url: 'https://example.com/api/items',
    host: 'example.com',
    path: '/api/items',
    status: 200,
    durationMs: 42,
    resBytes: 11,
    reqHeaders: { 'user-agent': 'test' },
    resHeaders: { 'content-type': 'application/json' },
    reqBody: null,
    resBody: '{"ok":true}',
    corrId: null,
    replayOf: null,
    ...overrides,
  };
}

module.exports = { freshDb, freshDbWithSite, requestFixture };
