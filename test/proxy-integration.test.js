'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestApp } = require('./helpers/app-harness');
const { startFakeUpstream } = require('./helpers/fake-upstream');
const { createSite } = require('../src/store/sites');
const { listRequests, getRequest } = require('../src/store/requests');
const { REDACTED } = require('../src/redact/constants');

/** 起「假上游 + 真代理」的完整組合，並登記好一個 site。 */
async function withProxy(handler, { siteId = 'demo', env = {} } = {}) {
  const upstream = await startFakeUpstream(handler);
  const app = await startTestApp(env);
  createSite(app.db, { id: siteId, name: 'Demo', targetOrigin: upstream.origin });
  return {
    upstream,
    ...app,
    siteId,
    close: async () => {
      await app.close();
      await upstream.close();
    },
  };
}

const HTML_PAGE =
  '<html><head><title>t</title></head><body><h1>Hello</h1><script src="/assets/app.js"></script></body></html>';

const { closeAllOpen } = require('./helpers/open-resources');

// 斷言失敗時也要清乾淨。測試裡 inline 的 await close() 只在測試通過時會跑到，
// 而沒關掉的 server / DB handle 會讓 node:test 掛住不退出（毫無輸出地卡死）。
// after() 失敗時照樣執行，所以套件會「快速失敗」而不是掛住。詳見 helpers/open-resources.js。
test.after(closeAllOpen);

test('基本代理：取得上游 HTML、CSP 被移除、inspector 被注入', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY',
    });
    res.end(HTML_PAGE);
  });

  const response = await fetch(`${ctx.baseUrl}/p/demo/`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), null, 'CSP 必須被拿掉');
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.ok(body.includes('/__ldt/inspector.js'), 'inspector 必須被注入');
  assert.ok(body.includes('src="/p/demo/assets/app.js"'), '根絕對路徑要被改寫');
  assert.ok(body.includes('<h1>Hello</h1>'), '原始內容要保留');

  await ctx.close();
});

test('主路由回 HTML 時設定 ldt_site cookie', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<body></body>');
  });

  const response = await fetch(`${ctx.baseUrl}/p/demo/`, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie();
  assert.ok(
    cookies.some((c) => c.startsWith('ldt_site=demo')),
    `應該設定 ldt_site，實際收到 ${JSON.stringify(cookies)}`,
  );
  await ctx.close();
});

test('hop-by-hop header 不被轉送，host 被改成上游', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await fetch(`${ctx.baseUrl}/p/demo/x`, {
    headers: { 'x-keep-me': 'yes', 'accept-encoding': 'zstd-exotic-client-value' },
  });

  const received = ctx.upstream.lastRequest();
  assert.equal(received.headers.host, `127.0.0.1:${ctx.upstream.port}`);
  assert.equal(received.headers['x-keep-me'], 'yes');
  assert.equal(received.headers['proxy-connection'], undefined);

  // 上游一定會收到 accept-encoding，但那是 undici 自己協商的值（它要負責解壓）。
  // 關鍵是**客戶端帶來的值沒有被轉送** —— 轉送了 undici 就不解壓，而我們又固定
  // 丟掉 content-encoding，瀏覽器就會收到壓縮位元組當純文字看（整頁亂碼）。
  assert.ok(
    !String(received.headers['accept-encoding'] || '').includes('zstd-exotic-client-value'),
    `客戶端的 accept-encoding 不該被轉送，實際收到 ${received.headers['accept-encoding']}`,
  );

  await ctx.close();
});

test('URL 組裝：path、query、編碼過的字元、尾斜線都原樣送到上游', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  await fetch(`${ctx.baseUrl}/p/demo/a/b%20c/?q=1&r=%E4%B8%AD`);
  assert.equal(ctx.upstream.lastRequest().url, '/a/b%20c/?q=1&r=%E4%B8%AD');

  await fetch(`${ctx.baseUrl}/p/demo`);
  assert.equal(ctx.upstream.lastRequest().url, '/');

  await ctx.close();
});

