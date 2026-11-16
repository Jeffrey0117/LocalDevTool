'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactHeaders, SENSITIVE_HEADERS } = require('../src/redact/headers');
const { REDACTED } = require('../src/redact/constants');

const SECRET_COOKIE = 'session=supersecretvalue; theme=dark';
const SECRET_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';

function sampleHeaders() {
  return {
    'content-type': 'application/json',
    cookie: SECRET_COOKIE,
    authorization: SECRET_BEARER,
    'x-api-key': 'ak_live_do_not_store_me',
    'x-auth-token': 'tok_abc',
    'x-csrf-token': 'csrf_abc',
    'api-key': 'plain-api-key',
    'proxy-authorization': 'Basic am9objpwYXNz',
    'user-agent': 'Mozilla/5.0',
  };
}

test('每個清單內的 header 值都被遮蔽成 [REDACTED]', () => {
  const out = redactHeaders(sampleHeaders(), { captureSecrets: false });
  for (const name of SENSITIVE_HEADERS) {
    if (!(name in out)) continue;
    assert.equal(out[name], REDACTED, `${name} 應該被遮蔽`);
  }
});

test('遮蔽後序列化結果不含任何原始機密字串', () => {
  const out = redactHeaders(sampleHeaders(), { captureSecrets: false });
  const serialized = JSON.stringify(out);
  for (const leak of [
    'supersecretvalue',
    'eyJhbGciOiJIUzI1NiJ9',
    'ak_live_do_not_store_me',
    'tok_abc',
    'csrf_abc',
    'plain-api-key',
    'am9objpwYXNz',
  ]) {
    assert.ok(!serialized.includes(leak), `不該洩漏 ${leak}`);
  }
});

test('非機密 header 完好保留', () => {
  const out = redactHeaders(sampleHeaders(), { captureSecrets: false });
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['user-agent'], 'Mozilla/5.0');
});

test('set-cookie 陣列逐條遮蔽但保留條目數', () => {
  const out = redactHeaders(
    { 'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'], 'content-type': 'text/html' },
    { captureSecrets: false },
  );
  assert.deepEqual(out['set-cookie'], [REDACTED, REDACTED]);
  assert.ok(!JSON.stringify(out).includes('a=1'));
});

test('header 名稱大小寫不影響遮蔽', () => {
  const out = redactHeaders(
    { Cookie: SECRET_COOKIE, AUTHORIZATION: SECRET_BEARER, 'X-Api-Key': 'leak' },
    { captureSecrets: false },
  );
  assert.equal(out.Cookie, REDACTED);
  assert.equal(out.AUTHORIZATION, REDACTED);
  assert.equal(out['X-Api-Key'], REDACTED);
});

test('captureSecrets=true 時才保留原值', () => {
  const out = redactHeaders(sampleHeaders(), { captureSecrets: true });
  assert.equal(out.cookie, SECRET_COOKIE);
  assert.equal(out.authorization, SECRET_BEARER);
});

test('預設參數（未傳 options）就是安全的', () => {
  const out = redactHeaders(sampleHeaders());
  assert.equal(out.cookie, REDACTED);
  assert.equal(out.authorization, REDACTED);
});

test('不可變：不修改傳入的物件', () => {
  const input = sampleHeaders();
  redactHeaders(input, { captureSecrets: false });
  assert.equal(input.cookie, SECRET_COOKIE);
});

test('遮蔽清單涵蓋規格 §5.1 全部八個 header', () => {
  for (const name of [
    'cookie',
    'set-cookie',
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'api-key',
  ]) {
    assert.ok(SENSITIVE_HEADERS.has(name), `${name} 必須在遮蔽清單裡`);
  }
});
