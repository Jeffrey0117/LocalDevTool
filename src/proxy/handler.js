'use strict';

const { forwardUpstream } = require('./forward');
const { filterResponseHeaders } = require('./response-headers');
const { rewriteHtml } = require('./html-rewrite');
const { rewriteSetCookie, buildSiteCookie } = require('./cookies');
const { rewriteLocation } = require('./location');
const { buildProxyRecord, persistRecord } = require('./capture');
const { renderUpstreamErrorPage } = require('./error-page');

/** 代理請求 body 的上限。超過就拒絕，避免有人用代理當上傳黑洞把記憶體吃光。 */
const MAX_PROXY_BODY = 25 * 1024 * 1024;

/** @returns {Promise<Buffer>} */
function readRawBody(req, limit = MAX_PROXY_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error(`請求 body 超過 ${limit} bytes 上限`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 3xx 的 location 與每一條 set-cookie 都要改寫。 */
function applyResponseRewrites(res, upstreamHeaders, site) {
  const safeHeaders = filterResponseHeaders(upstreamHeaders);

  if (safeHeaders.location) {
    safeHeaders.location = rewriteLocation(safeHeaders.location, {
      targetOrigin: site.target_origin,
      siteId: site.id,
    });
  }
  res.set(safeHeaders);

  // 多條 set-cookie 必須逐條 append，合併成一條瀏覽器只會認第一個。
  const cookies =
    typeof upstreamHeaders.getSetCookie === 'function' ? upstreamHeaders.getSetCookie() : [];
  for (const cookie of cookies) {
    res.append('set-cookie', rewriteSetCookie(cookie));
  }
}

/**
 * 轉送一個請求並把結果回給瀏覽器，然後（在回應送出後）記錄下來。
 *
 * @param {object} deps { db, config }
 * @param {object} context { req, res, site, pathWithQuery, isMainRoute }
 */
async function proxyRequest(deps, context) {
  const { db, config } = deps;
  const { req, res, site, pathWithQuery, isMainRoute } = context;

  let requestBody = Buffer.alloc(0);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      requestBody = await readRawBody(req);
    }
  } catch (error) {
    res.status(error.code === 'BODY_TOO_LARGE' ? 413 : 400).type('text/plain; charset=utf-8');
    res.send(`無法讀取請求 body：${error.message}`);
    return;
  }

  let upstream;
  try {
    upstream = await forwardUpstream({
      targetOrigin: site.target_origin,
      method: req.method,
      pathWithQuery,
      incomingHeaders: req.headers,
      body: requestBody,
      allowPrivate: config.allowPrivate,
      timeoutMs: config.upstreamTimeoutMs,
    });
  } catch (error) {
    console.error(
      `[LocalDevTool] 代理 ${site.id} ${req.method} ${pathWithQuery} 失敗:`,
      error.cause || error,
    );
    res.status(502).type('text/html; charset=utf-8');
    res.send(
      renderUpstreamErrorPage({
        targetOrigin: site.target_origin,
        requestPath: pathWithQuery,
        reason: error.message,
      }),
    );
    return;
  }

  applyResponseRewrites(res, upstream.headers, site);

  const contentType = upstream.headers.get('content-type') || '';
  const isHtml = contentType.toLowerCase().includes('text/html');
  let responseBody = upstream.bodyBuffer;

  if (isHtml) {
    // 只有 HTML 需要改寫與注入；其他型別一個 byte 都不准動。
    responseBody = Buffer.from(
      rewriteHtml(upstream.bodyBuffer.toString('utf8'), { siteId: site.id }),
      'utf8',
    );
    if (isMainRoute) res.append('set-cookie', buildSiteCookie(site.id));
  }

  res.status(upstream.status);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(responseBody);
  }

  // === 這條線之後的程式碼都不准影響已送出的回應 ===
  setImmediate(() => {
    const record = buildProxyRecord({
      siteId: site.id,
      method: req.method,
      upstreamUrl: upstream.upstreamUrl,
      host: upstream.host,
      path: upstream.path,
      status: upstream.status,
      durationMs: upstream.durationMs,
      reqHeaders: req.headers,
      reqBodyBuffer: requestBody,
      resHeaders: upstream.headers,
      // 記錄上游原始的 body，不是改寫後的 —— 使用者要看的是真實流量。
      resBodyBuffer: upstream.bodyBuffer,
      corrId: req.headers['x-ldt-corr'] || null,
    });
    persistRecord(db, record, {
      captureSecrets: config.captureSecrets,
      bodyCap: config.bodyCap,
    });
  });
}

module.exports = { proxyRequest, readRawBody, MAX_PROXY_BODY };
