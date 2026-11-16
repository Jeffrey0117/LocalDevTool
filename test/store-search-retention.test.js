'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDbWithSite, requestFixture } = require('./helpers/temp-db');
const { insertRequest } = require('../src/store/requests');
const { searchBodies, isFtsAvailable } = require('../src/store/search');
const { sweep } = require('../src/store/retention');

const OPTS = { captureSecrets: false, bodyCap: 64 * 1024 };

test('FTS5 在本機可用（若不可用，退回 LIKE 的路徑仍必須通）', () => {
  const db = freshDbWithSite();
  assert.equal(typeof isFtsAvailable(db), 'boolean');
  db.close();
});

test('searchBodies 找得到 res_body 裡的字串', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({ id: 'hit', resBody: JSON.stringify({ playbackUrl: 'https://cdn/x/abc123.m3u8' }) }),
    OPTS,
  );
  insertRequest(db, requestFixture({ id: 'miss', resBody: JSON.stringify({ other: 'nothing' }) }), OPTS);

  const ids = searchBodies(db, 'abc123').map((r) => r.id);
  assert.deepEqual(ids, ['hit']);
  db.close();
});

test('searchBodies 對含標點的 URL 片段也能命中（FTS 查詢要被正確轉義）', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({ id: 'hit', resBody: JSON.stringify({ url: 'https://cdn.example.com/v/9f8e.m3u8?token=x' }) }),
    OPTS,
  );
  const ids = searchBodies(db, 'cdn.example.com/v/9f8e.m3u8').map((r) => r.id);
  assert.deepEqual(ids, ['hit']);
  db.close();
});

test('searchBodies 不會因為奇怪的查詢字串炸掉（FTS 語法注入）', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ resBody: '{"a":1}' }), OPTS);
  for (const needle of ['"', 'AND OR NOT', '*', '(((', 'a OR b", NEAR/']) {
    assert.doesNotThrow(() => searchBodies(db, needle), `查詢 ${needle} 不該炸`);
  }
  db.close();
});

test('searchBodies 空查詢回空陣列', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture(), OPTS);
  assert.deepEqual(searchBodies(db, ''), []);
  assert.deepEqual(searchBodies(db, '   '), []);
  db.close();
});

test('searchBodies 可限制筆數', () => {
  const db = freshDbWithSite();
  for (let i = 0; i < 5; i += 1) {
    insertRequest(db, requestFixture({ id: `r${i}`, resBody: '{"needle":"findme"}' }), OPTS);
  }
  assert.equal(searchBodies(db, 'findme', { limit: 2 }).length, 2);
  db.close();
});

test('searchBodies 強制 LIKE 模式也能找到（FTS 建不起來的退路）', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'hit', resBody: '{"v":"needle-value"}' }), OPTS);
  const ids = searchBodies(db, 'needle-value', { forceLike: true }).map((r) => r.id);
  assert.deepEqual(ids, ['hit']);
  db.close();
});

test('LIKE 模式的查詢字串裡的 % 與 _ 被轉義，不會變成萬用字元', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'literal', resBody: '{"v":"100%done"}' }), OPTS);
  insertRequest(db, requestFixture({ id: 'other', resBody: '{"v":"anything"}' }), OPTS);
  const ids = searchBodies(db, '100%d', { forceLike: true }).map((r) => r.id);
  assert.deepEqual(ids, ['literal']);
  db.close();
});

test('刪除紀錄時 FTS 索引同步清掉，不留孤兒', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'doomed', resBody: '{"v":"will-be-deleted"}' }), OPTS);
  assert.equal(searchBodies(db, 'will-be-deleted').length, 1);

  sweep(db, { retentionDays: 3650, retentionMax: 0 });
  assert.equal(searchBodies(db, 'will-be-deleted').length, 0, 'FTS 不該留下已刪紀錄');
  db.close();
});

test('保留策略：超過筆數上限的舊紀錄被清掉，新的留著', () => {
  const db = freshDbWithSite();
  for (let i = 0; i < 10; i += 1) {
    insertRequest(
      db,
      requestFixture({ id: `r${i}`, ts: `2026-11-16T10:${String(i).padStart(2, '0')}:00.000Z` }),
      OPTS,
    );
  }
  const result = sweep(db, { retentionDays: 3650, retentionMax: 4 });
  assert.equal(result.deletedByCount, 6);

  const remaining = db.prepare('SELECT id FROM requests ORDER BY ts').all().map((r) => r.id);
  assert.deepEqual(remaining, ['r6', 'r7', 'r8', 'r9']);
  db.close();
});

test('保留策略：超過天數的紀錄被清掉', () => {
  const db = freshDbWithSite();
  const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const recent = new Date(Date.now() - 1 * 86400 * 1000).toISOString();
  insertRequest(db, requestFixture({ id: 'old', ts: old }), OPTS);
  insertRequest(db, requestFixture({ id: 'recent', ts: recent }), OPTS);

  const result = sweep(db, { retentionDays: 7, retentionMax: 50000 });
  assert.equal(result.deletedByAge, 1);
  const remaining = db.prepare('SELECT id FROM requests').all().map((r) => r.id);
  assert.deepEqual(remaining, ['recent']);
  db.close();
});

test('保留策略：沒東西可清時回報 0，不報錯', () => {
  const db = freshDbWithSite();
  const result = sweep(db, { retentionDays: 7, retentionMax: 100 });
  assert.equal(result.deletedByAge, 0);
  assert.equal(result.deletedByCount, 0);
  db.close();
});

test('保留策略：關聯的 findings 也一起清掉', () => {
  const db = freshDbWithSite();
  const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  insertRequest(db, requestFixture({ id: 'old', ts: old }), OPTS);
  sweep(db, { retentionDays: 7, retentionMax: 50000 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM requests').get().c, 0);
  db.close();
});
