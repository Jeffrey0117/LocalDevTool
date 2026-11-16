'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDbWithSite, requestFixture } = require('./helpers/temp-db');
const { insertRequest } = require('../src/store/requests');
const { trace, deriveNeedles } = require('../src/admin/trace');

const OPTS = { captureSecrets: false, bodyCap: 64 * 1024 };
const VIDEO_URL = 'https://cdn.example.com/stream/9f8e7d/master.m3u8?token=sig';

test('body 裡真的含該 URL → confirmed，並附上證據', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      id: 'api-giver',
      url: 'https://example.com/api/playback/42',
      path: '/api/playback/42',
      ts: '2026-11-16T10:00:00.000Z',
      resBody: JSON.stringify({ sources: [{ type: 'hls', src: VIDEO_URL }] }),
    }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL });

  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0].id, 'api-giver');
  assert.equal(result.confirmed[0].confidence, 'confirmed');
  assert.ok(result.confirmed[0].evidence.includes('res_body'), '要說明證據是什麼');
  assert.equal(result.likely.length, 0, '已證實的不該同時出現在疑似裡');
  db.close();
});

test('只是時間相近 → likely，且明確標成不是證據', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      id: 'media',
      url: VIDEO_URL,
      host: 'cdn.example.com',
      path: '/stream/9f8e7d/master.m3u8',
      ts: '2026-11-16T10:00:05.000Z',
      resHeaders: { 'content-type': 'application/vnd.apple.mpegurl' },
      resBody: '#EXTM3U',
    }),
    OPTS,
  );
  insertRequest(
    db,
    requestFixture({
      id: 'neighbour',
      url: 'https://example.com/api/unrelated',
      path: '/api/unrelated',
      ts: '2026-11-16T10:00:04.500Z',
      resBody: JSON.stringify({ nothing: 'to see here' }),
    }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL });

  assert.equal(result.confirmed.length, 0, 'body 裡沒有就不准算 confirmed');
  const likelyIds = result.likely.map((item) => item.id);
  assert.ok(likelyIds.includes('neighbour'));
  for (const item of result.likely) {
    assert.equal(item.confidence, 'likely');
    assert.ok(/時間/.test(item.evidence), '要說明只是時間相近');
  }
  db.close();
});

test('confirmed 與 likely 嚴格分開，不准把猜測當事實', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      id: 'real',
      ts: '2026-11-16T10:00:00.000Z',
      resBody: JSON.stringify({ url: VIDEO_URL }),
    }),
    OPTS,
  );
  insertRequest(
    db,
    requestFixture({ id: 'guess', ts: '2026-11-16T10:00:00.200Z', resBody: '{"x":1}' }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL });
  const confirmedIds = result.confirmed.map((i) => i.id);
  const likelyIds = result.likely.map((i) => i.id);

  assert.ok(confirmedIds.includes('real'));
  assert.ok(!confirmedIds.includes('guess'));
  assert.ok(!likelyIds.includes('real'), '同一筆不該兩邊都出現');
  db.close();
});

test('授權線索：回報命中請求與媒體請求的 auth_shape', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      id: 'api-giver',
      url: 'https://example.com/api/playback',
      reqHeaders: { authorization: 'Bearer opaque-token-value' },
      resBody: JSON.stringify({ src: VIDEO_URL }),
    }),
    OPTS,
  );
  insertRequest(
    db,
    requestFixture({
      id: 'media',
      url: VIDEO_URL,
      host: 'cdn.example.com',
      path: '/stream/9f8e7d/master.m3u8',
      resHeaders: { 'content-type': 'application/vnd.apple.mpegurl' },
      resBody: '#EXTM3U',
    }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL });
  assert.equal(result.confirmed[0].authShape, 'bearer:opaque');
  assert.ok(result.auth.signedUrl, '媒體 URL 帶 token= → 要標成簽章網址');
  assert.ok(!JSON.stringify(result).includes('opaque-token-value'), '不准洩漏 token 本身');
  db.close();
});

