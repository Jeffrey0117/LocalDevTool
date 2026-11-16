'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestApp, adminFetch } = require('./helpers/app-harness');
const { loadPlaywright, HOW_TO_FIX } = require('../src/inspector/playwright');

/** Playwright 不在時的載入器（注入用，讓 501 路徑可以穩定測） */
const absentLoader = () => ({
  available: false,
  error: 'Cannot find module \'playwright\'',
  howToFix: HOW_TO_FIX,
});

/** 不開瀏覽器的假 runner，用 fake 事件流產生報告 */
const fakeRunner = async (input) => ({
  url: input.url,
  events: [
    { id: 'r1', type: 'request', method: 'GET', url: 'https://cdn/v.m3u8', headers: {} },
    {
      id: 'r1',
      type: 'response',
      url: 'https://cdn/v.m3u8',
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n',
    },
  ],
});

const { closeAllOpen } = require('./helpers/open-resources');

// 斷言失敗時也要清乾淨。測試裡 inline 的 await close() 只在測試通過時會跑到，
// 而沒關掉的 server / DB handle 會讓 node:test 掛住不退出（毫無輸出地卡死）。
// after() 失敗時照樣執行，所以套件會「快速失敗」而不是掛住。詳見 helpers/open-resources.js。
test.after(closeAllOpen);

test('Playwright 沒安裝時 POST /admin/api/inspect 回 501 且帶 howToFix', async () => {
  const app = await startTestApp({}, { playwrightLoader: absentLoader });
  const response = await adminFetch(app.baseUrl, '/admin/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  const data = await response.json();

  assert.equal(response.status, 501);
  assert.ok(data.error, '要有 error 說明');
  assert.equal(data.howToFix, 'npm i -D playwright && npx playwright install chromium');
  await app.close();
});

test('Playwright 沒安裝不會讓 app 啟動失敗（其他端點照常）', async () => {
  const app = await startTestApp({}, { playwrightLoader: absentLoader });
  const response = await adminFetch(app.baseUrl, '/admin/api/requests');
  assert.equal(response.status, 200, 'Playwright 缺席不該影響流量面板');
  await app.close();
});

test('缺 url 參數 → 400', async () => {
  const app = await startTestApp({}, { playwrightLoader: absentLoader, inspectRunner: fakeRunner });
  const response = await adminFetch(app.baseUrl, '/admin/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  await app.close();
});

test('非 http(s) 的 url → 400（SSRF 同一套底線）', async () => {
  const app = await startTestApp(
    { LOCALDEVTOOL_ALLOW_PRIVATE: '0' },
    { inspectRunner: fakeRunner },
  );
  const response = await adminFetch(app.baseUrl, '/admin/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'file:///etc/passwd' }),
  });
  assert.equal(response.status, 400);
  await app.close();
});

test('私網目標在不放行時被拒', async () => {
  const app = await startTestApp(
    { LOCALDEVTOOL_ALLOW_PRIVATE: '0' },
    { inspectRunner: fakeRunner },
  );
  const response = await adminFetch(app.baseUrl, '/admin/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1/x' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /私|SSRF/);
  await app.close();
});

test('提交後回報告 id，查詢得到結果', async () => {
  const app = await startTestApp({}, { inspectRunner: fakeRunner });

  const submitted = await (
    await adminFetch(app.baseUrl, '/admin/api/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/watch' }),
    })
  ).json();

  assert.ok(submitted.id, '要回報告 id');
  assert.ok(['queued', 'running', 'done'].includes(submitted.status));

  // 輪詢到完成
  let job = null;
  for (let i = 0; i < 40; i += 1) {
    job = await (await adminFetch(app.baseUrl, `/admin/api/inspect/${submitted.id}`)).json();
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(job.status, 'done', `應該完成，實際 ${JSON.stringify(job).slice(0, 300)}`);
  assert.equal(job.result.mediaCandidates[0].url, 'https://cdn/v.m3u8');
  assert.equal(job.result.playlists[0].type, 'master');
  await app.close();
});

test('查詢不存在的報告 → 404', async () => {
  const app = await startTestApp({}, { inspectRunner: fakeRunner });
  const response = await adminFetch(app.baseUrl, '/admin/api/inspect/nope');
  assert.equal(response.status, 404);
  await app.close();
});

test('GET /admin/inspect/:id 回 HTML 報告，而且是證據表不是結論', async () => {
  const app = await startTestApp({}, { inspectRunner: fakeRunner });

  const submitted = await (
    await adminFetch(app.baseUrl, '/admin/api/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/watch' }),
    })
  ).json();

  for (let i = 0; i < 40; i += 1) {
    const job = await (await adminFetch(app.baseUrl, `/admin/api/inspect/${submitted.id}`)).json();
    if (job.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const response = await adminFetch(app.baseUrl, `/admin/inspect/${submitted.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);

  const html = await response.text();
  assert.ok(html.includes('https://cdn/v.m3u8'));
  assert.ok(/confirmed|likely|unknown/.test(html), '每一項都要標信心等級');
  assert.ok(html.includes('不解密') || html.includes('DRM'), '要有 DRM 立場說明');
  await app.close();
});

test('inspect 是寫入動作，跨站 → 403', async () => {
  const app = await startTestApp({}, { inspectRunner: fakeRunner });
  const response = await fetch(`${app.baseUrl}/admin/api/inspect`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${app.adminToken}`,
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(response.status, 403);
  await app.close();
});

test('inspect 端點要 admin token', async () => {
  const app = await startTestApp({}, { inspectRunner: fakeRunner });
  const response = await fetch(`${app.baseUrl}/admin/api/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(response.status, 401);
  await app.close();
});

test('loadPlaywright 回傳形狀一致，不論裝了沒有（而且不會丟錯）', () => {
  const result = loadPlaywright();
  assert.equal(typeof result.available, 'boolean');
  assert.equal(result.howToFix, 'npm i -D playwright && npx playwright install chromium');
  if (result.available) {
    assert.ok(result.chromium, '說可用就要給得出 chromium');
  } else {
    assert.ok(typeof result.error === 'string' && result.error !== '', '說不可用就要說明原因');
  }
});
