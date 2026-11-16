'use strict';

const { classifyMedia } = require('./media-kind');
const { parseM3u8, isM3u8Url } = require('./m3u8');
const { detectAuthShape } = require('../redact/auth-shape');
const { SIGNED_URL_PARAMS } = require('../redact/constants');

/**
 * 把一串網路事件變成一份**證據表**（規格 §8）。
 *
 * 報告格式的核心原則：每一項都標信心等級並附上支撐它的請求 id。
 * 這是一個觀測工具，不是一個會下結論的黑盒子 —— 使用者要能自己判斷我們憑什麼這樣說。
 *
 * 另一條底線：遇到 DRM 就誠實說「受保護，無法分析內容」。不解密。
 */

const CONFIDENCE = { CONFIRMED: 'confirmed', LIKELY: 'likely', UNKNOWN: 'unknown' };

const DRM_URL_PATTERN = /widevine|playready|fairplay|licen[cs]e|\/drm\//i;

/** @param {unknown} headers @param {string} name @returns {string|null} */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value.join('; ') : String(value);
  }
  return null;
}

/** set-cookie 只取名稱，不取值（規格 §5.2）。 */
function cookieNames(headers) {
  const raw = headerValue(headers, 'set-cookie');
  if (raw === null) return [];
  return raw
    .split(/,(?=[^;]+=)/)
    .map((cookie) => cookie.split('=')[0].trim())
    .filter((name) => name !== '');
}

/** 回傳命中的簽章參數「名稱」，不含值。 */
function signedUrlParams(url) {
  try {
    const names = [];
    for (const key of new URL(url).searchParams.keys()) {
      if (SIGNED_URL_PARAMS.has(key.toLowerCase())) names.push(key);
    }
    return names;
  } catch {
    return [];
  }
}

/** 把事件依 url 合併成「請求 + 回應」的配對，方便後續分析。 */
function pairEvents(events) {
  const requests = new Map();
  const responses = new Map();
  const failures = [];
  const emeEvents = [];

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue;
    if (typeof event.url !== 'string' && event.type !== 'eme') continue;

    if (event.type === 'request') requests.set(event.url, event);
    else if (event.type === 'response') responses.set(event.url, event);
    else if (event.type === 'requestfailed') failures.push(event);
    else if (event.type === 'eme') emeEvents.push(event);
  }

  return { requests, responses, failures, emeEvents };
}

/** 影片來源候選。 */
function collectMediaCandidates(requests, responses) {
  const candidates = [];

  for (const [url, request] of requests.entries()) {
    const response = responses.get(url);
    const contentType = response ? headerValue(response.headers, 'content-type') : null;
    const verdict = classifyMedia(url, contentType);
    if (!verdict.isMedia) continue;

    candidates.push({
      url,
      kind: verdict.kind,
      contentType,
      status: response ? response.status : null,
      requestIds: [request.id].filter((id) => id !== undefined),
      confidence: CONFIDENCE.CONFIRMED,
      evidence: `觀察到這個請求（判定依據：${verdict.reason}）`,
    });
  }

  return candidates;
}

/** 解析抓到的 m3u8 內容。 */
function collectPlaylists(responses) {
  const playlists = [];

  for (const [url, response] of responses.entries()) {
    if (!isM3u8Url(url) || typeof response.body !== 'string') continue;
    const parsed = parseM3u8(response.body, url);
    if (!parsed.valid) continue;

    playlists.push({
      url,
      type: parsed.type,
      variants: parsed.variants,
      segmentCount: parsed.segmentCount,
      encrypted: parsed.encrypted,
      keyMethod: parsed.keyMethod,
      keyUris: parsed.keyUris,
      confidence: CONFIDENCE.CONFIRMED,
      evidence: `抓到並成功解析這份 playlist（${parsed.type}）`,
    });
  }

  return playlists;
}

/** 哪支 API 的回應內容裡出現了媒體 URL —— 這就是「誰給出影片網址」。 */
function collectRelatedApis(responses, mediaUrls) {
  const mediaSet = new Set(mediaUrls);
  const related = [];

  for (const [url, response] of responses.entries()) {
    if (typeof response.body !== 'string' || response.body === '') continue;
    if (mediaSet.has(url)) continue; // 媒體請求自己不算「給出網址的人」

    const found = mediaUrls.filter((mediaUrl) => response.body.includes(mediaUrl));
    if (found.length === 0) continue;

    related.push({
      url,
      method: response.method || 'GET',
      status: response.status,
      mediaUrls: found,
      requestIds: [response.id].filter((id) => id !== undefined),
      confidence: CONFIDENCE.CONFIRMED,
      evidence: `這支的回應內容裡含有媒體網址：${found[0]}`,
    });
  }

  return related;
}

