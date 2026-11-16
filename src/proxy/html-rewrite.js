'use strict';

/**
 * HTML 改寫與 inspector 注入（規格 §6 + §7.1）。
 *
 * 改寫刻意**只認屬性**（`src=` / `href=` / `action=` / `poster=` / `srcset=`），
 * 不認「裸引號後面接單一斜線」。後者會把 inline script 裡的 `fetch("/api/x")`
 * 一起改掉，弄壞原站的 JS 邏輯 —— 觀測工具把被觀測的站改壞是最糟的失敗模式。
 */

const INSPECTOR_PATH = '/__ldt/inspector.js';

const ATTR_PATTERN = /(\s(?:src|href|action|poster)\s*=\s*)(["'])(\/[^"'>]*)\2/gi;
const SRCSET_PATTERN = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const BODY_CLOSE_PATTERN = /<\/body\s*>/i;

/** @param {string} value @returns {string} */
function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 這個根絕對路徑該不該改寫？
 * @param {string} urlPath
 * @param {string} siteId
 * @returns {boolean}
 */
function shouldRewrite(urlPath, siteId) {
  if (!urlPath.startsWith('/')) return false;
  if (urlPath.startsWith('//')) return false; // protocol-relative = 跨網域，不碰
  if (urlPath.startsWith('/__ldt/')) return false; // 我們自己的端點
  if (urlPath === `/p/${siteId}` || urlPath.startsWith(`/p/${siteId}/`)) return false; // 已改寫過
  return true;
}

/** @param {string} value srcset 屬性值 @param {string} siteId @returns {string} */
function rewriteSrcset(value, siteId) {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === '') return trimmed;
      const spaceAt = trimmed.search(/\s/);
      const url = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
      const descriptor = spaceAt === -1 ? '' : trimmed.slice(spaceAt);
      if (!shouldRewrite(url, siteId)) return trimmed;
      return `/p/${siteId}${url}${descriptor}`;
    })
    .join(', ');
}

/**
 * 把根絕對路徑改成 /p/<siteId>/...
 * @param {string} html
 * @param {string} siteId
 * @returns {string}
 */
function rewriteRootAbsolutePaths(html, siteId) {
  if (typeof html !== 'string') return html;

  return html
    .replace(SRCSET_PATTERN, (match, prefix, quote, value) => {
      return `${prefix}${quote}${rewriteSrcset(value, siteId)}${quote}`;
    })
    .replace(ATTR_PATTERN, (match, prefix, quote, urlPath) => {
      if (!shouldRewrite(urlPath, siteId)) return match;
      return `${prefix}${quote}/p/${siteId}${urlPath}${quote}`;
    });
}

/**
 * 注入 inspector。用 `<script src>` 而不是內嵌程式碼 ——
 * 可被瀏覽器快取、錯誤行號正確、也不會被 HTML 轉義搞爛。
 * @param {string} html
 * @param {string} siteId
 * @returns {string}
 */
function injectInspector(html, siteId) {
  const tag =
    `<script src="${INSPECTOR_PATH}" data-ldt-site="${escapeAttribute(siteId)}" defer></script>`;

  if (BODY_CLOSE_PATTERN.test(html)) {
    // 非 global regex → 只換第一個 </body>，不會重複注入。
    return html.replace(BODY_CLOSE_PATTERN, (match) => `${tag}${match}`);
  }
  return `${html}${tag}`;
}

/**
 * @param {string} html
 * @param {{ siteId: string }} options
 * @returns {string}
 */
function rewriteHtml(html, options) {
  const source = typeof html === 'string' ? html : '';
  return injectInspector(rewriteRootAbsolutePaths(source, options.siteId), options.siteId);
}

module.exports = {
  rewriteHtml,
  rewriteRootAbsolutePaths,
  injectInspector,
  shouldRewrite,
  INSPECTOR_PATH,
};
