'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 面板的靜態檔投遞。HTML 與 JS 各一支檔案，不是模板字串 ——
 * 這樣編輯器有語法高亮、錯誤行號也對得上（規格 §2：不准有 build step）。
 */

const PANEL_HTML = path.join(__dirname, 'panel.html');
const PANEL_JS = path.join(__dirname, 'panel.js');

/** @param {string} file @param {string} what @returns {string} */
function readOrExplain(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[LocalDevTool] 讀取${what}失敗:`, error.message);
    return '';
  }
}

/** @returns {string} 面板 HTML */
function renderNetworkPanel() {
  const html = readOrExplain(PANEL_HTML, '面板 HTML');
  if (html === '') {
    return '<!doctype html><meta charset="utf-8"><p>LocalDevTool：面板 HTML 讀取失敗，請看伺服器 log。</p>';
  }
  return html;
}

/** @returns {string} 面板前端 JS */
function renderPanelScript() {
  return readOrExplain(PANEL_JS, '面板 JS') || '/* LocalDevTool: panel.js 讀取失敗 */';
}

module.exports = { renderNetworkPanel, renderPanelScript, PANEL_HTML, PANEL_JS };
