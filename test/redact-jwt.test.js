'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeJwt, decodeJwtSafe } = require('../src/redact/jwt');
const { makeJwt, DEFAULT_HEADER, DEFAULT_PAYLOAD } = require('./helpers/jwt-fixture');

const JWT = makeJwt(DEFAULT_HEADER, DEFAULT_PAYLOAD);

test('looksLikeJwt：三段 base64url 且 header 帶 alg → true', () => {
  assert.equal(looksLikeJwt(JWT), true);
});

test('looksLikeJwt：段數不對 → false', () => {
  assert.equal(looksLikeJwt('onlyonesegment'), false);
  assert.equal(looksLikeJwt('two.segments'), false);
  assert.equal(looksLikeJwt('a.b.c.d'), false);
});

test('looksLikeJwt：三段但第一段不是帶 alg 的 JSON → false', () => {
  assert.equal(looksLikeJwt('abc.def.ghi'), false);
  const noAlg = makeJwt({ typ: 'JWT' }, { a: 1 });
  assert.equal(looksLikeJwt(noAlg), false);
});

test('looksLikeJwt：非字串不炸', () => {
  assert.equal(looksLikeJwt(null), false);
  assert.equal(looksLikeJwt(undefined), false);
  assert.equal(looksLikeJwt(42), false);
});

test('decodeJwtSafe 只呈現 alg / typ / iss / exp / iat', () => {
  const out = decodeJwtSafe(JWT);
  assert.equal(out.alg, 'HS256');
  assert.equal(out.typ, 'JWT');
  assert.equal(out.iss, 'https://issuer.example.com');
  assert.equal(out.exp, 1800000000);
  assert.equal(out.iat, 1799999000);
});

test('decodeJwtSafe 列出 claim 名稱但不含值', () => {
  const out = decodeJwtSafe(JWT);
  assert.ok(Array.isArray(out.claims));
  for (const name of ['sub', 'email', 'name', 'iss', 'aud', 'exp', 'iat', 'role']) {
    assert.ok(out.claims.includes(name), `claims 應該列出 ${name}`);
  }
});

test('decodeJwtSafe 絕不洩漏 payload 個資（sub / email / name / role 的值）', () => {
  const serialized = JSON.stringify(decodeJwtSafe(JWT));
  for (const pii of ['user-abc-123', 'victim@example.com', 'Real Person', 'admin']) {
    assert.ok(!serialized.includes(pii), `不該洩漏個資 ${pii}`);
  }
});

test('decodeJwtSafe 不洩漏簽章段', () => {
  const serialized = JSON.stringify(decodeJwtSafe(JWT));
  assert.ok(!serialized.includes('ZmFrZS1zaWduYXR1cmU'));
});

test('decodeJwtSafe 的措辭保守：明確標示未驗證簽章', () => {
  const out = decodeJwtSafe(JWT);
  assert.equal(out.signatureVerified, false);
  assert.match(out.note, /未驗證簽章/);
});

test('decodeJwtSafe 輸出不得出現任何聲稱簽章有效的字串', () => {
  const serialized = JSON.stringify(decodeJwtSafe(JWT));
  const forbidden = [
    /簽章有效/,
    /簽章正確/,
    /已驗證簽章/,
    /signature\s+(is\s+)?valid/i,
    /valid\s+signature/i,
    /verified\s+signature/i,
    /signatureVerified"\s*:\s*true/i,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(serialized), `輸出不該出現 ${pattern}`);
  }
});

test('decodeJwtSafe：非 JWT 回 null', () => {
  assert.equal(decodeJwtSafe('not.a.jwt'), null);
  assert.equal(decodeJwtSafe(''), null);
  assert.equal(decodeJwtSafe(null), null);
});

test('decodeJwtSafe：payload 不是 JSON 時仍回 header 資訊、claims 為空', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const token = `${header}.%%%notbase64json%%%.sig`;
  const out = decodeJwtSafe(token);
  assert.equal(out.alg, 'RS256');
  assert.deepEqual(out.claims, []);
});

test('decodeJwtSafe：缺少 iss/exp/iat 時為 null 而非炸掉', () => {
  const out = decodeJwtSafe(makeJwt({ alg: 'none' }, { foo: 'bar' }));
  assert.equal(out.alg, 'none');
  assert.equal(out.iss, null);
  assert.equal(out.exp, null);
  assert.deepEqual(out.claims, ['foo']);
});
