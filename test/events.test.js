'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestApp } = require('./helpers/app-harness');
const { createSite } = require('../src/store/sites');
const { listFindings } = require('../src/store/findings');

async function appWithSite() {
  const app = await startTestApp();
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: 'https://example.com' });
  return app;
}

/** 模擬被代理頁面的上報：同源 Origin + 指向 /p/demo/ 的 Referer。 */
function pageFetch(app, path, body, overrides = {}) {
  return fetch(`${app.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: app.baseUrl,
      referer: `${app.baseUrl}/p/demo/some/page`,
      ...overrides,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const { closeAllOpen } = require('./helpers/open-resources');

// 斷言失敗時也要清乾淨。測試裡 inline 的 await close() 只在測試通過時會跑到，
// 而沒關掉的 server / DB handle 會讓 node:test 掛住不退出（毫無輸出地卡死）。
// after() 失敗時照樣執行，所以套件會「快速失敗」而不是掛住。詳見 helpers/open-resources.js。
test.after(closeAllOpen);

test('被代理頁面的上報被接受（不需要 admin token）', async () => {
  const app = await appWithSite();
  const response = await pageFetch(app, '/__ldt/events', {
    siteId: 'demo',
    events: [{ kind: 'request', method: 'GET', url: 'https://api.example.com/x', corrId: 'c1' }],
  });
  assert.equal(response.status, 204);
  await app.close();
});

test('上報的事件被存成 findings，可查', async () => {
  const app = await appWithSite();
  await pageFetch(app, '/__ldt/events', {
    siteId: 'demo',
    events: [
      { kind: 'media', url: 'blob:https://example.com/abc', isBlob: true, element: 'video#player' },
      { kind: 'drm', keySystem: 'com.widevine.alpha' },
    ],
  });

  const findings = listFindings(app.db);
  const kinds = findings.map((f) => f.kind);
  assert.ok(kinds.includes('client-media'));
  assert.ok(kinds.includes('client-drm'));

  const drm = findings.find((f) => f.kind === 'client-drm');
  assert.equal(drm.detail.keySystem, 'com.widevine.alpha');
  await app.close();
});

test('陌生 Origin 被拒', async () => {
  const app = await appWithSite();
  const response = await pageFetch(
    app,
    '/__ldt/events',
    { siteId: 'demo', events: [] },
    { origin: 'https://evil.example.com' },
  );
  assert.equal(response.status, 403);
  await app.close();
});

test('沒有可解析的 site（Referer / cookie 都沒有）→ 403', async () => {
  const app = await appWithSite();
  const response = await fetch(`${app.baseUrl}/__ldt/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.baseUrl },
    body: JSON.stringify({ events: [] }),
  });
  assert.equal(response.status, 403);
  await app.close();
});

test('Referer 指向未登記的 site → 403', async () => {
  const app = await appWithSite();
  const response = await pageFetch(
    app,
    '/__ldt/events',
    { events: [] },
    { referer: `${app.baseUrl}/p/not-registered/page` },
  );
  assert.equal(response.status, 403);
  await app.close();
});

test('ldt_site cookie 也能解析出 site', async () => {
  const app = await appWithSite();
  const response = await fetch(`${app.baseUrl}/__ldt/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: app.baseUrl,
      cookie: 'ldt_site=demo',
    },
    body: JSON.stringify({ events: [{ kind: 'request', url: 'https://x/y', method: 'GET' }] }),
  });
  assert.equal(response.status, 204);
  await app.close();
});

test('超過 64KB 的 payload 被拒', async () => {
  const app = await appWithSite();
  const huge = JSON.stringify({
    siteId: 'demo',
    events: [{ kind: 'request', url: `https://x/${'y'.repeat(70 * 1024)}` }],
  });
  assert.ok(huge.length > 64 * 1024, '前置條件：payload 要真的超過 64KB');

  const response = await pageFetch(app, '/__ldt/events', huge);
  assert.equal(response.status, 413);
  await app.close();
});

test('壞掉的 JSON 回 400，不是 500', async () => {
  const app = await appWithSite();
  const response = await pageFetch(app, '/__ldt/events', '{not json');
  assert.equal(response.status, 400);
  await app.close();
});

test('events 不是陣列時回 400', async () => {
  const app = await appWithSite();
  const response = await pageFetch(app, '/__ldt/events', { siteId: 'demo', events: 'nope' });
  assert.equal(response.status, 400);
  await app.close();
});

test('rate limit：超量回 429', async () => {
  const app = await startTestApp({ LOCALDEVTOOL_EVENT_RATE_LIMIT: '3' });
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: 'https://example.com' });

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const response = await pageFetch(app, '/__ldt/events', { siteId: 'demo', events: [] });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `超量應該回 429，實際為 ${statuses.join(',')}`);
  assert.equal(statuses[0], 204, '前幾次要正常通過');
  await app.close();
});

test('/__ldt/events 不回 CORS header（別的網站拿不到結果）', async () => {
  const app = await appWithSite();
  const response = await pageFetch(app, '/__ldt/events', { siteId: 'demo', events: [] });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  await app.close();
});

test('/__ldt/trace 回摘要給面板用，但不含 body', async () => {
  const app = await appWithSite();
  const { insertRequest } = require('../src/store/requests');
  const { requestFixture } = require('./helpers/temp-db');
  insertRequest(
    app.db,
    requestFixture({
      id: 'giver',
      siteId: 'demo',
      resBody: JSON.stringify({ src: 'https://cdn/x.m3u8', note: 'secret-internal-note' }),
    }),
    { captureSecrets: false, bodyCap: 65536 },
  );

  const response = await pageFetch(app, '/__ldt/trace', {
    url: 'https://cdn/x.m3u8',
    siteId: 'demo',
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data.confirmed.map((i) => i.id), ['giver']);
  assert.ok(!JSON.stringify(data).includes('secret-internal-note'), 'trace 摘要不准夾帶 body');
  await app.close();
});

test('/__ldt/trace 只看得到自己 site 的紀錄', async () => {
  const app = await appWithSite();
  createSite(app.db, { id: 'other', name: 'O', targetOrigin: 'https://other.example.com' });
  const { insertRequest } = require('../src/store/requests');
  const { requestFixture } = require('./helpers/temp-db');
  const url = 'https://cdn/shared.m3u8';

  insertRequest(app.db, requestFixture({ id: 'mine', siteId: 'demo', resBody: JSON.stringify({ url }) }), {
    captureSecrets: false,
    bodyCap: 65536,
  });
  insertRequest(app.db, requestFixture({ id: 'theirs', siteId: 'other', resBody: JSON.stringify({ url }) }), {
    captureSecrets: false,
    bodyCap: 65536,
  });

  const data = await (await pageFetch(app, '/__ldt/trace', { url })).json();
  assert.deepEqual(data.confirmed.map((i) => i.id), ['mine'], '不准看到別站的紀錄');
  await app.close();
});

test('/__ldt/trace 陌生 Origin 被拒', async () => {
  const app = await appWithSite();
  const response = await pageFetch(
    app,
    '/__ldt/trace',
    { url: 'https://x/y' },
    { origin: 'https://evil.example.com' },
  );
  assert.equal(response.status, 403);
  await app.close();
});

test('/__ldt/* 不需要也不接受 admin token 外洩（沒有回傳 token 相關資訊）', async () => {
  const app = await appWithSite();
  const response = await pageFetch(app, '/__ldt/trace', { url: 'https://x/y' });
  const text = await response.text();
  assert.ok(!text.includes(app.adminToken), '回應不准含 admin token');
  await app.close();
});
