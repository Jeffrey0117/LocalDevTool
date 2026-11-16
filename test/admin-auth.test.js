'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startTestApp, ADMIN_TOKEN } = require('./helpers/app-harness');
const { resolveAdminToken } = require('../src/admin/auth');

const { closeAllOpen } = require('./helpers/open-resources');

// 斷言失敗時也要清乾淨。測試裡 inline 的 await close() 只在測試通過時會跑到，
// 而沒關掉的 server / DB handle 會讓 node:test 掛住不退出（毫無輸出地卡死）。
// after() 失敗時照樣執行，所以套件會「快速失敗」而不是掛住。詳見 helpers/open-resources.js。
test.after(closeAllOpen);

test('沒有 token → 401', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`);
  assert.equal(response.status, 401);
  await app.close();
});

test('錯的 token → 401', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    headers: { authorization: 'Bearer definitely-wrong' },
  });
  assert.equal(response.status, 401);
  await app.close();
});

test('長度不同的 token 不會讓 timingSafeEqual 拋錯，而是乾淨地回 401', async () => {
  const app = await startTestApp();
  for (const token of ['', 'x', 'a'.repeat(500)]) {
    const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 401, `token 長度 ${token.length} 應回 401`);
  }
  await app.close();
});

test('對的 Bearer token → 200', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  await app.close();
});

test('對的 cookie（ldt_admin）→ 200', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    headers: { cookie: `ldt_admin=${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  await app.close();
});

test('localhost 不免驗證（這是刻意的，理由見 README 安全段）', async () => {
  const app = await startTestApp();
  // 這個請求本來就來自 127.0.0.1，沒帶 token 仍須 401。
  const response = await fetch(`${app.baseUrl}/admin/api/sites`);
  assert.equal(response.status, 401, '本機免驗證 = 瀏覽器裡任何網頁都能當管理員');
  await app.close();
});

test('不設任何 CORS header（別的網頁拿不到回應內容）', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  await app.close();
});

test('跨站寫入（Origin 不同）→ 403，即使 token 正確', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ id: 'evil', name: 'E', targetOrigin: 'https://example.com' }),
  });
  assert.equal(response.status, 403);
  await app.close();
});

test('跨站寫入（Sec-Fetch-Site: cross-site）→ 403', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ id: 'x', name: 'X', targetOrigin: 'https://example.com' }),
  });
  assert.equal(response.status, 403);
  await app.close();
});

test('同源寫入 → 放行', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/api/sites`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      origin: app.baseUrl,
    },
    body: JSON.stringify({ id: 'ok-site', name: 'OK', targetOrigin: 'https://example.com' }),
  });
  assert.equal(response.status, 201);
  await app.close();
});

test('GET /admin?token=<t> 設 cookie 後 302 到乾淨網址', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin?token=${ADMIN_TOKEN}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin');

  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('ldt_admin='));
  assert.ok(cookie, '應該設 ldt_admin cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/admin/i);
  await app.close();
});

test('GET /admin?token=<錯的> 不設 cookie', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin?token=wrong`, { redirect: 'manual' });
  assert.equal(
    response.headers.getSetCookie().filter((c) => c.startsWith('ldt_admin=')).length,
    0,
  );
  assert.equal(response.status, 401);
  await app.close();
});

test('/admin/network?token=<t> 也能設 cookie（面板是直接開的那一頁）', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/network?token=${ADMIN_TOKEN}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/network');
  await app.close();
});

test('帶 token 時面板頁面讀得到', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/admin/network`, {
    headers: { cookie: `ldt_admin=${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.ok(body.includes('LocalDevTool'), '應該是面板 HTML');
  await app.close();
});

test('resolveAdminToken：env 優先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldt-token-'));
  const result = resolveAdminToken({ adminToken: 'from-env' }, { dataDir: dir });
  assert.equal(result.token, 'from-env');
  assert.equal(result.source, 'env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveAdminToken：沒設 env 時產生 32 bytes 隨機 hex 並寫檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldt-token-'));
  const result = resolveAdminToken({ adminToken: null }, { dataDir: dir });

  assert.equal(result.source, 'generated');
  assert.match(result.token, /^[0-9a-f]{64}$/, '32 bytes hex = 64 個字');

  const written = fs.readFileSync(path.join(dir, 'admin-token.txt'), 'utf8').trim();
  assert.equal(written, result.token);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveAdminToken：第二次啟動沿用檔案裡的 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldt-token-'));
  const first = resolveAdminToken({ adminToken: null }, { dataDir: dir });
  const second = resolveAdminToken({ adminToken: null }, { dataDir: dir });

  assert.equal(second.token, first.token);
  assert.equal(second.source, 'file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveAdminToken：絕對沒有 hardcoded 預設值', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ldt-token-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ldt-token-b-'));
  const a = resolveAdminToken({ adminToken: null }, { dataDir: dirA });
  const b = resolveAdminToken({ adminToken: null }, { dataDir: dirB });

  assert.notEqual(a.token, b.token, '兩台新機器不該產生同一個 token');
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});