/** 授權線索：只記形狀（規格 §5.2），憑證本身永不進報告。 */
function collectAuthClues(requests, responses) {
  const byUrl = new Map();

  const ensure = (url) => {
    if (!byUrl.has(url)) {
      byUrl.set(url, {
        url,
        authShape: null,
        setCookieNames: [],
        signedUrlParams: signedUrlParams(url),
        confidence: CONFIDENCE.CONFIRMED,
        evidence: '直接觀察到的請求 / 回應標頭',
      });
    }
    return byUrl.get(url);
  };

  for (const [url, request] of requests.entries()) {
    const shape = detectAuthShape({ headers: request.headers || {}, url });
    const params = signedUrlParams(url);
    if (shape === null && params.length === 0) continue;
    byUrl.set(url, { ...ensure(url), authShape: shape, signedUrlParams: params });
  }

  for (const [url, response] of responses.entries()) {
    const names = cookieNames(response.headers);
    if (names.length === 0) continue;
    byUrl.set(url, { ...ensure(url), setCookieNames: names });
  }

  return [...byUrl.values()];
}

/** DRM 跡象。偵測到就誠實報告，不嘗試處理受保護的內容。 */
function collectDrm(requests, responses, emeEvents, playlists) {
  const signals = [];
  const keySystems = [];

  for (const event of emeEvents) {
    const keySystem = String(event.keySystem || '(未知)');
    keySystems.push(keySystem);
    signals.push(`頁面呼叫了 requestMediaKeySystemAccess('${keySystem}') —— 這是 EME 的明確跡象`);
  }

  for (const url of new Set([...requests.keys(), ...responses.keys()])) {
    if (DRM_URL_PATTERN.test(url)) {
      signals.push(`請求網址看起來與授權機制有關：${url}`);
    }
  }

  for (const playlist of playlists) {
    if (!playlist.encrypted) continue;
    signals.push(`playlist 帶 #EXT-X-KEY（METHOD=${playlist.keyMethod}）→ 片段是加密的：${playlist.url}`);
  }

  return { detected: signals.length > 0, keySystems: [...new Set(keySystems)], signals };
}

/** 為什麼失敗 —— 規格 §8 特別強調這段要說得清楚。 */
function decideVerdict({ drm, responses, mediaCandidates }) {
  if (drm.detected) {
    return {
      status: 'drm-protected',
      message:
        '受 DRM 保護（偵測到 EME 或加密跡象）。本工具不解密，只告訴你保護機制長什麼樣子。' +
        '內容本身無法分析。',
    };
  }

  const statuses = [...responses.values()];
  const unauthorized = statuses.find(
    (response) => response.status === 401 || response.status === 403,
  );
  const loginRedirect = statuses.find((response) => {
    if (!(response.status >= 300 && response.status < 400)) return false;
    const location = headerValue(response.headers, 'location') || '';
    return /login|signin|sign-in|auth/i.test(location);
  });

  if (unauthorized || loginRedirect) {
    const reason = unauthorized
      ? `有請求回 ${unauthorized.status}（${unauthorized.url}）`
      : `有請求被導向登入頁（${loginRedirect.url}）`;
    return {
      status: 'needs-login',
      message: `需要登入狀態才能分析：${reason}。本工具不代為登入，也不繞過付費牆。`,
    };
  }

  if (mediaCandidates.length === 0) {
    return {
      status: 'no-media',
      message:
        '未觀察到媒體請求。可能需要互動（按播放鍵）或登入才會載入，' +
        '也可能這個頁面根本沒有媒體。試試 clickPlay 或加長 waitMs。',
    };
  }

  return {
    status: 'ok',
    message: `觀察到 ${mediaCandidates.length} 個媒體請求候選。`,
  };
}

/**
 * @param {unknown[]} events
 * @param {{ pageUrl?: string, waitMs?: number }} [context]
 * @returns {object} 證據表
 */
function analyzeEvents(events, context = {}) {
  const { requests, responses, failures, emeEvents } = pairEvents(events);

  const mediaCandidates = collectMediaCandidates(requests, responses);
  const playlists = collectPlaylists(responses);
  const relatedApis = collectRelatedApis(
    responses,
    mediaCandidates.map((candidate) => candidate.url),
  );
  const authClues = collectAuthClues(requests, responses);
  const drm = collectDrm(requests, responses, emeEvents, playlists);

  return {
    pageUrl: context.pageUrl || null,
    generatedAt: new Date().toISOString(),
    eventCount: Array.isArray(events) ? events.length : 0,
    mediaCandidates,
    playlists,
    relatedApis,
    authClues,
    drm,
    failures: failures.map((event) => ({
      url: event.url,
      failure: String(event.failure || '(未知原因)'),
      confidence: CONFIDENCE.CONFIRMED,
      evidence: 'Playwright 回報 requestfailed',
    })),
    verdict: decideVerdict({ drm, responses, mediaCandidates }),
    note:
      'confirmed = 直接觀察到；likely = 推測；unknown = 資料不足。' +
      '這份報告只描述觀察到的 HTTP 行為，不代表任何內容的使用授權。',
  };
}

module.exports = { analyzeEvents, CONFIDENCE };
