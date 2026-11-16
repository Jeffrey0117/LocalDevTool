'use strict';

/**
 * 「已開啟但還沒關掉」的資源登記表。
 *
 * ## 為什麼需要這個東西
 *
 * node:test 會等 event loop 清空才結束程序。測試裡起的 http server 與 SQLite handle
 * 如果沒關，整個測試程序就**掛住不退出** —— 不是失敗、不是逾時訊息，是毫無輸出地卡死。
 *
 * 原本每個測試都是在斷言**之後**才 `await harness.close()`。那在測試通過時沒問題，
 * 但斷言一失敗就會跳過那一行 —— 而清理機制恰恰只在失敗時才真的重要。
 *
 * 實際後果（2026-11-16 實測）：照 CLAUDE.md 的退化驗證流程把 redact/headers.js 的
 * 遮蔽判斷改成 `if (true)`，再跑完整 `npm test` → **10 分鐘零輸出後逾時**，
 * 完全看不到是哪些測試抓到了。等於專案自己訂的「故意弄壞來驗證測試有效」紀律被廢掉。
 *
 * ## 怎麼用
 *
 * 每個會起資源的測試檔，在最上面加一行：
 *
 *     const { closeAllOpen } = require('./helpers/open-resources');
 *     after(closeAllOpen);
 *
 * `after()` 在斷言失敗後照樣會跑，所以失敗時也會清乾淨，套件會「快速失敗」而不是掛住。
 * 測試內原本的 `await x.close()` 可以留著（close 是 idempotent 的），
 * 它讓每個測試之間彼此隔離，而 after 只是失敗時的安全網。
 */

/** @type {Set<() => Promise<void>>} */
const open = new Set();

/**
 * 把一個資源的關閉函式登記進來，回傳包裝過的 idempotent 版本。
 *
 * @param {() => Promise<void>|void} closeFn
 * @returns {() => Promise<void>} 可以安全重複呼叫
 */
function track(closeFn) {
  let closed = false;

  const idempotentClose = async () => {
    if (closed) return;
    closed = true;
    open.delete(idempotentClose);
    await closeFn();
  };

  open.add(idempotentClose);
  return idempotentClose;
}

/**
 * 關掉所有還開著的資源。失敗不往外丟 —— 清理階段再炸會蓋掉真正的測試失敗訊息，
 * 那會讓人去追錯的方向。
 */
async function closeAllOpen() {
  const pending = [...open];
  for (const close of pending) {
    try {
      await close();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[test cleanup] 關閉資源時出錯（不影響測試結果）:', error.message);
    }
  }
}

/** 目前還開著幾個資源。只給 open-resources 自己的測試用。 */
function openCount() {
  return open.size;
}

module.exports = { track, closeAllOpen, openCount };