test('POST body 被完整轉送（不能被吃掉）', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  await fetch(`${ctx.baseUrl}/p/demo/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'jeff', password: 'hunter2' }),
  });

  const received = ctx.upstream.lastRequest();
  assert.equal(received.method, 'POST');
  assert.deepEqual(JSON.parse(received.body.toString()), { username: 'jeff', password: 'hunter2' });

  await ctx.close();
});

test('非 HTML binary 回應 byte-for-byte 完整（用真 PNG 位元組比對）', async () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0000003010100' +
      '18dd8db00000000049454e44ae426082',
    'hex',
  );
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });

  const response = await fetch(`${ctx.baseUrl}/p/demo/logo.png`);
  const received = Buffer.from(await response.arrayBuffer());

  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(received.length, png.length);
  assert.ok(received.equals(png), 'binary 不准被改一個 byte');

  await ctx.close();
});

test('gzip 壓縮的上游回應被正確解壓且 content-encoding 被丟掉', async () => {
  const zlib = require('node:zlib');
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('<body><h1>compressed</h1></body>'));
  });

  const response = await fetch(`${ctx.baseUrl}/p/demo/`);
  const body = await response.text();
  assert.equal(response.headers.get('content-encoding'), null);
  assert.ok(body.includes('compressed'));

  await ctx.close();
});

test('3xx location 同源被改寫、跨網域原樣保留', async () => {
  const ctx = await withProxy((req, res) => {
    if (req.url === '/same') {
      res.writeHead(302, { location: `${ctx.upstream.origin}/after` });
      res.end();
      return;
    }
    res.writeHead(302, { location: 'https://other.example.org/elsewhere' });
    res.end();
  });

  const same = await fetch(`${ctx.baseUrl}/p/demo/same`, { redirect: 'manual' });
  assert.equal(same.headers.get('location'), '/p/demo/after');

  const cross = await fetch(`${ctx.baseUrl}/p/demo/cross`, { redirect: 'manual' });
  assert.equal(cross.headers.get('location'), 'https://other.example.org/elsewhere');

  await ctx.close();
});

test('多條 set-cookie 各自改寫（Domain / Secure 拿掉、SameSite=Lax）', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': [
        'a=1; Domain=.example.com; Path=/; Secure; HttpOnly',
        'b=2; Domain=.example.com; SameSite=None; Secure',
      ],
    });
    res.end('ok');
  });

  const response = await fetch(`${ctx.baseUrl}/p/demo/`);
  const cookies = response.headers.getSetCookie().filter((c) => !c.startsWith('ldt_site'));

  assert.equal(cookies.length, 2, '兩條 set-cookie 不能被合併成一條');
  for (const cookie of cookies) {
    assert.ok(!/domain=/i.test(cookie), `Domain 沒被拿掉: ${cookie}`);
    assert.ok(!/;\s*secure/i.test(cookie), `Secure 沒被拿掉: ${cookie}`);
    assert.match(cookie, /SameSite=Lax/i);
  }
  assert.ok(cookies.some((c) => c.startsWith('a=1')));
  assert.ok(cookies.some((c) => c.startsWith('b=2')));

  await ctx.close();
});

test('上游掛掉 → 502 人看得懂的頁面，且不洩漏堆疊', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('ok'));
  const app = await startTestApp();
  createSite(app.db, { id: 'dead', name: 'Dead', targetOrigin: upstream.origin });
  await upstream.close(); // 上游關掉，代理一定連不上

  const response = await fetch(`${app.baseUrl}/p/dead/`);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.ok(body.length > 50, '要是人看得懂的頁面，不是一句「代理請求失敗」');
  assert.ok(body.includes(upstream.origin), '要告訴使用者目標是什麼');
  assert.ok(!body.includes('at Object.'), '不准洩漏堆疊');
  assert.ok(!body.includes('node:internal'), '不准洩漏堆疊');

  await app.close();
});

test('停用的 site 不代理', async () => {
  const ctx = await withProxy((req, res) => res.end('ok'));
  const { updateSite } = require('../src/store/sites');
  updateSite(ctx.db, 'demo', { enabled: 0 });

  const response = await fetch(`${ctx.baseUrl}/p/demo/`);
  assert.equal(response.status, 404);

  await ctx.close();
});

test('不存在的 site → 404 帶說明（不是 502）', async () => {
  const ctx = await withProxy((req, res) => res.end('ok'));
  const response = await fetch(`${ctx.baseUrl}/p/ghost/`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).length > 20);
  await ctx.close();
});

test('根路徑 fallback：cookie 解析 siteId', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('console.log(1)');
  });

  const response = await fetch(`${ctx.baseUrl}/assets/app.js`, {
    headers: { cookie: 'ldt_site=demo' },
  });
  assert.equal(response.status, 200);
  assert.equal(ctx.upstream.lastRequest().url, '/assets/app.js');

  await ctx.close();
});

test('根路徑 fallback：Referer 解析 siteId', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('body{}');
  });

  const response = await fetch(`${ctx.baseUrl}/css/main.css`, {
    headers: { referer: `${ctx.baseUrl}/p/demo/some/page` },
  });
  assert.equal(response.status, 200);
  assert.equal(ctx.upstream.lastRequest().url, '/css/main.css');

  await ctx.close();
});

test('根路徑 fallback：cookie 優先於 referer', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('from-cookie-site');
  });
  const other = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('from-referer-site');
  });
  const app = await startTestApp();
  createSite(app.db, { id: 'cookiesite', name: 'C', targetOrigin: upstream.origin });
  createSite(app.db, { id: 'referersite', name: 'R', targetOrigin: other.origin });

  const response = await fetch(`${app.baseUrl}/shared.txt`, {
    headers: { cookie: 'ldt_site=cookiesite', referer: `${app.baseUrl}/p/referersite/x` },
  });
  assert.equal(await response.text(), 'from-cookie-site');

  await app.close();
  await upstream.close();
  await other.close();
});

test('根路徑 fallback：解析不到 siteId → 404 加說明，不是 502', async () => {
  const app = await startTestApp();
  const response = await fetch(`${app.baseUrl}/orphan/asset.js`);
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.ok(/site/i.test(body), '要說明為什麼 404');
  await app.close();
});

test('保留路徑不進代理：/__ldt/inspector.js 回腳本本身', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<body>upstream should not serve this</body>');
  });

  const response = await fetch(`${ctx.baseUrl}/__ldt/inspector.js`, {
    headers: { cookie: 'ldt_site=demo' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  const body = await response.text();
  assert.ok(body.includes('__LDT__'), '應該是 inspector 腳本');
  assert.ok(!body.includes('upstream should not serve this'));

  await ctx.close();
});

test('每一筆轉送都寫進 requests，且 cookie / authorization 在 DB 裡是 [REDACTED]', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': ['session=upstream-secret-value; Path=/'],
    });
    res.end(JSON.stringify({ access_token: 'body-secret-value', ok: true }));
  });

  await fetch(`${ctx.baseUrl}/p/demo/api/me`, {
    headers: {
      cookie: 'sid=client-secret-value',
      authorization: 'Bearer client-bearer-secret',
    },
  });

  // 擷取是在回應送出之後做的，給它一點時間落地。
  await new Promise((resolve) => setTimeout(resolve, 150));

  const { rows } = listRequests(ctx.db, { urlContains: '/api/me' });
  assert.equal(rows.length, 1, '轉送必須被記錄');

  const detail = getRequest(ctx.db, rows[0].id);
  assert.equal(detail.reqHeaders.cookie, REDACTED);
  assert.equal(detail.reqHeaders.authorization, REDACTED);
  assert.equal(detail.status, 200);
  assert.equal(detail.method, 'GET');
  assert.equal(detail.source, 'proxy');
  assert.ok(detail.durationMs >= 0);

  const dump = JSON.stringify(ctx.db.prepare('SELECT * FROM requests').all());
  for (const leak of ['client-secret-value', 'client-bearer-secret', 'upstream-secret-value', 'body-secret-value']) {
    assert.ok(!dump.includes(leak), `DB 不該含 ${leak}`);
  }

  await ctx.close();
});

test('擷取會帶上本次啟動的 session_id（否則面板的 session 篩選永遠篩不到東西）', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const app = await startTestApp({}, { sessionId: 'ses_test_run' });
  createSite(app.db, { id: 'demo', name: 'Demo', targetOrigin: upstream.origin });

  await fetch(`${app.baseUrl}/p/demo/api/thing`);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const { rows } = listRequests(app.db, { sessionId: 'ses_test_run' });
  assert.equal(rows.length, 1, 'session 篩選要篩得到這筆');
  assert.equal(rows[0].sessionId, 'ses_test_run');

  await app.close();
  await upstream.close();
});

test('擷取寫入失敗不會弄壞代理（觀測壞掉 ≠ 代理壞掉）', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('still works');
  });

  // 刻意只弄壞「寫紀錄」這條路，site 查詢照常 —— 這樣才測得到擷取失敗的隔離，
  // 而不是把整個 DB 關掉（那連路由都過不了，測到的是別的東西）。
  ctx.db.exec('DROP TABLE requests');

  const first = await fetch(`${ctx.baseUrl}/p/demo/`);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'still works');

  // 擷取是 setImmediate 之後才做的，等它真的失敗過一次。
  await new Promise((resolve) => setTimeout(resolve, 150));

  // 第二次請求也要照樣成功 —— 證明失敗沒有留下壞狀態。
  const second = await fetch(`${ctx.baseUrl}/p/demo/`);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'still works');

  await ctx.close();
});

test('SSRF：不放行私網時，代理私網目標被拒（請求時再驗一次 → 擋 DNS rebinding）', async () => {
  const upstream = await startFakeUpstream((req, res) => res.end('should not reach'));
  // 這個 app 沒有 ALLOW_PRIVATE
  const app = await startTestApp({ LOCALDEVTOOL_ALLOW_PRIVATE: '0' });
  // 直接塞進 DB，繞過建站時的檢查，模擬「建站當時解析到公網、請求時卻指向私網」
  app.db
    .prepare(
      `INSERT INTO sites (id, name, target_origin, enabled, created_at, updated_at)
       VALUES ('rebind', 'Rebind', ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run(upstream.origin);

  const response = await fetch(`${app.baseUrl}/p/rebind/`);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /私|SSRF/);
  assert.equal(upstream.received.length, 0, '請求根本不該送到上游');

  await app.close();
  await upstream.close();
});

test('HEAD 請求不會因為沒有 body 而壞掉', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end();
  });
  const response = await fetch(`${ctx.baseUrl}/p/demo/`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  await ctx.close();
});

test('上游 4xx/5xx 狀態碼原樣傳回（不要自己改成 502）', async () => {
  const ctx = await withProxy((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden by upstream');
  });
  const response = await fetch(`${ctx.baseUrl}/p/demo/`);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'forbidden by upstream');
  await ctx.close();
});
