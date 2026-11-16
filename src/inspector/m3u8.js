'use strict';

/**
 * HLS playlist 解析（規格 §8）。
 *
 * 要回答的問題：這是 master 還是 media playlist、有哪些畫質變體、有沒有加密。
 * 刻意只做「讀懂」—— 不下載片段、不解密、不拼接。
 */

/** @param {unknown} url @returns {boolean} */
function isM3u8Url(url) {
  if (typeof url !== 'string') return false;
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return /\.m3u8(\?|$)/i.test(url);
  }
}

/** `BANDWIDTH=1280000,CODECS="a,b",RESOLUTION=1x2` → 物件（要尊重引號裡的逗號）。 */
function parseAttributes(line) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match = pattern.exec(line);
  while (match !== null) {
    attributes[match[1]] = match[3] !== undefined ? match[3] : match[2];
    match = pattern.exec(line);
  }
  return attributes;
}

/** @param {string} uri @param {string|null} baseUrl @returns {string} */
function resolveUri(uri, baseUrl) {
  if (!baseUrl) return uri; // 沒有 base 就別亂猜，原樣回報
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return uri;
  }
}

/**
 * @param {unknown} text playlist 內容
 * @param {string|null} baseUrl playlist 自己的 URL（用來解析相對路徑）
 * @returns {{
 *   valid: boolean, type: 'master'|'media'|'unknown',
 *   variants: Array<{ url: string, bandwidth: number|null, resolution: string|null, codecs: string|null }>,
 *   segmentCount: number, encrypted: boolean, keyMethod: string|null, keyUris: string[]
 * }}
 */
function parseM3u8(text, baseUrl) {
  const empty = {
    valid: false,
    type: 'unknown',
    variants: [],
    segmentCount: 0,
    encrypted: false,
    keyMethod: null,
    keyUris: [],
  };

  if (typeof text !== 'string') return empty;
  // 去掉 BOM 與前置空白後必須以 #EXTM3U 開頭，否則不是 playlist。
  const normalized = text.replace(/^﻿/, '').trimStart();
  if (!normalized.startsWith('#EXTM3U')) return empty;

  const lines = normalized.split(/\r\n|\n|\r/);
  const variants = [];
  const keyUris = [];
  let segmentCount = 0;
  let keyMethod = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // 變體的 URI 在下一個非註解、非空的行。
      let next = index + 1;
      while (next < lines.length && (lines[next].trim() === '' || lines[next].trim().startsWith('#'))) {
        next += 1;
      }
      if (next >= lines.length) continue; // 壞掉的 playlist，跳過而不是炸掉

      const attributes = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      variants.push({
        url: resolveUri(lines[next].trim(), baseUrl),
        bandwidth: attributes.BANDWIDTH ? Number(attributes.BANDWIDTH) : null,
        resolution: attributes.RESOLUTION || null,
        codecs: attributes.CODECS || null,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (attributes.METHOD && attributes.METHOD.toUpperCase() !== 'NONE') {
        keyMethod = attributes.METHOD;
        if (attributes.URI) keyUris.push(resolveUri(attributes.URI, baseUrl));
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) segmentCount += 1;
  }

  const type = variants.length > 0 ? 'master' : segmentCount > 0 ? 'media' : 'unknown';

  return {
    valid: true,
    type,
    variants,
    segmentCount,
    encrypted: keyMethod !== null,
    keyMethod,
    keyUris,
  };
}

module.exports = { parseM3u8, isM3u8Url, parseAttributes };
