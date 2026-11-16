'use strict';

const { randomUUID } = require('node:crypto');

/**
 * 可讀的前綴 + UUID。前綴讓 log 與 DB 一眼看得出這個 id 是什麼東西。
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

/** @param {unknown} value @returns {string} ISO 時間字串，無效輸入回現在 */
function isoNow(value) {
  if (typeof value === 'string' && value !== '') return value;
  return new Date().toISOString();
}

module.exports = { newId, isoNow };
