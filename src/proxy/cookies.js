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
 *
 * **HttpOnly 是安全邊界，不是裝飾。** 這個 cookie 是 `/__ldt/*` 判斷
 * 「這個上報屬於哪個 site」的第一順位依據（site-resolver.js：cookie > Referer）。
 * 少了 HttpOnly，站 A 的被代理頁面只要 `document.cookie = 'ldt_site=站B'`
 * 就能讀到站 B 的 trace 摘要 —— events/routes.js 想守的 site 隔離等於沒有。
 * 伺服器端是唯一的讀者（沒有任何前端程式碼讀它），所以加上去零風險。
 *
 * @param {string} siteId
 * @returns {string}
 */
function buildSiteCookie(siteId) {
  return `${SITE_COOKIE}=${encodeURIComponent(siteId)}; Path=/; SameSite=Lax; HttpOnly`;
}

module.exports = { rewriteSetCookie, buildSiteCookie, SITE_COOKIE };
