'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTextCapturable, normalizeContentType } = require('../src/util/body-type');

test('規格 §5.3 列出的文字類型都可擷取', () => {
  for (const type of [
    'application/json',
    'text/html',
    'text/plain',
    'text/css',
    'application/xml',
    'application/javascript',
    'application/vnd.apple.mpegurl',
    'application/dash+xml',
  ]) {
    assert.equal(isTextCapturable(type), true, `${type} 應該可擷取`);
  }
});

test('binary 類型不可擷取', () => {
  for (const type of [
    'image/png',
    'image/jpeg',
    'video/mp4',
    'video/mp2t',
    'audio/mpeg',
    'application/octet-stream',
    'font/woff2',
    'application/pdf',
    'application/zip',
  ]) {
    assert.equal(isTextCapturable(type), false, `${type} 不該被擷取`);
  }
});

test('帶 charset 參數仍正確判定', () => {
  assert.equal(isTextCapturable('application/json; charset=utf-8'), true);
  assert.equal(isTextCapturable('text/html;charset=UTF-8'), true);
  assert.equal(isTextCapturable('image/png; name=x'), false);
});

test('大小寫與前後空白不影響判定', () => {
  assert.equal(isTextCapturable('  APPLICATION/JSON  '), true);
  assert.equal(isTextCapturable('TEXT/HTML'), true);
});

test('+json / +xml 後綴視為文字（application/problem+json 這類）', () => {
  assert.equal(isTextCapturable('application/problem+json'), true);
  assert.equal(isTextCapturable('application/atom+xml'), true);
});

test('缺少 content-type 時不擷取（寧可少存也不要存到 binary）', () => {
  assert.equal(isTextCapturable(undefined), false);
  assert.equal(isTextCapturable(null), false);
  assert.equal(isTextCapturable(''), false);
});

test('normalizeContentType 去掉參數並轉小寫', () => {
  assert.equal(normalizeContentType('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(normalizeContentType(null), null);
  assert.equal(normalizeContentType(''), null);
});
