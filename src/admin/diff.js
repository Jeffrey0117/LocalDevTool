'use strict';

/**
 * 零依賴行級 diff（規格 §9 的「比較同一支 API 不同時間的回應」）。
 *
 * 用標準的 LCS 動態規劃。LCS 是 O(n*m)，所以對行數設上限 ——
 * 一個 20 萬行的回應會讓面板卡死，寧可降級成「只比前 N 行」並說一聲。
 */

// LCS 表是 (n+1)*(m+1) 個 Uint32 → 2000 行約 16MB，還能接受；
// 再往上走記憶體與時間都會開始咬人。
const MAX_LINES = 2000;

/** @param {unknown} text @returns {string[]} */
function toLines(text) {
  if (typeof text !== 'string') return [''];
  return text.split(/\r\n|\n|\r/);
}

/**
 * @param {string} before
 * @param {string} after
 * @returns {Array<{ type: 'same'|'add'|'del', text: string }>}
 */
function lineDiff(before, after) {
  let a = toLines(before);
  let b = toLines(after);

  let truncated = false;
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    a = a.slice(0, MAX_LINES);
    b = b.slice(0, MAX_LINES);
    truncated = true;
  }

  // lengths[i][j] = a[i..] 與 b[j..] 的最長共同子序列長度
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      result.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    result.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    result.push({ type: 'add', text: b[j] });
    j += 1;
  }

  if (truncated) {
    result.push({ type: 'same', text: `… 只比較了前 ${MAX_LINES} 行（內容太長）` });
  }
  return result;
}

const MARKERS = { same: ' ', add: '+', del: '-' };

/**
 * @param {Array<{type: string, text: string}>} diff
 * @returns {string} unified 風格的純文字
 */
function formatDiff(diff) {
  return diff.map((part) => `${MARKERS[part.type] || '?'}${part.text}`).join('\n');
}

module.exports = { lineDiff, formatDiff, MAX_LINES };
