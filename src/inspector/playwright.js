'use strict';

/**
 * Playwright 是 optionalDependency（規格 §2）：**沒裝也必須能啟動**。
 *
 * 所以這裡用 try/require 而不是頂層 require —— 一個選用功能的缺席
 * 不該讓整個觀測系統起不來。呼叫端看 `available` 決定要不要回 501。
 */

const HOW_TO_FIX = 'npm i -D playwright && npx playwright install chromium';

/**
 * @returns {{ available: boolean, chromium?: object, error?: string, howToFix: string }}
 */
function loadPlaywright() {
  try {
    // eslint-disable-next-line global-require -- 刻意延後 require：缺席是正常狀態
    const playwright = require('playwright');
    if (!playwright || !playwright.chromium) {
      return {
        available: false,
        error: 'playwright 載入成功但沒有 chromium export',
        howToFix: HOW_TO_FIX,
      };
    }
    return { available: true, chromium: playwright.chromium, howToFix: HOW_TO_FIX };
  } catch (error) {
    return { available: false, error: error.message, howToFix: HOW_TO_FIX };
  }
}

module.exports = { loadPlaywright, HOW_TO_FIX };
