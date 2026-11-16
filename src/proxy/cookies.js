'use strict';

/**
 * set-cookie 改寫（規格 §6，同 LocalMonkey §4.3）。
 *
 * 只動屬性段，不動第一段的 `name=value` —— 否則一個值剛好含 "domain" 或 "secure"
 * 字樣的 cookie 會被誤殺。
 */

const SITE_COOKIE = 'ldt_site';

/**
 * @param {string} raw 單一條 set-cookie 的值
 * @returns {string}
 */
function rewriteSetCookie(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw === '') return raw;

  const [nameValue, ...attributes] = raw.split(';');

  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => {
      const lower = attribute.toLowerCase();
      if (lower.startsWith('domain=')) return false; // 網域不符會讓瀏覽器直接丟掉 cookie
      if (lower === 'secure') return false; // 本機是 http
      if (lower.startsWith('samesite=')) return false; // 統一改成 Lax
      return attribute !== '';
    });

  return [nameValue.trim(), ...kept, 'SameSite=Lax'].join('; ');
}

/**
 * 代理主路由回 HTML 時用來記住「現在在逛哪個 site」，
 * 讓根絕對路徑的資源請求（/assets/app.js）找得到歸屬。
 * @param {string} siteId
 * @returns {string}
 */
function buildSiteCookie(siteId) {
  return `${SITE_COOKIE}=${encodeURIComponent(siteId)}; Path=/; SameSite=Lax`;
}

module.exports = { rewriteSetCookie, buildSiteCookie, SITE_COOKIE };
