'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactBodyText, SENSITIVE_BODY_KEYS } = require('../src/redact/body');
const { REDACTED } = require('../src/redact/constants');

test('JSON body 裡的 access_token 被遮蔽，其他欄位完好', () => {
  const body = JSON.stringify({
    access_token: 'ya29.super-secret-token',
    token_type: 'Bearer',
    expires_in: 3600,
    user: { id: 42, display_name: 'Jeff' },
  });
  const out = redactBodyText(body, { captureSecrets: false });
  const parsed = JSON.parse(out.text);

  assert.equal(parsed.access_token, REDACTED);
  assert.equal(parsed.token_type, 'Bearer');
  assert.equal(parsed.expires_in, 3600);
  assert.deepEqual(parsed.user, { id: 42, display_name: 'Jeff' });
  assert.ok(!out.text.includes('ya29.super-secret-token'));
  assert.equal(out.redacted, true);
});

test('規格 §5.1 列出的六個 body key 全部被遮蔽', () => {
  const secrets = {
    access_token: 'AAA-access',
    refresh_token: 'BBB-refresh',
    id_token: 'CCC-id',
    password: 'DDD-password',
    secret: 'EEE-secret',
    client_secret: 'FFF-client-secret',
  };
  const out = redactBodyText(JSON.stringify(secrets), { captureSecrets: false });
  const parsed = JSON.parse(out.text);

  for (const key of Object.keys(secrets)) {
    assert.equal(parsed[key], REDACTED, `${key} 應該被遮蔽`);
    assert.ok(!out.text.includes(secrets[key]), `不該洩漏 ${key} 的值`);
  }
  for (const key of Object.keys(secrets)) {
    assert.ok(SENSITIVE_BODY_KEYS.has(key), `${key} 必須在清單裡`);
  }
});

test('巢狀物件與陣列裡的機密也被遮蔽', () => {
  const body = JSON.stringify({
    data: {
      sessions: [
        { id: 1, refresh_token: 'nested-leak-1' },
        { id: 2, refresh_token: 'nested-leak-2' },
      ],
      config: { client_secret: 'deep-leak' },
    },
  });
  const out = redactBodyText(body, { captureSecrets: false });

  assert.ok(!out.text.includes('nested-leak-1'));
  assert.ok(!out.text.includes('nested-leak-2'));
  assert.ok(!out.text.includes('deep-leak'));
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.data.sessions[0].refresh_token, REDACTED);
  assert.equal(parsed.data.sessions[0].id, 1);
  assert.equal(parsed.data.config.client_secret, REDACTED);
});

test('key 比對不分大小寫', () => {
  const out = redactBodyText(JSON.stringify({ Access_Token: 'x-leak', PASSWORD: 'y-leak' }), {
    captureSecrets: false,
  });
  assert.ok(!out.text.includes('x-leak'));
  assert.ok(!out.text.includes('y-leak'));
});

test('不可解析的 body 原樣保留、不被破壞', () => {
  const notJson = '<!doctype html><html><body>access_token looks like text here</body></html>';
  const out = redactBodyText(notJson, { captureSecrets: false });
  assert.equal(out.text, notJson, '不可解析的 body 不准被正則亂改');
  assert.equal(out.redacted, false);
});

test('不可解析但含機密字樣的片段也不被改（規格明文禁止正則改 body）', () => {
  const broken = '{"access_token": "truncated-secret';
  const out = redactBodyText(broken, { captureSecrets: false });
  assert.equal(out.text, broken);
  assert.equal(out.redacted, false);
});

test('沒有機密 key 的 JSON 回報 redacted=false', () => {
  const body = JSON.stringify({ items: [1, 2, 3], ok: true });
  const out = redactBodyText(body, { captureSecrets: false });
  assert.equal(out.redacted, false);
  assert.deepEqual(JSON.parse(out.text), { items: [1, 2, 3], ok: true });
});

test('captureSecrets=true 時原值保留', () => {
  const body = JSON.stringify({ access_token: 'keep-me-please' });
  const out = redactBodyText(body, { captureSecrets: true });
  assert.ok(out.text.includes('keep-me-please'));
  assert.equal(out.redacted, false);
});

test('預設參數（未傳 options）就是安全的', () => {
  const out = redactBodyText(JSON.stringify({ password: 'default-leak' }));
  assert.ok(!out.text.includes('default-leak'));
});

test('null / 空字串輸入不炸', () => {
  assert.equal(redactBodyText(null).text, null);
  assert.equal(redactBodyText('').text, '');
  assert.equal(redactBodyText(undefined).text, undefined);
});

test('JSON 頂層是陣列也能處理', () => {
  const out = redactBodyText(JSON.stringify([{ password: 'arr-leak' }]), {});
  assert.ok(!out.text.includes('arr-leak'));
  assert.equal(JSON.parse(out.text)[0].password, REDACTED);
});

test('JSON 頂層是純量（合法 JSON）不被破壞', () => {
  assert.equal(redactBodyText('"just a string"', {}).text, '"just a string"');
  assert.equal(redactBodyText('123', {}).text, '123');
});
