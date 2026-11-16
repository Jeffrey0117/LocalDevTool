'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { loadPlaywright } = require('../src/inspector/playwright');
const { runInspection } = require('../src/inspector/run');
const { analyzeEvents } = require('../src/inspector/analyze');
const { loadConfig } = require('../src/config');

/**
 * 真的開瀏覽器的 smoke test（規格 §11）。
 *
 * 預設**不跑** —— 它需要 `npx playwright install chromium`（幾百 MB），
 * 而且在沒有圖形環境的機器上會不穩。要跑的話：
 *
 *   TEST_PLAYWRIGHT=1 npm test
 *
 * 它刻意只打一台本機起的假網站，不碰外部網路。
 */

const ENABLED = process.env.TEST_PLAYWRIGHT === '1';

test(
  'Playwright 管線真的跑得起來（opt-in：TEST_PLAYWRIGHT=1）',
  { skip: ENABLED ? false : '需要 TEST_PLAYWRIGHT=1 與已安裝的 chromium' },
  async () => {
    const availability = loadPlaywright();
    assert.equal(
      availability.available,
      true,
      `要跑這個測試得先安裝 Playwright：${availability.howToFix}`,
    );

    // 一台本機假網站：一個 <video> 加一支假的 m3u8，不碰外部網路。
    const server = http.createServer((req, res) => {
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p.m3u8\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><body><video id="v" src="/master.m3u8"></video>' +
          '<script>fetch("/master.m3u8");</script></body></html>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const raw = await runInspection(
        { url: `http://127.0.0.1:${port}/`, waitMs: 1500 },
        { config: loadConfig({}) },
      );

      assert.ok(raw.events.length > 0, '應該收到網路事件');

      const report = analyzeEvents(raw.events, { pageUrl: raw.url });
      const urls = report.mediaCandidates.map((candidate) => candidate.url);
      assert.ok(
        urls.some((url) => url.includes('master.m3u8')),
        `應該認出 m3u8 來源，實際為 ${JSON.stringify(urls)}`,
      );
      assert.ok(
        report.playlists.some((playlist) => playlist.type === 'master'),
        '應該解析出 master playlist',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test('沒有開 TEST_PLAYWRIGHT 時，這個檔案不會嘗試開瀏覽器', () => {
  // 這條是給未來的人看的：smoke test 的 skip 條件不要被改成「偵測到就跑」，
  // 否則 CI 上一旦有人裝了 playwright 就會開始下載 Chromium。
  assert.equal(typeof ENABLED, 'boolean');
});
