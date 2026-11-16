'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectAuthShape } = require('../src/redact/auth-shape');
const { makeJwt, DEFAULT_HEADER, DEFAULT_PAYLOAD } = require('./helpers/jwt-fixture');

const JWT = makeJwt(DEFAULT_HEADER, DEFAULT_PAYLOAD);

test('bearer:jwt-like — 三段 base64url 且 header 帶 alg', () => {
  const shape = detectAuthShape({
    headers: { authorization: `Bearer ${JWT}` },
    url: 'https://api.example.com/me',
  });
  assert.equal(shape, 'bearer:jwt-like');
});

test('bearer:opaque — Bearer 但不像 JWT', () => {
  const shape = detectAuthShape({
    headers: { authorization: 'Bearer 8f14e45fceea167a5a36dedd4bea2543' },
    url: 'https://api.example.com/me',
  });
  assert.equal(shape, 'bearer:opaque');
});

test('basic', () => {
  const shape = detectAuthShape({
    headers: { authorization: 'Basic am9objpwYXNzd29yZA==' },
    url: 'https://api.example.com/me',
  });
  assert.equal(shape, 'basic');
});

test('cookie:<names> — 只記名稱，不記值', () => {
  const shape = detectAuthShape({
    headers: { cookie: 'sid=secret-session-value; theme=dark; csrf=abc123' },
    url: 'https://api.example.com/me',
  });
  assert.equal(shape, 'cookie:sid,theme,csrf');
  assert.ok(!shape.includes('secret-session-value'));
  assert.ok(!shape.includes('abc123'));
});

test('signed-url — 各種簽章參數都認得', () => {
  const cases = [
    'https://cdn.example.com/v.m3u8?token=abc',
    'https://cdn.example.com/v.m3u8?Expires=123&other=1',
    'https://cdn.example.com/v.m3u8?Signature=xyz',
    'https://cdn.example.com/v.m3u8?Policy=eyJ',
    'https://cdn.example.com/v.m3u8?hdnts=exp=1~hmac=ff',
    'https://cdn.example.com/v.m3u8?X-Amz-Signature=deadbeef',
  ];
  for (const url of cases) {
    assert.equal(detectAuthShape({ headers: {}, url }), 'signed-url', `應判為 signed-url: ${url}`);
  }
});

test('signed-url 參數名比對不分大小寫', () => {
  assert.equal(
    detectAuthShape({ headers: {}, url: 'https://cdn.example.com/v.m3u8?TOKEN=abc' }),
    'signed-url',
  );
});

test('沒有任何授權跡象 → null', () => {
  assert.equal(
    detectAuthShape({ headers: { 'user-agent': 'x' }, url: 'https://example.com/plain.html' }),
    null,
  );
});

test('authorization 優先於 cookie，但兩者都記錄下來', () => {
  const shape = detectAuthShape({
    headers: { authorization: `Bearer ${JWT}`, cookie: 'sid=v' },
    url: 'https://api.example.com/me',
  });
  assert.ok(shape.startsWith('bearer:jwt-like'), '最顯著的形狀排在前面');
  assert.ok(shape.includes('cookie:sid'), 'cookie 形狀不該被丟掉');
});

test('auth_shape 永不包含實際憑證值', () => {
  const shape = detectAuthShape({
    headers: {
      authorization: `Bearer ${JWT}`,
      cookie: 'sid=supersecret; token=anothersecret',
    },
    url: 'https://cdn.example.com/v.m3u8?token=urlsecret&Signature=sigsecret',
  });
  for (const leak of ['supersecret', 'anothersecret', 'urlsecret', 'sigsecret', JWT]) {
    assert.ok(!shape.includes(leak), `auth_shape 不該含 ${leak}`);
  }
});

test('不得出現任何聲稱簽章有效的字串', () => {
  const shape = detectAuthShape({ headers: { authorization: `Bearer ${JWT}` }, url: 'https://x/y' });
  assert.ok(!/valid|有效|verified/i.test(shape));
});

test('壞掉的輸入不炸', () => {
  assert.equal(detectAuthShape({ headers: {}, url: 'not-a-url' }), null);
  assert.equal(detectAuthShape({}), null);
  assert.equal(detectAuthShape({ headers: { authorization: '' }, url: '' }), null);
  assert.equal(detectAuthShape({ headers: { cookie: '   ' }, url: '' }), null);
});

test('未知的 authorization scheme 記成 other', () => {
  const shape = detectAuthShape({ headers: { authorization: 'Negotiate abc' }, url: 'https://x/y' });
  assert.equal(shape, 'other');
});

test('header 名稱大小寫不影響判定', () => {
  assert.equal(
    detectAuthShape({ headers: { Authorization: 'Basic abc' }, url: 'https://x/y' }),
    'basic',
  );
});
