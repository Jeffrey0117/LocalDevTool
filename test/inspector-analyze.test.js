'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeEvents, CONFIDENCE } = require('../src/inspector/analyze');

/**
 * 規格 §11：Playwright 的測試用 fake 事件流（不在 CI 真的開瀏覽器）。
 * 這些事件的形狀就是 src/inspector/run.js 從 Playwright 收集出來的形狀。
 */

function requestEvent(id, url, extra = {}) {
  return { id, type: 'request', method: 'GET', url, resourceType: 'xhr', headers: {}, ...extra };
}

function responseEvent(id, url, extra = {}) {
  return { id, type: 'response', url, status: 200, headers: {}, ...extra };
}

const PAGE = 'https://example.com/watch/42';
const HLS = 'https://cdn.example.com/v/abc123/master.m3u8?token=sig';

test('依副檔名與 content-type 認出影片來源候選', () => {
  const report = analyzeEvents(
    [
      requestEvent('r1', HLS),
      responseEvent('r1', HLS, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
      requestEvent('r2', 'https://cdn.example.com/v/seg001.ts'),
      responseEvent('r2', 'https://cdn.example.com/v/seg001.ts', {
        headers: { 'content-type': 'video/mp2t' },
      }),
      requestEvent('r3', 'https://cdn.example.com/trailer.mp4'),
      responseEvent('r3', 'https://cdn.example.com/trailer.mp4', {
        headers: { 'content-type': 'video/mp4' },
      }),
      requestEvent('r4', 'https://example.com/style.css'),
      responseEvent('r4', 'https://example.com/style.css', {
        headers: { 'content-type': 'text/css' },
      }),
    ],
    { pageUrl: PAGE },
  );

  const urls = report.mediaCandidates.map((c) => c.url);
  assert.ok(urls.includes(HLS));
  assert.ok(urls.includes('https://cdn.example.com/v/seg001.ts'));
  assert.ok(urls.includes('https://cdn.example.com/trailer.mp4'));
  assert.ok(!urls.includes('https://example.com/style.css'), 'CSS 不是媒體');

  const hls = report.mediaCandidates.find((c) => c.url === HLS);
  assert.equal(hls.kind, 'hls');
  assert.deepEqual(hls.requestIds, ['r1']);
});

test('DASH 的 .mpd 也認得', () => {
  const report = analyzeEvents(
    [
      requestEvent('r1', 'https://cdn/v/manifest.mpd'),
      responseEvent('r1', 'https://cdn/v/manifest.mpd', {
        headers: { 'content-type': 'application/dash+xml' },
      }),
    ],
    { pageUrl: PAGE },
  );
  assert.equal(report.mediaCandidates[0].kind, 'dash');
});

test('m3u8 內容被解析：master、變體清單、加密標記', () => {
  const master =
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p.m3u8\n';
  const report = analyzeEvents(
    [
      requestEvent('r1', HLS),
      responseEvent('r1', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body: master,
      }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.playlists.length, 1);
  assert.equal(report.playlists[0].type, 'master');
  assert.equal(report.playlists[0].variants.length, 1);
  assert.equal(report.playlists[0].encrypted, false);
});

test('#EXT-X-KEY 讓 playlist 標成加密，並算入 DRM 跡象', () => {
  const encrypted = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k/1"\n#EXTINF:1,\na.ts\n';
  const report = analyzeEvents(
    [
      requestEvent('r1', HLS),
      responseEvent('r1', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body: encrypted,
      }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.playlists[0].encrypted, true);
  assert.ok(report.drm.signals.some((s) => /EXT-X-KEY/.test(s)));
});

test('回應 body 裡含媒體 URL → 標成「這支 API 給出了影片網址」且為 confirmed', () => {
  const report = analyzeEvents(
    [
      requestEvent('api', 'https://example.com/api/playback/42'),
      responseEvent('api', 'https://example.com/api/playback/42', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [{ src: HLS }] }),
      }),
      requestEvent('media', HLS),
      responseEvent('media', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.relatedApis.length, 1);
  assert.equal(report.relatedApis[0].url, 'https://example.com/api/playback/42');
  assert.equal(report.relatedApis[0].confidence, CONFIDENCE.CONFIRMED);
  assert.ok(report.relatedApis[0].evidence.includes(HLS.slice(0, 30)));
  assert.deepEqual(report.relatedApis[0].mediaUrls, [HLS]);
});

test('媒體請求自己不會被當成「給出網址的 API」', () => {
  const report = analyzeEvents(
    [
      requestEvent('media', HLS),
      responseEvent('media', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body: `#EXTM3U\n${HLS}\n`,
      }),
    ],
    { pageUrl: PAGE },
  );
  assert.equal(report.relatedApis.length, 0);
});

test('授權線索：只記形狀，不記憑證本身', () => {
  const report = analyzeEvents(
    [
      requestEvent('api', 'https://example.com/api/me', {
        headers: { authorization: 'Bearer super-secret-token-value' },
      }),
      responseEvent('api', 'https://example.com/api/me', {
        headers: { 'set-cookie': 'sid=secret-session; Path=/' },
      }),
      requestEvent('media', HLS),
      responseEvent('media', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    ],
    { pageUrl: PAGE },
  );

  const clue = report.authClues.find((c) => c.url === 'https://example.com/api/me');
  assert.equal(clue.authShape, 'bearer:opaque');
  assert.deepEqual(clue.setCookieNames, ['sid']);

  const dump = JSON.stringify(report);
  assert.ok(!dump.includes('super-secret-token-value'), '不准洩漏 token');
  assert.ok(!dump.includes('secret-session'), '不准洩漏 cookie 值');
});

test('簽章網址的參數被標出來（但不含值）', () => {
  const report = analyzeEvents(
    [
      requestEvent('media', 'https://cdn/v.m3u8?token=leak&Expires=123&Signature=leak2'),
      responseEvent('media', 'https://cdn/v.m3u8?token=leak&Expires=123&Signature=leak2', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    ],
    { pageUrl: PAGE },
  );

  const clue = report.authClues.find((c) => c.signedUrlParams && c.signedUrlParams.length > 0);
  assert.ok(clue, '應該要有簽章網址線索');
  assert.deepEqual(clue.signedUrlParams.sort(), ['Expires', 'Signature', 'token'].sort());

  // signedUrlParams 本身只能有「參數名」，不能有值。
  for (const name of clue.signedUrlParams) {
    assert.ok(!name.includes('leak'), `${name} 夾帶了參數值`);
    assert.ok(!name.includes('='), `${name} 看起來是整段 key=value`);
  }

  // 注意：`clue.url` 是完整網址，**本來就含簽章值** —— 那是被觀測資源的身分，
  // 也正是「這個影片怎麼授權的」這個問題的答案。遮掉它等於廢掉本工具的核心功能。
  // 這個取捨在 README 的資料敏感度段落有明確說明。
  assert.ok(clue.url.includes('Signature=leak2'), '完整網址要保留，使用者就是要看這個');
});

test('EME 呼叫 → DRM 跡象，verdict 為 drm-protected', () => {
  const report = analyzeEvents(
    [
      { id: 'eme1', type: 'eme', keySystem: 'com.widevine.alpha' },
      requestEvent('media', 'https://cdn/v.mpd'),
      responseEvent('media', 'https://cdn/v.mpd', {
        headers: { 'content-type': 'application/dash+xml' },
      }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.drm.detected, true);
  assert.ok(report.drm.keySystems.includes('com.widevine.alpha'));
  assert.equal(report.verdict.status, 'drm-protected');
  assert.match(report.verdict.message, /DRM/);
  assert.match(report.verdict.message, /不解密/);
});

test('licence 端點與 widevine 字樣也算 DRM 跡象', () => {
  const report = analyzeEvents(
    [
      requestEvent('lic', 'https://example.com/widevine/license'),
      responseEvent('lic', 'https://example.com/widevine/license'),
    ],
    { pageUrl: PAGE },
  );
  assert.equal(report.drm.detected, true);
  assert.ok(report.drm.signals.some((s) => /license|widevine/i.test(s)));
});

test('沒有媒體請求 → verdict 說明可能需要互動或登入', () => {
  const report = analyzeEvents(
    [
      requestEvent('page', PAGE, { resourceType: 'document' }),
      responseEvent('page', PAGE, { headers: { 'content-type': 'text/html' } }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.verdict.status, 'no-media');
  assert.match(report.verdict.message, /未觀察到媒體請求/);
  assert.match(report.verdict.message, /互動|登入/);
});

test('401 / 403 → verdict 說需要登入狀態', () => {
  const report = analyzeEvents(
    [
      requestEvent('api', 'https://example.com/api/playback'),
      responseEvent('api', 'https://example.com/api/playback', { status: 401 }),
    ],
    { pageUrl: PAGE },
  );

  assert.equal(report.verdict.status, 'needs-login');
  assert.match(report.verdict.message, /登入/);
});

test('登入導向也算需要登入', () => {
  const report = analyzeEvents(
    [
      requestEvent('page', PAGE, { resourceType: 'document' }),
      responseEvent('page', PAGE, { status: 302, headers: { location: 'https://example.com/login' } }),
    ],
    { pageUrl: PAGE },
  );
  assert.equal(report.verdict.status, 'needs-login');
});

test('requestfailed 事件被記進 failures', () => {
  const report = analyzeEvents(
    [
      requestEvent('r1', 'https://cdn/v.m3u8'),
      { id: 'r1', type: 'requestfailed', url: 'https://cdn/v.m3u8', failure: 'net::ERR_FAILED' },
    ],
    { pageUrl: PAGE },
  );
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].failure, /ERR_FAILED/);
});

test('每一項都帶 confidence，而且只用三個允許的值', () => {
  const report = analyzeEvents(
    [
      requestEvent('api', 'https://example.com/api/x'),
      responseEvent('api', 'https://example.com/api/x', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ u: HLS }),
      }),
      requestEvent('media', HLS),
      responseEvent('media', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    ],
    { pageUrl: PAGE },
  );

  const allowed = new Set(Object.values(CONFIDENCE));
  const items = [...report.mediaCandidates, ...report.relatedApis, ...report.authClues];
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(allowed.has(item.confidence), `${item.confidence} 不是允許的 confidence`);
    assert.ok(typeof item.evidence === 'string' && item.evidence !== '', '每項都要有證據說明');
  }
});

test('報告不含任何聲稱「已繞過」或「已解密」的字樣', () => {
  const report = analyzeEvents(
    [
      { id: 'eme1', type: 'eme', keySystem: 'com.widevine.alpha' },
      requestEvent('media', HLS),
      responseEvent('media', HLS, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    ],
    { pageUrl: PAGE },
  );
  const dump = JSON.stringify(report);
  for (const forbidden of [/已解密/, /繞過/, /decrypted/i, /bypass/i]) {
    assert.ok(!forbidden.test(dump), `報告不該出現 ${forbidden}`);
  }
});

test('空事件流不炸', () => {
  const report = analyzeEvents([], { pageUrl: PAGE });
  assert.deepEqual(report.mediaCandidates, []);
  assert.equal(report.verdict.status, 'no-media');
});

test('壞掉的事件被跳過而不是讓整份報告失敗', () => {
  const report = analyzeEvents([null, undefined, 42, {}, { type: 'request' }], { pageUrl: PAGE });
  assert.ok(Array.isArray(report.mediaCandidates));
});
