'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestApp, adminFetch } = require('./helpers/app-harness');
const { startFakeUpstream } = require('./helpers/fake-upstream');
const { createSite } = require('../src/store/sites');
const { insertRequest, listRequests } = require('../src/store/requests');
const { requestFixture } = require('./helpers/temp-db');
const { REDACTED } = require('../src/redact/constants');

const OPTS = { captureSecrets: false, bodyCap: 64 * 1024 };

async function appWithSite() {
  const app = await startTestApp();
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: 'https://example.com' });
  return app;
}

test('GET /admin/api/requests 列出紀錄並帶總數', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'r1' }), OPTS);
  insertRequest(app.db, requestFixture({ id: 'r2', ts: '2026-11-16T11:00:00.000Z' }), OPTS);

  const response = await adminFetch(app.baseUrl, '/admin/api/requests');
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.total, 2);
  assert.deepEqual(data.rows.map((r) => r.id), ['r2', 'r1']);
  await app.close();
});

test('列表不含 body（詳情才給）', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'r1', resBody: '{"big":"payload-here"}' }), OPTS);

  const data = await (await adminFetch(app.baseUrl, '/admin/api/requests')).json();
  assert.ok(!JSON.stringify(data).includes('payload-here'), '列表不該夾帶 body');
  await app.close();
});

test('篩選參數有效：method / status 群組 / urlContains', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'a', method: 'GET', status: 200 }), OPTS);
  insertRequest(
    app.db,
    requestFixture({ id: 'b', method: 'POST', status: 404, url: 'https://example.com/zzz', path: '/zzz' }),
    OPTS,
  );

  const byMethod = await (await adminFetch(app.baseUrl, '/admin/api/requests?method=POST')).json();
  assert.deepEqual(byMethod.rows.map((r) => r.id), ['b']);

  const byStatus = await (await adminFetch(app.baseUrl, '/admin/api/requests?status=4xx')).json();
  assert.deepEqual(byStatus.rows.map((r) => r.id), ['b']);

  const byUrl = await (await adminFetch(app.baseUrl, '/admin/api/requests?urlContains=zzz')).json();
  assert.deepEqual(byUrl.rows.map((r) => r.id), ['b']);
  await app.close();
});

test('GET /admin/api/requests/:id 給完整詳情（含遮蔽後的 header 與 body）', async () => {
  const app = await appWithSite();
  insertRequest(
    app.db,
    requestFixture({
      id: 'detail',
      reqHeaders: { authorization: 'Bearer leak-me', 'user-agent': 'test' },
      resBody: '{"ok":true}',
    }),
    OPTS,
  );

  const data = await (await adminFetch(app.baseUrl, '/admin/api/requests/detail')).json();
  assert.equal(data.reqHeaders.authorization, REDACTED);
  assert.equal(data.reqHeaders['user-agent'], 'test');
  assert.equal(data.resBody, '{"ok":true}');
  await app.close();
});

test('詳情查不到 → 404', async () => {
  const app = await appWithSite();
  const response = await adminFetch(app.baseUrl, '/admin/api/requests/nope');
  assert.equal(response.status, 404);
  await app.close();
});

test('搜尋 JSON 回應內容', async () => {
  const app = await appWithSite();
  insertRequest(
    app.db,
    requestFixture({ id: 'hit', resBody: JSON.stringify({ playback: 'abc-needle-123' }) }),
    OPTS,
  );
  insertRequest(app.db, requestFixture({ id: 'miss', resBody: '{"other":1}' }), OPTS);

  const data = await (
    await adminFetch(app.baseUrl, '/admin/api/search?q=abc-needle-123')
  ).json();
  assert.deepEqual(data.rows.map((r) => r.id), ['hit']);
  await app.close();
});

test('搜尋空字串 → 回空結果而不是全撈', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'r1' }), OPTS);
  const data = await (await adminFetch(app.baseUrl, '/admin/api/search?q=')).json();
  assert.deepEqual(data.rows, []);
  await app.close();
});

test('比較兩筆同 URL 的紀錄 → 文字 diff', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'old', resBody: '{\n"a": 1\n}' }), OPTS);
  insertRequest(app.db, requestFixture({ id: 'new', resBody: '{\n"a": 2\n}' }), OPTS);

  const response = await adminFetch(app.baseUrl, '/admin/api/compare?a=old&b=new');
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(data.diff));
  const text = data.diff.map((d) => `${d.type}:${d.text}`).join('|');
  assert.ok(text.includes('del:"a": 1'));
  assert.ok(text.includes('add:"a": 2'));
  await app.close();
});

