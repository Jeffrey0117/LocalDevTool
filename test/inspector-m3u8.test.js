'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseM3u8, isM3u8Url } = require('../src/inspector/m3u8');

const MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360
360p/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXT-X-ENDLIST
`;

const ENCRYPTED_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x00000000000000000000000000000000
#EXTINF:9.009,
seg0.ts
`;

test('master playlist 被認出來，變體清單完整', () => {
  const result = parseM3u8(MASTER, 'https://cdn.example.com/video/master.m3u8');

  assert.equal(result.valid, true);
  assert.equal(result.type, 'master');
  assert.equal(result.variants.length, 3);

  const top = result.variants.find((v) => v.resolution === '1920x1080');
  assert.equal(top.bandwidth, 2560000);
  assert.equal(top.url, 'https://cdn.example.com/video/1080p/index.m3u8');
  assert.match(top.codecs, /avc1/);
});

test('變體的相對 URI 以 playlist 自己的位置解析', () => {
  const result = parseM3u8(MASTER, 'https://cdn.example.com/a/b/master.m3u8');
  assert.equal(result.variants[0].url, 'https://cdn.example.com/a/b/720p/index.m3u8');
});

test('沒有 base URL 時保留原始 URI（不要亂猜）', () => {
  const result = parseM3u8(MASTER, null);
  assert.equal(result.variants[0].url, '720p/index.m3u8');
});

test('media playlist 被認出來，含片段數', () => {
  const result = parseM3u8(MEDIA, 'https://cdn.example.com/v/index.m3u8');
  assert.equal(result.type, 'media');
  assert.equal(result.segmentCount, 2);
  assert.deepEqual(result.variants, []);
});

test('#EXT-X-KEY（METHOD 不是 NONE）→ 標記為加密', () => {
  const result = parseM3u8(ENCRYPTED_MEDIA, 'https://cdn.example.com/v/index.m3u8');
  assert.equal(result.encrypted, true);
  assert.equal(result.keyMethod, 'AES-128');
  assert.equal(result.keyUris[0], 'https://keys.example.com/k1');
});

test('METHOD=NONE 不算加密', () => {
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nseg.ts\n';
  const result = parseM3u8(text, null);
  assert.equal(result.encrypted, false);
});

test('沒有 #EXT-X-KEY 就不是加密', () => {
  assert.equal(parseM3u8(MEDIA, null).encrypted, false);
});

test('不是 m3u8 的內容回 valid:false，不假裝解析成功', () => {
  for (const text of ['<html></html>', '', '{"json":true}', null, undefined]) {
    const result = parseM3u8(text, null);
    assert.equal(result.valid, false, `${JSON.stringify(text)} 不該被當成 m3u8`);
  }
});

test('前後有空白 / BOM 的 #EXTM3U 仍認得', () => {
  assert.equal(parseM3u8('﻿#EXTM3U\n#EXTINF:1,\na.ts\n', null).valid, true);
  assert.equal(parseM3u8('  #EXTM3U\n#EXTINF:1,\na.ts\n', null).valid, true);
});

test('只有 #EXTM3U 沒有內容 → valid 但 type unknown', () => {
  const result = parseM3u8('#EXTM3U\n', null);
  assert.equal(result.valid, true);
  assert.equal(result.type, 'unknown');
});

test('CRLF 換行也能解析', () => {
  const result = parseM3u8(MASTER.replace(/\n/g, '\r\n'), 'https://cdn.example.com/m.m3u8');
  assert.equal(result.variants.length, 3);
  assert.equal(result.variants[0].resolution, '1280x720');
});

test('壞掉的 STREAM-INF（後面沒有 URI 行）不會炸', () => {
  const result = parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n', null);
  assert.equal(result.valid, true);
  assert.deepEqual(result.variants, []);
});

test('isM3u8Url 依副檔名判斷', () => {
  assert.equal(isM3u8Url('https://cdn/v/master.m3u8'), true);
  assert.equal(isM3u8Url('https://cdn/v/master.m3u8?token=x'), true);
  assert.equal(isM3u8Url('https://cdn/v/master.M3U8'), true);
  assert.equal(isM3u8Url('https://cdn/v/video.mp4'), false);
  assert.equal(isM3u8Url(null), false);
});
