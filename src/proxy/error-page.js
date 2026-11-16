'use strict';

/**
 * 上游失敗時的 502 頁面（規格 §6 / LocalMonkey §4.4）。
 * 要是人看得懂的頁面，不是一句「代理請求失敗」；但也不准洩漏堆疊。
 */

/** @param {string} value @returns {string} */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LIKELY_CAUSES = [
  '目標網站本身掛了或正在維護',
  '網域打錯、或 DNS 解析不到',
  '目標只在內網可達（本工具預設擋私網，需要時設 LOCALDEVTOOL_ALLOW_PRIVATE=1）',
  '目標擋掉了非瀏覽器來源的請求',
  '網路或防火牆把連線掐掉了',
];

/**
 * @param {{ targetOrigin: string, requestPath: string, reason: string }} input
 * @returns {string} HTML
 */
function renderUpstreamErrorPage(input) {
  const causes = LIKELY_CAUSES.map((cause) => `<li>${escapeHtml(cause)}</li>`).join('\n      ');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>502 — 上游沒有回應</title>
  <style>
    body { font: 15px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 42rem;
           margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.35rem; margin-bottom: .25rem; }
    code { background: #ececec; padding: .15em .4em; border-radius: 3px; word-break: break-all; }
    .reason { border-left: 3px solid #c0392b; padding: .6rem .9rem; background: #fff;
              margin: 1.2rem 0; }
    ul { padding-left: 1.3rem; }
    footer { margin-top: 2rem; color: #666; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>502 — 代理連不上目標網站</h1>
  <p>LocalDevTool 轉送這個請求時，上游沒有給出回應。</p>
  <p><strong>目標：</strong> <code>${escapeHtml(input.targetOrigin)}${escapeHtml(input.requestPath)}</code></p>
  <div class="reason"><strong>錯誤原因：</strong> ${escapeHtml(input.reason)}</div>
  <p><strong>常見原因：</strong></p>
  <ul>
      ${causes}
  </ul>
  <footer>
    這是代理本身回的頁面，不是目標網站的內容。完整錯誤已寫進伺服器 log。
  </footer>
</body>
</html>`;
}

/**
 * @param {{ requestPath: string, hint: string }} input
 * @returns {string} HTML
 */
function renderSiteNotFoundPage(input) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>404 — 找不到對應的 site</title>
  <style>
    body { font: 15px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 42rem;
           margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; background: #fafafa; }
    code { background: #ececec; padding: .15em .4em; border-radius: 3px; word-break: break-all; }
  </style>
</head>
<body>
  <h1>404 — 這個路徑沒有對應的 site</h1>
  <p><code>${escapeHtml(input.requestPath)}</code></p>
  <p>${escapeHtml(input.hint)}</p>
  <p>刻意回 404 而不是 502：502 會讓人以為代理壞了，但其實只是不知道這個請求屬於哪個 site。</p>
  <p>到 <a href="/admin/network">/admin/network</a> 看已登記的 site，或直接從 <code>/p/&lt;siteId&gt;/</code> 開始瀏覽。</p>
</body>
</html>`;
}

module.exports = { renderUpstreamErrorPage, renderSiteNotFoundPage, escapeHtml };