test('比較時任一筆不存在 → 404', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'only' }), OPTS);
  const response = await adminFetch(app.baseUrl, '/admin/api/compare?a=only&b=ghost');
  assert.equal(response.status, 404);
  await app.close();
});

test('POST /admin/api/trace 回傳 confirmed / likely 分開的證據鏈', async () => {
  const app = await appWithSite();
  const videoUrl = 'https://cdn.example.com/v/abc.m3u8';
  insertRequest(
    app.db,
    requestFixture({ id: 'giver', resBody: JSON.stringify({ src: videoUrl }) }),
    OPTS,
  );

  const response = await adminFetch(app.baseUrl, '/admin/api/trace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: videoUrl }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.confirmed.map((i) => i.id), ['giver']);
  assert.ok(Array.isArray(data.likely));
  await app.close();
});

// ---------------------------------------------------------------- Replay（會產生副作用）

test('GET 可以重放，結果存成新紀錄並 replay_of 指回原本的', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"replayed":true}');
  });
  const app = await startTestApp();
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: upstream.origin });
  insertRequest(
    app.db,
    requestFixture({
      id: 'orig',
      url: `${upstream.origin}/api/items`,
      host: `127.0.0.1:${upstream.port}`,
      path: '/api/items',
      reqHeaders: { 'user-agent': 'test' },
    }),
    OPTS,
  );

  const response = await adminFetch(app.baseUrl, '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'orig' }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.status, 200);
  assert.ok(data.requestId, '要回傳新紀錄的 id');

  const replayed = listRequests(app.db, { source: 'replay' }).rows;
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].replayOf, 'orig');

  await app.close();
  await upstream.close();
});

test('非 GET/HEAD 沒帶確認旗標 → 400 並明確警告會產生真實副作用', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'post-orig', method: 'POST' }), OPTS);

  const response = await adminFetch(app.baseUrl, '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'post-orig' }),
  });
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.equal(data.needsConfirmation, true);
  assert.match(data.warning, /副作用/);
  await app.close();
});

test('遮蔽過憑證的請求：replay 前要明確說會以未授權狀態送出', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const app = await startTestApp();
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: upstream.origin });
  insertRequest(
    app.db,
    requestFixture({
      id: 'with-auth',
      url: `${upstream.origin}/api/me`,
      host: `127.0.0.1:${upstream.port}`,
      path: '/api/me',
      reqHeaders: { authorization: 'Bearer was-redacted', cookie: 'sid=was-redacted' },
    }),
    OPTS,
  );

  const data = await (
    await adminFetch(app.baseUrl, '/admin/api/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'with-auth' }),
    })
  ).json();

  assert.ok(
    data.warnings.some((w) => /遮蔽/.test(w) && /未授權/.test(w)),
    `應警告憑證已遮蔽，實際為 ${JSON.stringify(data.warnings)}`,
  );

  // 關鍵：不准把字面的 [REDACTED] 當成憑證送出去
  const sent = upstream.lastRequest();
  assert.notEqual(sent.headers.authorization, REDACTED);
  assert.equal(sent.headers.authorization, undefined, '遮蔽過的 header 應該整個不送');
  assert.equal(sent.headers.cookie, undefined);

  await app.close();
  await upstream.close();
});

test('replay 不存在的紀錄 → 404', async () => {
  const app = await appWithSite();
  const response = await adminFetch(app.baseUrl, '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ghost' }),
  });
  assert.equal(response.status, 404);
  await app.close();
});

test('replay 走跨站請求 → 403（寫入要檢查 Origin）', async () => {
  const app = await appWithSite();
  insertRequest(app.db, requestFixture({ id: 'orig' }), OPTS);
  const response = await fetch(`${app.baseUrl}/admin/api/replay`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ id: 'orig' }),
  });
  assert.equal(response.status, 403);
  await app.close();
});

test('replay 的 SSRF 檢查照樣生效', async () => {
  const app = await startTestApp({ LOCALDEVTOOL_ALLOW_PRIVATE: '0' });
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: 'https://example.com' });
  insertRequest(
    app.db,
    requestFixture({
      id: 'private-target',
      url: 'http://127.0.0.1:9/nope',
      host: '127.0.0.1:9',
      path: '/nope',
    }),
    OPTS,
  );

  const response = await adminFetch(app.baseUrl, '/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'private-target' }),
  });
  assert.equal(response.status, 502);
  assert.match(JSON.stringify(await response.json()), /私|SSRF/);
  await app.close();
});
