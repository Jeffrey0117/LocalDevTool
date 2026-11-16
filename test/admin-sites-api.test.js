'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestApp, adminFetch } = require('./helpers/app-harness');
const { freshDb } = require('./helpers/temp-db');
const { createSession, getSession, listSessions, endSession } = require('../src/store/sessions');

/** 用 loopback 當目標，測試就不依賴真實 DNS（harness 預設 ALLOW_PRIVATE=1）。 */
const TARGET = 'http://127.0.0.1:9999';

function postSite(app, body) {
  return adminFetch(app.baseUrl, '/admin/api/sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /admin/api/sites 建站並回 201', async () => {
  const app = await startTestApp();
  const response = await postSite(app, { id: 'demo', name: 'Demo', targetOrigin: TARGET });
  const site = await response.json();

  assert.equal(response.status, 201);
  assert.equal(site.id, 'demo');
  assert.equal(site.target_origin, TARGET);
  assert.equal(site.enabled, 1);
  await app.close();
});

test('GET /admin/api/sites 列出已登記的站', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'a', name: 'A', targetOrigin: TARGET });
  await postSite(app, { id: 'b', name: 'B', targetOrigin: TARGET });

  const data = await (await adminFetch(app.baseUrl, '/admin/api/sites')).json();
  assert.deepEqual(data.rows.map((s) => s.id).sort(), ['a', 'b']);
  await app.close();
});

test('GET /admin/api/sites/:id 單站詳情與 404', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'demo', name: 'Demo', targetOrigin: TARGET });

  const found = await adminFetch(app.baseUrl, '/admin/api/sites/demo');
  assert.equal(found.status, 200);
  assert.equal((await found.json()).name, 'Demo');

  const missing = await adminFetch(app.baseUrl, '/admin/api/sites/ghost');
  assert.equal(missing.status, 404);
  await app.close();
});

test('PUT /admin/api/sites/:id 改名與停用', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'demo', name: 'Old', targetOrigin: TARGET });

  const response = await adminFetch(app.baseUrl, '/admin/api/sites/demo', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New', enabled: 0 }),
  });
  const site = await response.json();

  assert.equal(response.status, 200);
  assert.equal(site.name, 'New');
  assert.equal(site.enabled, 0);
  await app.close();
});

test('PUT 不存在的 site → 404', async () => {
  const app = await startTestApp();
  const response = await adminFetch(app.baseUrl, '/admin/api/sites/ghost', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(response.status, 404);
  await app.close();
});

test('PUT 改 targetOrigin 也會驗證協定', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'demo', name: 'Demo', targetOrigin: TARGET });

  const response = await adminFetch(app.baseUrl, '/admin/api/sites/demo', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetOrigin: 'ftp://example.com' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /http/i);
  await app.close();
});

test('DELETE /admin/api/sites/:id 刪站（第二次 404）', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'doomed', name: 'D', targetOrigin: TARGET });

  const first = await adminFetch(app.baseUrl, '/admin/api/sites/doomed', { method: 'DELETE' });
  assert.equal(first.status, 204);

  const second = await adminFetch(app.baseUrl, '/admin/api/sites/doomed', { method: 'DELETE' });
  assert.equal(second.status, 404);
  await app.close();
});

test('建站時的驗證錯誤回 400 並說明原因', async () => {
  const app = await startTestApp();

  const badSlug = await postSite(app, { id: 'Bad Slug', name: 'X', targetOrigin: TARGET });
  assert.equal(badSlug.status, 400);
  assert.match(JSON.stringify(await badSlug.json()), /slug/i);

  const badOrigin = await postSite(app, { id: 'ok', name: 'X', targetOrigin: 'not-a-url' });
  assert.equal(badOrigin.status, 400);

  const noName = await postSite(app, { id: 'ok2', name: '  ', targetOrigin: TARGET });
  assert.equal(noName.status, 400);

  const reserved = await postSite(app, { id: 'admin', name: 'X', targetOrigin: TARGET });
  assert.equal(reserved.status, 400);
  assert.match(JSON.stringify(await reserved.json()), /保留/);
  await app.close();
});

test('重複 slug → 400', async () => {
  const app = await startTestApp();
  await postSite(app, { id: 'dup', name: 'A', targetOrigin: TARGET });
  const response = await postSite(app, { id: 'dup', name: 'B', targetOrigin: TARGET });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /已存在/);
  await app.close();
});

test('建站時私網目標在不放行時被拒（登記當下就講，不要等瀏覽時才 502）', async () => {
  const app = await startTestApp({ LOCALDEVTOOL_ALLOW_PRIVATE: '0' });
  const response = await postSite(app, { id: 'private', name: 'P', targetOrigin: TARGET });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'SSRF_BLOCKED');
  assert.match(data.error, /私/);
  await app.close();
});

test('targetOrigin 的 path 被丟掉，只留 origin', async () => {
  const app = await startTestApp();
  const site = await (
    await postSite(app, { id: 'demo', name: 'D', targetOrigin: `${TARGET}/deep/path?q=1` })
  ).json();
  assert.equal(site.target_origin, TARGET);
  await app.close();
});

test('壞掉的 JSON body → 400 而不是 500', async () => {
  const app = await startTestApp();
  const response = await adminFetch(app.baseUrl, '/admin/api/sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /JSON/);
  await app.close();
});

test('GET /admin/api/sessions 與 /findings 可讀', async () => {
  const app = await startTestApp();
  const sessions = await adminFetch(app.baseUrl, '/admin/api/sessions');
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray((await sessions.json()).rows));

  const findings = await adminFetch(app.baseUrl, '/admin/api/findings');
  assert.equal(findings.status, 200);
  assert.ok(Array.isArray((await findings.json()).rows));
  await app.close();
});

// ---------------------------------------------------------------- sessions store

test('createSession / getSession 往返', () => {
  const db = freshDb();
  const session = createSession(db, { siteId: 'demo', label: '第一次觀測' });
  assert.ok(session.id.startsWith('ses_'));
  assert.equal(session.label, '第一次觀測');
  assert.equal(session.ended_at, null);
  assert.equal(getSession(db, session.id).site_id, 'demo');
  db.close();
});

test('createSession 不帶參數也可以', () => {
  const db = freshDb();
  const session = createSession(db);
  assert.equal(session.site_id, null);
  assert.equal(session.label, null);
  db.close();
});

test('getSession 查不到回 null', () => {
  const db = freshDb();
  assert.equal(getSession(db, 'nope'), null);
  assert.equal(getSession(db, 42), null);
  db.close();
});

test('listSessions 依開始時間新到舊', () => {
  const db = freshDb();
  const first = createSession(db, { label: 'a' });
  const second = createSession(db, { label: 'b' });
  const ids = listSessions(db).map((s) => s.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(first.id) && ids.includes(second.id));
  db.close();
});

test('listSessions 的 limit 有夾限', () => {
  const db = freshDb();
  createSession(db, { label: 'a' });
  assert.equal(listSessions(db, 0).length, 1);
  assert.equal(listSessions(db, 99999).length, 1);
  db.close();
});

test('endSession 寫入結束時間；不存在回 null', () => {
  const db = freshDb();
  const session = createSession(db, { label: 'x' });
  const ended = endSession(db, session.id);
  assert.ok(ended.ended_at);
  assert.equal(endSession(db, 'nope'), null);
  db.close();
});
