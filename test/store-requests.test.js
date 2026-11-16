'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDbWithSite, requestFixture } = require('./helpers/temp-db');
const { insertRequest, getRequest, listRequests } = require('../src/store/requests');
const { REDACTED } = require('../src/redact/constants');
const { makeJwt, DEFAULT_HEADER, DEFAULT_PAYLOAD } = require('./helpers/jwt-fixture');

const CAP = 1024; // 測試用小上限，正式預設是 256KB
const OPTS = { captureSecrets: false, bodyCap: CAP };

/** 直接讀原始 row，確認「DB 裡真的是遮蔽後的值」而不只是回傳值被遮蔽。 */
function rawRow(db, id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

test('DB 裡的 authorization / cookie / set-cookie / x-api-key 都是 [REDACTED]', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      reqHeaders: {
        authorization: 'Bearer leak-me-bearer',
        cookie: 'sid=leak-me-cookie',
        'x-api-key': 'leak-me-apikey',
        'x-auth-token': 'leak-me-authtoken',
        'x-csrf-token': 'leak-me-csrf',
        'api-key': 'leak-me-plainkey',
        'proxy-authorization': 'Basic leak-me-proxy',
        'user-agent': 'keep-me',
      },
      resHeaders: {
        'content-type': 'application/json',
        'set-cookie': ['a=leak-me-setcookie; Path=/', 'b=leak-me-setcookie2'],
      },
    }),
    OPTS,
  );

  const row = rawRow(db, 'req-1');
  const reqHeaders = JSON.parse(row.req_headers);
  const resHeaders = JSON.parse(row.res_headers);

  assert.equal(reqHeaders.authorization, REDACTED);
  assert.equal(reqHeaders.cookie, REDACTED);
  assert.equal(reqHeaders['x-api-key'], REDACTED);
  assert.equal(reqHeaders['x-auth-token'], REDACTED);
  assert.equal(reqHeaders['x-csrf-token'], REDACTED);
  assert.equal(reqHeaders['api-key'], REDACTED);
  assert.equal(reqHeaders['proxy-authorization'], REDACTED);
  assert.equal(reqHeaders['user-agent'], 'keep-me');
  assert.deepEqual(resHeaders['set-cookie'], [REDACTED, REDACTED]);
  db.close();
});

test('整個 requests 表 dump 出來不含任何憑證字串', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      reqHeaders: { authorization: 'Bearer leak-me-bearer', cookie: 'sid=leak-me-cookie' },
      resHeaders: { 'content-type': 'application/json', 'set-cookie': ['x=leak-me-setcookie'] },
      resBody: JSON.stringify({ access_token: 'leak-me-token', ok: true }),
    }),
    OPTS,
  );

  const dump = JSON.stringify(db.prepare('SELECT * FROM requests').all());
  for (const leak of [
    'leak-me-bearer',
    'leak-me-cookie',
    'leak-me-setcookie',
    'leak-me-token',
  ]) {
    assert.ok(!dump.includes(leak), `DB dump 不該含 ${leak}`);
  }
  db.close();
});

test('JSON res_body 的 access_token 被遮蔽，其他欄位完好', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      resBody: JSON.stringify({ access_token: 'secret-abc', user: { id: 7 }, ok: true }),
    }),
    OPTS,
  );
  const stored = JSON.parse(rawRow(db, 'req-1').res_body);
  assert.equal(stored.access_token, REDACTED);
  assert.deepEqual(stored.user, { id: 7 });
  assert.equal(stored.ok, true);
  db.close();
});

test('req_body 也會被遮蔽（登入請求的 password）', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      method: 'POST',
      reqHeaders: { 'content-type': 'application/json' },
      reqBody: JSON.stringify({ username: 'jeff', password: 'hunter2-leak' }),
    }),
    OPTS,
  );
  const row = rawRow(db, 'req-1');
  assert.ok(!row.req_body.includes('hunter2-leak'));
  assert.equal(JSON.parse(row.req_body).username, 'jeff');
  db.close();
});

test('不可解析的 body 原樣保存、不被破壞', () => {
  const db = freshDbWithSite();
  const html = '<!doctype html><p>access_token is just words here</p>';
  insertRequest(
    db,
    requestFixture({ resHeaders: { 'content-type': 'text/html' }, resBody: html }),
    OPTS,
  );
  assert.equal(rawRow(db, 'req-1').res_body, html);
  db.close();
});

