'use strict';

const { loadPlaywright: defaultLoader } = require('./playwright');
const { isTextCapturable } = require('../util/body-type');

/**
 * 真正用 Playwright 跑一次觀測（規格 §8）。
 *
 * 這支刻意很薄：它只負責「收集事件」，判斷交給 analyze.js。
 * 這樣分析邏輯可以用 fake 事件流完整測試，不需要在 CI 真的開瀏覽器。
 *
 * 一條硬規則：**瀏覽器一定要在 finally 裡關掉**，含 timeout 與例外路徑 ——
 * 留下孤兒 Chromium 會慢慢把機器的記憶體吃光，而且很難查。
 */

/** 注入頁面的 EME 探針。有呼叫就是 DRM 跡象。 */
const EME_PROBE = `
  window.__LDT_EME__ = [];
  try {
    if (navigator.requestMediaKeySystemAccess) {
      var native = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (keySystem) {
        try { window.__LDT_EME__.push(String(keySystem)); } catch (e) {}
        return native.apply(null, arguments);
      };
    }
  } catch (e) {}
`;

const PLAY_SELECTORS = [
  'button[aria-label*="play" i]',
  'button[title*="play" i]',
  '.vjs-big-play-button',
  '.ytp-large-play-button',
  'button.play',
  '[data-testid*="play" i]',
];

/** @param {object} response @param {number} bodyCap @returns {Promise<string|undefined>} */
async function maybeReadBody(response, bodyCap) {
  const contentType = response.headers()['content-type'];
  if (!isTextCapturable(contentType)) return undefined;
  try {
    const text = await response.text();
    return text.length > bodyCap ? text.slice(0, bodyCap) : text;
  } catch {
    // 3xx、已關閉的連線、被取消的請求都讀不到 body，這是正常的。
    return undefined;
  }
}

/**
 * @param {{ url: string, waitMs?: number, clickPlay?: boolean }} input
 * @param {{ config: object, loadPlaywright?: Function }} deps
 * @returns {Promise<{ url: string, events: object[] }>}
 */
async function runInspection(input, deps) {
  const loader = deps.loadPlaywright || defaultLoader;
  const { available, chromium, error, howToFix } = loader();

  if (!available) {
    const missing = new Error(`Playwright 不可用：${error}`);
    missing.code = 'PLAYWRIGHT_MISSING';
    missing.howToFix = howToFix;
    throw missing;
  }

  const waitMs = Number.isFinite(input.waitMs) ? input.waitMs : deps.config.inspectWaitMs;
  const bodyCap = deps.config.bodyCap;
  const events = [];
  let sequence = 0;

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(EME_PROBE);
    const page = await context.newPage();

    page.on('request', (request) => {
      sequence += 1;
      events.push({
        id: `pw-${sequence}`,
        type: 'request',
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers: request.headers(),
      });
    });

    page.on('requestfailed', (request) => {
      sequence += 1;
      events.push({
        id: `pw-${sequence}`,
        type: 'requestfailed',
        url: request.url(),
        failure: (request.failure() && request.failure().errorText) || '(未知原因)',
      });
    });

    const pending = [];
    page.on('response', (response) => {
      sequence += 1;
      const id = `pw-${sequence}`;
      pending.push(
        maybeReadBody(response, bodyCap).then((body) => {
          events.push({
            id,
            type: 'response',
            url: response.url(),
            status: response.status(),
            headers: response.headers(),
            body,
          });
        }),
      );
    });

    try {
      await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navigationError) {
      events.push({
        id: 'pw-nav',
        type: 'requestfailed',
        url: input.url,
        failure: `導航失敗：${navigationError.message}`,
      });
    }

    await page.waitForTimeout(waitMs);

    if (input.clickPlay === true) {
      for (const selector of PLAY_SELECTORS) {
        try {
          const element = await page.$(selector);
          if (element === null) continue;
          await element.click({ timeout: 2000 });
          await page.waitForTimeout(Math.min(waitMs, 5000));
          break;
        } catch {
          // 點不到就換下一個選擇器；點不到播放鍵不是錯誤。
        }
      }
    }

    try {
      const keySystems = await page.evaluate('window.__LDT_EME__ || []');
      for (const keySystem of keySystems || []) {
        sequence += 1;
        events.push({ id: `pw-${sequence}`, type: 'eme', keySystem });
      }
    } catch {
      // 頁面可能已經導走或被關掉，拿不到探針結果不影響其他觀測。
    }

    await Promise.allSettled(pending);
    return { url: input.url, events };
  } finally {
    if (browser !== null) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[LocalDevTool] 關閉 Chromium 失敗（可能留下孤兒程序）:', closeError.message);
      }
    }
  }
}

module.exports = { runInspection, EME_PROBE, PLAY_SELECTORS };