test('時間線依時間排序', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'c', ts: '2026-11-16T10:00:02.000Z' }), OPTS);
  insertRequest(db, requestFixture({ id: 'a', ts: '2026-11-16T10:00:00.000Z' }), OPTS);
  insertRequest(db, requestFixture({ id: 'b', ts: '2026-11-16T10:00:01.000Z' }), OPTS);

  const result = trace(db, { corrId: null, url: 'https://example.com/api/items' });
  const order = result.timeline.map((item) => item.id);
  assert.deepEqual(order, ['a', 'b', 'c']);
  db.close();
});

test('用 corrId 追蹤：只回那條關聯鏈', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'mine', corrId: 'corr-1' }), OPTS);
  insertRequest(db, requestFixture({ id: 'other', corrId: 'corr-2' }), OPTS);

  const result = trace(db, { corrId: 'corr-1' });
  const ids = result.timeline.map((item) => item.id);
  assert.deepEqual(ids, ['mine']);
  db.close();
});

test('URL 全文找不到時退而搜尋檔名片段', () => {
  const db = freshDbWithSite();
  // body 裡只有相對路徑，沒有完整 URL —— 真實世界很常見
  insertRequest(
    db,
    requestFixture({
      id: 'api-giver',
      resBody: JSON.stringify({ path: '/stream/9f8e7d/master.m3u8' }),
    }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL });
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0].id, 'api-giver');
  assert.ok(result.needlesTried.length > 1, '要回報試過哪些片段');
  db.close();
});

test('deriveNeedles 由 URL 推出可搜尋的片段（由精確到寬鬆）', () => {
  const needles = deriveNeedles(VIDEO_URL);
  assert.equal(needles[0], VIDEO_URL, '最精確的是完整 URL');
  assert.ok(needles.some((n) => n === '/stream/9f8e7d/master.m3u8'));
  assert.ok(needles.some((n) => n === 'master.m3u8'));
  assert.ok(needles.every((n) => typeof n === 'string' && n.length > 0));
});

test('deriveNeedles 對壞 URL 回傳原字串', () => {
  assert.deepEqual(deriveNeedles('not-a-url'), ['not-a-url']);
  assert.deepEqual(deriveNeedles(''), []);
  assert.deepEqual(deriveNeedles(null), []);
});

test('needle 可直接指定（使用者自己貼片段）', () => {
  const db = freshDbWithSite();
  insertRequest(db, requestFixture({ id: 'hit', resBody: '{"id":"abc-unique-id"}' }), OPTS);
  const result = trace(db, { needle: 'abc-unique-id' });
  assert.equal(result.confirmed[0].id, 'hit');
  db.close();
});

test('什麼都沒給 → 回空結果而不是炸掉', () => {
  const db = freshDbWithSite();
  const result = trace(db, {});
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.likely, []);
  db.close();
});

test('限定 siteId 時不會看到別站的紀錄（被代理頁面只能看自己的）', () => {
  const db = freshDbWithSite('site-a');
  const { createSite } = require('../src/store/sites');
  createSite(db, { id: 'site-b', name: 'B', targetOrigin: 'https://b.example.com' });

  insertRequest(
    db,
    requestFixture({ id: 'a-req', siteId: 'site-a', resBody: JSON.stringify({ u: VIDEO_URL }) }),
    OPTS,
  );
  insertRequest(
    db,
    requestFixture({ id: 'b-req', siteId: 'site-b', resBody: JSON.stringify({ u: VIDEO_URL }) }),
    OPTS,
  );

  const result = trace(db, { url: VIDEO_URL, siteId: 'site-a' });
  const ids = result.confirmed.map((i) => i.id);
  assert.deepEqual(ids, ['a-req']);
  db.close();
});

test('trace 回傳不含任何 body（面板摘要不該把擷取到的內容整包吐出來）', () => {
  const db = freshDbWithSite();
  insertRequest(
    db,
    requestFixture({
      id: 'api-giver',
      resBody: JSON.stringify({ src: VIDEO_URL, internalNote: 'do-not-expose-this-body' }),
    }),
    OPTS,
  );
  const result = trace(db, { url: VIDEO_URL });
  assert.ok(!JSON.stringify(result).includes('do-not-expose-this-body'));
  db.close();
});