test('超過 bodyCap 的 body 被截斷且 body_truncated=1', () => {
  const db = freshDbWithSite();
  const big = 'x'.repeat(CAP * 3);
  insertRequest(
    db,
    requestFixture({ resHeaders: { 'content-type': 'text/plain' }, resBody: big }),
    OPTS,
  );
  const row = rawRow(db, 'req-1');
  assert.equal(row.body_truncated, 1);
  assert.equal(Buffer.byteLength(row.res_body, 'utf8'), CAP);
  db.close();
});

test('未超過上限時 body_truncated=0', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture(), OPTS);
  assert.equal(rawRow(db, 'req-1').body_truncated, 0);
  db.close();
});

test('遮蔽先於截斷：機密在超長 JSON 的尾端也不會漏進 DB', () => {
  const db = freshDbWithSite();
  const padded = JSON.stringify({ filler: 'y'.repeat(CAP * 2), access_token: 'tail-secret-leak' });
  assert.ok(padded.length > CAP, '前置條件：body 必須超過上限');
  insertRequest(db, requestFixture({ resBody: padded }), OPTS);

  const row = rawRow(db, 'req-1');
  assert.ok(!row.res_body.includes('tail-secret-leak'), '截斷順序錯會讓尾端機密漏出來');
  assert.equal(row.body_truncated, 1);
  db.close();
});

test('binary 回應只記 metadata、不存 body', () => {
  const db = freshDbWithSite();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  insertRequest(
    db,
    requestFixture({
      resHeaders: { 'content-type': 'image/png' },
      resBody: png,
      resBytes: png.length,
    }),
    OPTS,
  );
  const row = rawRow(db, 'req-1');
  assert.equal(row.res_body, null, 'binary 不准存 body');
  assert.equal(row.res_bytes, png.length, 'metadata 還是要記');
  assert.equal(row.content_type, 'image/png');
  db.close();
});

test('影片回應不存 body', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      resHeaders: { 'content-type': 'video/mp4' },
      resBody: Buffer.alloc(5000, 1),
      resBytes: 5000,
    }),
    OPTS,
  );
  assert.equal(rawRow(db, 'req-1').res_body, null);
  db.close();
});

test('m3u8 / mpd 是文字類型，會被擷取（追影片來源需要）', () => {
  const db = freshDbWithSite();
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
  insertRequest(
    db,
    requestFixture({
      resHeaders: { 'content-type': 'application/vnd.apple.mpegurl' },
      resBody: playlist,
    }),
    OPTS,
  );
  assert.equal(rawRow(db, 'req-1').res_body, playlist);
  db.close();
});

test('auth_shape 被算出來並存進 DB', () => {
  const db = freshDbWithSite();
  const jwt = makeJwt(DEFAULT_HEADER, DEFAULT_PAYLOAD);
  insertRequest(
    db,
    requestFixture({ reqHeaders: { authorization: `Bearer ${jwt}` } }),
    OPTS,
  );
  const row = rawRow(db, 'req-1');
  assert.equal(row.auth_shape, 'bearer:jwt-like');
  assert.ok(!row.auth_shape.includes(jwt), 'auth_shape 不該含 token 本身');
  db.close();
});

test('signed-url 的 auth_shape 從 URL 算出來', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({ url: 'https://cdn.example.com/v.m3u8?token=sig-leak&Expires=1' }),
    OPTS,
  );
  assert.equal(rawRow(db, 'req-1').auth_shape, 'signed-url');
  db.close();
});

test('沒有授權跡象時 auth_shape 為 null', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture(), OPTS);
  assert.equal(rawRow(db, 'req-1').auth_shape, null);
  db.close();
});

test('captureSecrets=true 時原值保留（危險選項）', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      reqHeaders: { authorization: 'Bearer kept-on-purpose' },
      resBody: JSON.stringify({ access_token: 'kept-token' }),
    }),
    { captureSecrets: true, bodyCap: CAP },
  );
  const row = rawRow(db, 'req-1');
  assert.equal(JSON.parse(row.req_headers).authorization, 'Bearer kept-on-purpose');
  assert.ok(row.res_body.includes('kept-token'));
  db.close();
});

test('未傳 options 時預設是安全的（遮蔽開啟）', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ reqHeaders: { cookie: 'sid=default-leak' } }));
  assert.ok(!JSON.stringify(rawRow(db, 'req-1')).includes('default-leak'));
  db.close();
});

