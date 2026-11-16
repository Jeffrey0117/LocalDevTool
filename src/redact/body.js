'use strict';

const { REDACTED, SENSITIVE_BODY_KEYS } = require('./constants');

/**
 * 遞迴遮蔽機密 key 的值。純函式、回傳新結構。
 *
 * @param {unknown} node
 * @param {{ hit: boolean }} state 累積「有沒有命中」，避免回傳值多包一層
 * @returns {unknown}
 */
function redactNode(node, state) {
  if (Array.isArray(node)) return node.map((item) => redactNode(item, state));

  if (node === null || typeof node !== 'object') return node;

  const entries = Object.entries(node).map(([key, value]) => {
    if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
      state.hit = true;
      return [key, REDACTED];
    }
    return [key, redactNode(value, state)];
  });

  return Object.fromEntries(entries);
}

/**
 * 遮蔽回應 / 請求 body 裡的機密欄位（規格 §5.1）。
 *
 * 只處理「可以解析成 JSON」的 body。不可解析時原樣回傳 ——
 * 規格明文禁止用正則去改 body，因為那會悄悄破壞 HTML / JS / m3u8 等內容，
 * 讓使用者看到的紀錄與真實流量不符。
 *
 * @param {string|null|undefined} text
 * @param {{ captureSecrets?: boolean }} [options]
 * @returns {{ text: string|null|undefined, redacted: boolean }}
 */
function redactBodyText(text, options = {}) {
  if (typeof text !== 'string' || text === '') {
    return { text, redacted: false };
  }
  if (options.captureSecrets === true) {
    return { text, redacted: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不可解析 → 不動它。這是刻意的：寧可少遮也不要破壞內容。
    return { text, redacted: false };
  }

  const state = { hit: false };
  const cleaned = redactNode(parsed, state);
  if (!state.hit) return { text, redacted: false };

  try {
    return { text: JSON.stringify(cleaned), redacted: true };
  } catch (error) {
    // 理論上不會發生（parse 回來的東西一定可以 stringify），但若真的發生，
    // 安全的選擇是整個丟掉 body，不是回傳未遮蔽的原文。
    console.warn('[LocalDevTool] body 遮蔽後序列化失敗，已丟棄 body:', error.message);
    return { text: REDACTED, redacted: true };
  }
}

module.exports = { redactBodyText, SENSITIVE_BODY_KEYS };
