'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUpstreamHeaders, HOP_BY_HOP } = require('../src/proxy/request-headers');
const { filterResponseHeaders, DROPPED_RESPONSE_HEADERS } = require('../src/proxy/response-headers');

test('hop-by-hop 與會打壞上游的 header 全部被移除', () => {
  const out = buildUpstreamHeaders(
    {
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'proxy-authorization': 'Basic x',
      'proxy-connection': 'keep-alive',
      te: 'trailers',
      trailer: 'Expires',
      host: 'proxy.local:30700',
      'content-length': '123',
      accept: 'text/html',
    },
    { upstreamHost: 'example.com' },
  );

  for (const name of HOP_BY_HOP) {
    // host 例外：它被刻意改寫成上游 host（見下一條測試），不是「移除」。
    if (name === 'host') continue;
    assert.ok(!(name in out), `${name} 不該被轉送`);
  }
  assert.equal(out.accept, 'text/html');
});

test('host 被改成上游 host', () => {
  const out = buildUpstreamHeaders({ host: 'proxy.local:30700' }, { upstreamHost: 'example.com' });
  assert.equal(out.host, 'example.com');
});

test('cookie / user-agent / accept* / content-type 被保留', () => {
  const out = buildUpstreamHeaders(
    {
      cookie: 'sid=abc',
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
      'accept-language': 'zh-TW',
      'content-type': 'application/json',
    },
    { upstreamHost: 'example.com' },
  );
  assert.equal(out.cookie, 'sid=abc');
  assert.equal(out['user-agent'], 'Mozilla/5.0');
  assert.equal(out.accept, 'text/html');
  assert.equal(out['accept-language'], 'zh-TW');
  assert.equal(out['content-type'], 'application/json');
});

test('不自己加 accept-encoding，且瀏覽器帶來的也要拿掉', () => {
  const out = buildUpstreamHeaders(
    { 'accept-encoding': 'gzip, deflate, br' },
    { upstreamHost: 'example.com' },
  );
  assert.ok(
    !('accept-encoding' in out),
    '轉送 accept-encoding 會讓 undici 不自動解壓，我們又丟掉 content-encoding → body 變亂碼',
  );
});

test('header 名稱大小寫不影響過濾', () => {
  const out = buildUpstreamHeaders(
    { Connection: 'keep-alive', HOST: 'proxy.local', 'Accept-Encoding': 'gzip' },
    { upstreamHost: 'example.com' },
  );
  assert.equal(out.host, 'example.com');
  assert.ok(!('Connection' in out));
  assert.ok(!('connection' in out));
  assert.ok(!('Accept-Encoding' in out));
});

test('陣列值被攤平成逗號字串（fetch 不吃陣列）', () => {
  const out = buildUpstreamHeaders({ 'x-multi': ['a', 'b'] }, { upstreamHost: 'example.com' });
  assert.equal(out['x-multi'], 'a, b');
});

test('不可變：不修改傳入的 header 物件', () => {
  const input = { host: 'proxy.local', connection: 'keep-alive' };
  buildUpstreamHeaders(input, { upstreamHost: 'example.com' });
  assert.equal(input.host, 'proxy.local');
  assert.equal(input.connection, 'keep-alive');
});

test('CSP 與 X-Frame-Options 一定被丟掉（否則注入的 inspector 會被擋）', () => {
  const out = filterResponseHeaders({
    'content-security-policy': "default-src 'self'",
    'content-security-policy-report-only': "default-src 'self'",
    'x-frame-options': 'DENY',
    'content-type': 'text/html',
  });
  assert.ok(!('content-security-policy' in out));
  assert.ok(!('content-security-policy-report-only' in out));
  assert.ok(!('x-frame-options' in out));
  assert.equal(out['content-type'], 'text/html');
});

test('content-encoding / content-length / transfer-encoding 被丟掉（body 已解壓且可能被改寫）', () => {
  const out = filterResponseHeaders({
    'content-encoding': 'gzip',
    'content-length': '12345',
    'transfer-encoding': 'chunked',
  });
  assert.deepEqual(out, {});
});

test('HSTS 與 COOP/COEP/report-to 被丟掉', () => {
  const out = filterResponseHeaders({
    'strict-transport-security': 'max-age=31536000',
    'report-to': '{"group":"x"}',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  });
  assert.deepEqual(out, {});
});

test('set-cookie 不由這裡處理（交給 cookies.js 逐條 append）', () => {
  const out = filterResponseHeaders({ 'set-cookie': ['a=1'], 'content-type': 'text/html' });
  assert.ok(!('set-cookie' in out), 'set-cookie 必須走專用路徑，不能跟一般 header 混在一起');
});

test('丟棄清單涵蓋規格列出的全部 header', () => {
  for (const name of [
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'strict-transport-security',
    'report-to',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
  ]) {
    assert.ok(DROPPED_RESPONSE_HEADERS.has(name), `${name} 必須在丟棄清單裡`);
  }
});

test('filterResponseHeaders 接受 Headers 物件（fetch 回傳的型別）', () => {
  const headers = new Headers({ 'content-type': 'text/html', 'x-frame-options': 'DENY' });
  const out = filterResponseHeaders(headers);
  assert.equal(out['content-type'], 'text/html');
  assert.ok(!('x-frame-options' in out));
});