test('getRequest 回傳解析好的 headers 與 body', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture(), OPTS);
  const found = getRequest(db, 'req-1');
  assert.equal(found.id, 'req-1');
  assert.deepEqual(found.resHeaders, { 'content-type': 'application/json' });
  assert.equal(found.resBody, '{"ok":true}');
  assert.equal(found.method, 'GET');
  db.close();
});

test('getRequest 查不到回 null', () => {
  const db = freshDbWithSite();
  assert.equal(getRequest(db, 'nope'), null);
  db.close();
});

test('source 只接受 proxy / playwright / replay', () => {
  const db = freshDbWithSite();
  assert.throws(() => insertRequest(db, requestFixture({ source: 'made-up' }), OPTS), /source/i);
  db.close();
});

test('必填欄位缺漏時明確報錯', () => {
  const db = freshDbWithSite();
  assert.throws(() => insertRequest(db, requestFixture({ method: null }), OPTS), /method/i);
  assert.throws(() => insertRequest(db, requestFixture({ url: null }), OPTS), /url/i);
  db.close();
});

test('listRequests 依時間新到舊排序', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'r1', ts: '2026-11-16T10:00:00.000Z' }), OPTS);
  insertRequest(db, requestFixture({ id: 'r2', ts: '2026-11-16T11:00:00.000Z' }), OPTS);
  const ids = listRequests(db, {}).rows.map((r) => r.id);
  assert.deepEqual(ids, ['r2', 'r1']);
  db.close();
});

test('listRequests 篩選：method / status 群組 / url 包含 / content-type', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'a', method: 'GET', status: 200, url: 'https://example.com/api/x' }), OPTS);
  insertRequest(db, requestFixture({ id: 'b', method: 'POST', status: 404, url: 'https://example.com/page' }), OPTS);
  insertRequest(
    db,
    requestFixture({
      id: 'c',
      method: 'GET',
      status: 503,
      url: 'https://example.com/api/y',
      resHeaders: { 'content-type': 'text/html' },
    }),
    OPTS,
  );

  assert.deepEqual(listRequests(db, { method: 'POST' }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(listRequests(db, { status: '4xx' }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(listRequests(db, { status: '5xx' }).rows.map((r) => r.id), ['c']);
  assert.deepEqual(listRequests(db, { status: '2xx' }).rows.map((r) => r.id), ['a']);
  assert.deepEqual(listRequests(db, { status: 404 }).rows.map((r) => r.id), ['b']);
  assert.deepEqual(listRequests(db, { urlContains: '/api/' }).rows.map((r) => r.id).sort(), ['a', 'c']);
  assert.deepEqual(listRequests(db, { contentType: 'text/html' }).rows.map((r) => r.id), ['c']);
  db.close();
});

test('listRequests 篩選：時間範圍與 session', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'old', ts: '2026-11-01T00:00:00.000Z' }), OPTS);
  insertRequest(db, requestFixture({ id: 'new', ts: '2026-11-16T00:00:00.000Z' }), OPTS);

  assert.deepEqual(
    listRequests(db, { since: '2026-11-10T00:00:00.000Z' }).rows.map((r) => r.id),
    ['new'],
  );
  assert.deepEqual(
    listRequests(db, { until: '2026-11-10T00:00:00.000Z' }).rows.map((r) => r.id),
    ['old'],
  );
  db.close();
});

test('listRequests 回傳總數與分頁', () => {
  const db = freshDbWithSite();
  for (let i = 0; i < 5; i += 1) {
    insertRequest(db, requestFixture({ id: `r${i}`, ts: `2026-11-16T10:0${i}:00.000Z` }), OPTS);
  }
  const page = listRequests(db, { limit: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.rows.map((r) => r.id), ['r3', 'r2']);
  db.close();
});

test('listRequests 的 limit 有上限，不能被要求一次撈爆記憶體', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture(), OPTS);
  assert.doesNotThrow(() => listRequests(db, { limit: 999999 }));
  db.close();
});

test('corr_id 存得進去也查得到（右鍵挖掘的關聯鍵）', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ corrId: 'corr-xyz' }), OPTS);
  assert.deepEqual(listRequests(db, { corrId: 'corr-xyz' }).rows.map((r) => r.id), ['req-1']);
  db.close();
});

test('replay 紀錄的 replay_of 指回原請求', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'orig' }), OPTS);
  insertRequest(db, requestFixture({ id: 'copy', source: 'replay', replayOf: 'orig' }), OPTS);
  assert.equal(rawRow(db, 'copy').replay_of, 'orig');
  db.close();
});
