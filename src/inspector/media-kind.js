'use strict';

const { normalizeContentType } = require('../util/body-type');

/**
 * 判斷一個請求是不是媒體、以及是哪一種（規格 §8 的「影片來源候選」）。
 * 副檔名優先、content-type 次之 —— 副檔名比較能分出 hls / dash / 片段。
 */

const EXTENSION_KINDS = {
  m3u8: 'hls',
  mpd: 'dash',
  mp4: 'mp4',
  m4v: 'mp4',
  webm: 'webm',
  mov: 'mp4',
  ts: 'segment',
  m4s: 'segment',
  m4a: 'audio',
  mp3: 'audio',
  aac: 'audio',
};

const CONTENT_TYPE_KINDS = {
  'application/vnd.apple.mpegurl': 'hls',
  'application/x-mpegurl': 'hls',
  'application/dash+xml': 'dash',
  'video/mp2t': 'segment',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** @param {string} url @returns {string|null} */
function extensionOf(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url).split('?')[0];
  }
  const match = pathname.match(/\.([a-z0-9]{1,6})$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {string} url
 * @param {string|null|undefined} contentType
 * @returns {{ isMedia: boolean, kind: string|null, reason: string }}
 */
function classifyMedia(url, contentType) {
  const extension = extensionOf(url);
  if (extension && EXTENSION_KINDS[extension]) {
    return {
      isMedia: true,
      kind: EXTENSION_KINDS[extension],
      reason: `副檔名 .${extension}`,
    };
  }

  const type = normalizeContentType(contentType);
  if (type !== null) {
    if (CONTENT_TYPE_KINDS[type]) {
      return { isMedia: true, kind: CONTENT_TYPE_KINDS[type], reason: `content-type ${type}` };
    }
    if (type.startsWith('video/')) {
      return { isMedia: true, kind: 'video', reason: `content-type ${type}` };
    }
    if (type.startsWith('audio/')) {
      return { isMedia: true, kind: 'audio', reason: `content-type ${type}` };
    }
  }

  return { isMedia: false, kind: null, reason: '' };
}

module.exports = { classifyMedia, extensionOf, EXTENSION_KINDS, CONTENT_TYPE_KINDS };
