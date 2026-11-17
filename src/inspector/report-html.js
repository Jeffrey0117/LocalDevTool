'use strict';

const { escapeHtml } = require('../proxy/error-page');

/**
 * Inspect 報告的 HTML 呈現（規格 §8）。
 *
 * 刻意長得像**證據表**而不是結論：每一列都帶信心等級與支撐它的請求 id，
 * 讓看報告的人可以自己判斷我們憑什麼這樣說。
 */

const CONFIDENCE_LABEL = {
  confirmed: '✔ confirmed（直接觀察到）',
  likely: '~ likely（推測）',
  unknown: '? unknown（資料不足）',
};

const STYLE = `
  body { font: 14px/1.7 ui-monospace, Menlo, Consolas, monospace; background: #14161a;
         color: #e6e6e6; max-width: 70rem; margin: 0 auto; padding: 24px; }
  h1 { font-size: 18px; color: #7fb3d9; }
  h2 { font-size: 14px; color: #8fb9d9; margin-top: 28px; border-bottom: 1px solid #2c3139;
       padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #23272e;
           vertical-align: top; word-break: break-all; }
  th { color: #8b93a1; font-weight: 600; }
  .conf-confirmed { color: #7fb37f; } .conf-likely { color: #d9a05b; }
  .conf-unknown { color: #8b93a1; }
  .verdict { border-left: 3px solid #7fb3d9; background: #1b1e24; padding: 10px 14px; margin: 14px 0; }
  .verdict.drm-protected { border-color: #d97f7f; }
  .verdict.needs-login { border-color: #d9a05b; }
  .verdict.no-media { border-color: #8b93a1; }
  .muted { color: #8b93a1; }
  code { background: #22262d; padding: 1px 4px; border-radius: 3px; }
  footer { margin-top: 32px; color: #8b93a1; font-size: 12px; border-top: 1px solid #2c3139;
           padding-top: 12px; }
`;

/** @param {string} value @returns {string} */
function confidenceCell(value) {
  const label = CONFIDENCE_LABEL[value] || value || '';
  return `<td class="conf-${escapeHtml(value || 'unknown')}">${escapeHtml(label)}</td>`;
}

/**
 * @param {string} title
 * @param {string[]} columns
 * @param {object[]} rows
 * @param {(row: object) => string[]} cells
 * @returns {string}
 */
function section(title, columns, rows, cells) {
  if (!rows || rows.length === 0) {
    return `<h2>${escapeHtml(title)}</h2><p class="muted">（沒有觀察到）</p>`;
  }
  const head = [...columns, '信心', '證據'].map((name) => `<th>${escapeHtml(name)}</th>`).join('');
  const body = rows
    .map((row) => {
      const values = cells(row).map((value) => `<td>${value}</td>`).join('');
      return `<tr>${values}${confidenceCell(row.confidence)}<td class="muted">${escapeHtml(
        row.evidence || '',
      )}</td></tr>`;
    })
    .join('');
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * @param {object} job 佇列裡的 job 快照
 * @returns {string} HTML
 */
function renderInspectReport(job) {
  const report = job.result;

  if (!report) {
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
      <title>Inspect 報告 ${escapeHtml(job.id)}</title><style>${STYLE}</style></head><body>
      <h1>Inspect 報告</h1>
      <p>狀態：<code>${escapeHtml(job.status)}</code></p>
      ${job.error ? `<div class="verdict drm-protected">失敗原因：${escapeHtml(job.error)}</div>` : ''}
      ${job.howToFix ? `<p>修復方式：<code>${escapeHtml(job.howToFix)}</code></p>` : ''}
      <p class="muted">還在跑的話，重新整理這一頁就會看到結果。</p>
      </body></html>`;
  }

  const playlistRows = report.playlists.map((playlist) => ({
    ...playlist,
    variantText: playlist.variants
      .map((variant) => `${variant.resolution || '?'} @ ${variant.bandwidth || '?'}`)
      .join('、'),
  }));

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inspect 報告 — ${escapeHtml(report.pageUrl || job.id)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>Inspect 報告（Playwright 管線）</h1>
  <p>
    目標：<code>${escapeHtml(report.pageUrl || '')}</code><br>
    產生時間：${escapeHtml(report.generatedAt)}　事件數：${escapeHtml(report.eventCount)}
  </p>

  <div class="verdict ${escapeHtml(report.verdict.status)}">
    <strong>判定：${escapeHtml(report.verdict.status)}</strong><br>
    ${escapeHtml(report.verdict.message)}
  </div>

  ${section('影片來源候選', ['URL', '種類', 'content-type', '請求 id'], report.mediaCandidates, (row) => [
    escapeHtml(row.url),
    escapeHtml(row.kind),
    escapeHtml(row.contentType || ''),
    escapeHtml((row.requestIds || []).join(', ')),
  ])}

  ${section('HLS playlist 解析', ['URL', '類型', '變體', '加密'], playlistRows, (row) => [
    escapeHtml(row.url),
    escapeHtml(row.type),
    escapeHtml(row.variantText || `${row.segmentCount} 個片段`),
    row.encrypted ? `是（${escapeHtml(row.keyMethod)}）` : '否',
  ])}

  ${section('給出影片網址的 API', ['URL', 'status', '命中的媒體網址'], report.relatedApis, (row) => [
    escapeHtml(row.url),
    escapeHtml(row.status),
    // 先逐條轉義再用 <br> 串 —— 反過來做會把分隔符自己也轉義掉，
    // 多個網址就會印出字面的「<br>」而不是換行。
    (row.mediaUrls || []).map(escapeHtml).join('<br>'),
  ])}

  ${section('授權線索（只記形狀，憑證本身沒有被保存）', ['URL', 'auth_shape', 'Set-Cookie 名稱', '簽章參數'], report.authClues, (row) => [
    escapeHtml(row.url),
    escapeHtml(row.authShape || '（無）'),
    escapeHtml((row.setCookieNames || []).join(', ')),
    escapeHtml((row.signedUrlParams || []).join(', ')),
  ])}

  <h2>DRM 跡象</h2>
  ${
    report.drm.detected
      ? `<p>偵測到保護機制${
          report.drm.keySystems.length > 0
            ? `（keySystem：<code>${escapeHtml(report.drm.keySystems.join(', '))}</code>）`
            : ''
        }。<strong>本工具不解密受保護的內容。</strong></p>
         <ul>${report.drm.signals.map((signal) => `<li>${escapeHtml(signal)}</li>`).join('')}</ul>`
      : '<p class="muted">（沒有觀察到 DRM 跡象）</p>'
  }

  ${section('失敗的請求', ['URL', '原因'], report.failures, (row) => [
    escapeHtml(row.url),
    escapeHtml(row.failure),
  ])}

  <footer>
    ${escapeHtml(report.note)}<br>
    這份報告描述的是觀察到的 HTTP 行為。它不是內容的使用授權，
    也請只對自己擁有或已獲授權測試的網站使用。
  </footer>
</body>
</html>`;
}

module.exports = { renderInspectReport, CONFIDENCE_LABEL };
