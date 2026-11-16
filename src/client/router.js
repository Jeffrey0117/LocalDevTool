'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/**
 * 投遞注入用的 inspector.js（規格 §7.1）。
 *
 * 用 `<script src>` 而不是內嵌，所以這支要能被瀏覽器正常快取 ——
 * 但 `no-cache` 讓改完立刻生效比快取重要（開發工具的本質）。
 */

const INSPECTOR_FILE = path.join(__dirname, 'inspector.js');

/** @returns {import('express').Router} */
function createClientRouter() {
  const router = express.Router();

  router.get('/__ldt/inspector.js', (req, res) => {
    let source;
    try {
      source = fs.readFileSync(INSPECTOR_FILE, 'utf8');
    } catch (error) {
      console.error('[LocalDevTool] 讀取 inspector.js 失敗:', error.message);
      res.status(500).type('application/javascript; charset=utf-8');
      res.send('/* LocalDevTool: inspector.js 讀取失敗，請看伺服器 log */');
      return;
    }

    res.type('application/javascript; charset=utf-8');
    res.set('cache-control', 'no-cache');
    res.send(source);
  });

  return router;
}

module.exports = { createClientRouter, INSPECTOR_FILE };
