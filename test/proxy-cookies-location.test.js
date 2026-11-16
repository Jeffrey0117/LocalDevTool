'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteSetCookie } = require('../src/proxy/cookies');
const { rewriteLocation } = require('../src/proxy/location');

test('Domain= 被拿掉（否則瀏覽器會因為網域不符而丟掉 cookie）', () => {
  const out = rewriteSetCookie('sid=abc; Domain=.example.com; Path=/; HttpOnly');
  assert.ok(!/domain=/i.test(out));
  assert.ok(out.includes('sid=abc'));
  assert.ok(/HttpOnly/i.test(out));
});

test('Secure 被拿掉（本機是 http）', () => {
  const out = rewriteSetCookie('sid=abc; Path=/; Secure; HttpOnly');
  assert.ok(!/(^|;)\s*secure\s*(;|$)/i.test(out));
  assert.ok(/HttpOnly/i.test(out));
});

test('SameSite 改成 Lax（原本是 None 也要改）', () => {
  assert.match(rewriteSetCookie('sid=abc; SameSite=None; Secure'), /SameSite=Lax/i);
  assert.match(rewriteSetCookie('sid=abc; SameSite=Strict'), /SameSite=Lax/i);
});

test('原本沒有 SameSite 時補上 Lax', () => {
  assert.match(rewriteSetCookie('sid=abc; Path=/'), /SameSite=Lax/i);
});

test('只出現一次 SameSite', () => {
  const out = rewriteSetCookie('sid=abc; SameSite=None');
  assert.equal(out.toLowerCase().split('samesite').length - 1, 1);
});

test('其他屬性（Path / Max-Age / Expires / HttpOnly）原樣保留', () => {
  const out = rewriteSetCookie(
    'sid=abc; Path=/app; Max-Age=3600; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly',
  );
  assert.ok(out.includes('Path=/app'));
  assert.ok(out.includes('Max-Age=3600'));
  assert.ok(out.includes('Expires=Wed, 21 Oct 2026 07:28:00 GMT'));
  assert.ok(out.includes('HttpOnly'));
});

test('cookie 值裡含 secure/domain 字樣不會被誤殺', () => {
  const out = rewriteSetCookie('pref=domain-secure-value; Path=/');
  assert.ok(out.includes('pref=domain-secure-value'));
});

test('壞掉的輸入不炸', () => {
  assert.equal(typeof rewriteSetCookie(''), 'string');
  assert.equal(rewriteSetCookie(null), null);
});

test('3xx location 指向 target_origin → 改寫成 /p/<siteId>/...', () => {
  const out = rewriteLocation('https://example.com/after-login?x=1#frag', {
    targetOrigin: 'https://example.com',
    siteId: 'demo',
  });
  assert.equal(out, '/p/demo/after-login?x=1#frag');
});

test('3xx location 指向別的網域 → 原樣保留', () => {
  const url = 'https://other.example.org/elsewhere';
  assert.equal(rewriteLocation(url, { targetOrigin: 'https://example.com', siteId: 'demo' }), url);
});

test('target_origin 根路徑的 redirect 改寫成 /p/<siteId>/', () => {
  const out = rewriteLocation('https://example.com/', {
    targetOrigin: 'https://example.com',
    siteId: 'demo',
  });
  assert.equal(out, '/p/demo/');
});

test('根絕對路徑的相對 redirect 也改寫（否則會打到代理根路徑）', () => {
  const out = rewriteLocation('/login', { targetOrigin: 'https://example.com', siteId: 'demo' });
  assert.equal(out, '/p/demo/login');
});

test('已經是 /p/<siteId>/ 的 location 不重複加前綴', () => {
  const out = rewriteLocation('/p/demo/login', {
    targetOrigin: 'https://example.com',
    siteId: 'demo',
  });
  assert.equal(out, '/p/demo/login');
});

test('相對（非根）redirect 原樣保留', () => {
  assert.equal(
    rewriteLocation('next-page.html', { targetOrigin: 'https://example.com', siteId: 'demo' }),
    'next-page.html',
  );
});

test('port 不同就是不同 origin，不改寫', () => {
  const url = 'https://example.com:8443/x';
  assert.equal(rewriteLocation(url, { targetOrigin: 'https://example.com', siteId: 'demo' }), url);
});

test('壞掉的 location 不炸', () => {
  const opts = { targetOrigin: 'https://example.com', siteId: 'demo' };
  assert.equal(rewriteLocation(null, opts), null);
  assert.equal(rewriteLocation('', opts), '');
  assert.equal(rewriteLocation('http://[bad', opts), 'http://[bad');
});
