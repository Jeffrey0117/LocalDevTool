'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrivateAddress,
  isBlockedHostname,
  assertSafeTarget,
} = require('../src/net/ssrf');

test('IPv4 私網 / loopback / link-local 被判定為私有', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 應該被判為私有`);
  }
});

test('IPv4 公網位址不被誤判', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '11.0.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 不該被判為私有`);
  }
});

test('IPv6 loopback / ULA / link-local 被判定為私有', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::ABCD']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 應該被判為私有`);
  }
});

test('IPv6 公網位址不被誤判', () => {
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 不該被判為私有`);
  }
});

test('IPv4-mapped IPv6 也要穿透檢查（::ffff:127.0.0.1 是 loopback）', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
});

test('IPv4-mapped 的十六進位寫法也要穿透（::ffff:7f00:1 就是 127.0.0.1）', () => {
  // 同一個位址有兩種文字形式。只認帶點的那種，另一種就會被當成公網放行。
  for (const ip of [
    '::ffff:7f00:1', // 127.0.0.1
    '0:0:0:0:0:ffff:7f00:1', // 同上，未壓縮
    '::ffff:a9fe:a9fe', // 169.254.169.254 雲端 metadata
    '::ffff:c0a8:1', // 192.168.0.1
    '::FFFF:7F00:1', // 大寫
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 應該被判為私有`);
  }
  // 公網位址用十六進位寫也還是公網，不要過度封鎖。
  assert.equal(isPrivateAddress('::ffff:808:808'), false, '::ffff:8.8.8.8 不該被判為私有');
});

test('NAT64 的 well-known prefix（64:ff9b::/96）包著私網位址時也要擋', () => {
  assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true, 'NAT64 包 127.0.0.1');
  assert.equal(isPrivateAddress('64:ff9b::a9fe:a9fe'), true, 'NAT64 包 169.254.169.254');
  assert.equal(isPrivateAddress('64:ff9b::808:808'), false, 'NAT64 包 8.8.8.8 → 公網');
});

test('壞掉的輸入保守地當成私有（寧可擋錯也不要放行未知）', () => {
  for (const bad of ['', 'not-an-ip', null, undefined, '999.999.999.999']) {
    assert.equal(isPrivateAddress(bad), true, `${bad} 無法判定時應保守擋下`);
  }
});

test('metadata.google.internal 這類主機名直接封鎖', () => {
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('METADATA.GOOGLE.INTERNAL'), true);
  assert.equal(isBlockedHostname('metadata'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});

test('assertSafeTarget：解析到公網位址 → 放行並回傳位址', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const result = await assertSafeTarget('https://example.com', { allowPrivate: false, lookup });
  assert.deepEqual(result.addresses, ['93.184.216.34']);
});

test('assertSafeTarget：解析到私網位址 → 拒絕，訊息說得清楚', async () => {
  const lookup = async () => [{ address: '192.168.1.5', family: 4 }];
  await assert.rejects(
    () => assertSafeTarget('https://internal.example.com', { allowPrivate: false, lookup }),
    (error) => {
      assert.match(error.message, /私有|私網/);
      assert.match(error.message, /192\.168\.1\.5/);
      assert.equal(error.code, 'SSRF_BLOCKED');
      return true;
    },
  );
});

test('assertSafeTarget：多筆解析結果中只要有一個是私網就拒絕（DNS rebinding）', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(
    () => assertSafeTarget('https://rebind.example.com', { allowPrivate: false, lookup }),
    /SSRF|私/,
  );
});

test('assertSafeTarget：allowPrivate=1 時放行私網（代理自己的 dev server）', async () => {
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const result = await assertSafeTarget('http://localhost:3000', { allowPrivate: true, lookup });
  assert.deepEqual(result.addresses, ['127.0.0.1']);
});

test('assertSafeTarget：allowPrivate 也不放行 metadata 主機名', async () => {
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    () => assertSafeTarget('http://metadata.google.internal/x', { allowPrivate: true, lookup }),
    /封鎖|blocked/i,
  );
});

test('assertSafeTarget：非 http(s) 協定被拒', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  for (const url of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x']) {
    await assert.rejects(() => assertSafeTarget(url, { allowPrivate: false, lookup }), /http/i);
  }
});

test('assertSafeTarget：不是合法 URL 被拒', async () => {
  await assert.rejects(() => assertSafeTarget('nonsense', { lookup: async () => [] }), /URL|origin/i);
});

test('assertSafeTarget：DNS 查不到時拒絕且訊息可讀', async () => {
  const lookup = async () => {
    const error = new Error('getaddrinfo ENOTFOUND nope.invalid');
    error.code = 'ENOTFOUND';
    throw error;
  };
  await assert.rejects(
    () => assertSafeTarget('https://nope.invalid', { allowPrivate: false, lookup }),
    /DNS|解析/,
  );
});

test('assertSafeTarget：解析結果為空時拒絕（不能當成放行）', async () => {
  await assert.rejects(
    () => assertSafeTarget('https://empty.example.com', { allowPrivate: false, lookup: async () => [] }),
    /解析/,
  );
});
