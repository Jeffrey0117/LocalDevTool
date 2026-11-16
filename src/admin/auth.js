'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 管理後台認證（規格 §9，同 LocalMonkey §6.1）。
 *
 * **不准**有 hardcoded 預設 token，**不准**「沒設就不驗證」，
 * 更**不准**「localhost 免驗證」。最後一條是真實事故：本機免驗證 + 寬鬆 CORS
 * = 使用者瀏覽器裡任何網頁都能 fetch 這個 API 當管理員。
 *
 * 所以這裡的三道防線是一起的：
 *  1. 一律要 token（timingSafeEqual 比對）
 *  2. 完全不設 CORS header → 別的 origin 讀不到回應內容
 *  3. 寫入方法檢查 Origin / Sec-Fetch-Site → 跨站一律 403（擋 CSRF）
 */

const ADMIN_COOKIE = 'ldt_admin';
const TOKEN_FILE = 'admin-token.txt';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {{ adminToken: string|null }} config
 * @param {{ dataDir: string }} options
 * @returns {{ token: string, source: 'env'|'file'|'generated', file: string|null }}
 */
function resolveAdminToken(config, options) {
  if (config.adminToken) {
    return { token: config.adminToken, source: 'env', file: null };
  }

  const file = path.join(options.dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing !== '') return { token: existing, source: 'file', file };
  } catch {
    // 檔案不存在是正常的第一次啟動。
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(options.dataDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return { token, source: 'generated', file };
}

/** 長度不同時先擋，否則 timingSafeEqual 會拋錯。 */
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || provided === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** @param {string} raw @returns {string|null} */
function tokenFromCookie(raw) {
  if (typeof raw !== 'string') return null;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== ADMIN_COOKIE) continue;
    return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return null;
}

/** @param {import('express').Request} req @returns {string|null} */
function presentedToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  return tokenFromCookie(req.headers.cookie);
}

/**
 * 跨站寫入偵測。兩個訊號都看：
 * `Sec-Fetch-Site` 是現代瀏覽器給的、無法被 JS 偽造；`Origin` 是後備。
 */
function isCrossSiteWrite(req) {
  if (!WRITE_METHODS.has(req.method)) return false;

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return true;
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;

  const expected = `${req.protocol}://${req.headers.host}`;
  return origin !== expected;
}

/**
 * @param {string} expectedToken
 * @returns {import('express').RequestHandler}
 */
function createAdminAuth(expectedToken) {
  return (req, res, next) => {
    // `?token=` 只接受 GET（人直接開網址那一次），設 cookie 後就把 token 從網址列清掉。
    if (req.method === 'GET' && typeof req.query.token === 'string') {
      if (!tokensMatch(req.query.token, expectedToken)) {
        res.status(401).type('text/plain; charset=utf-8').send('token 不正確。');
        return;
      }
      res.cookie(ADMIN_COOKIE, expectedToken, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/admin',
      });
      // 用 originalUrl 去掉 query，不是 req.path —— 在掛載過的 router 裡
      // req.path 是相對於掛載點的（'/network' 而不是 '/admin/network'），會轉錯地方。
      res.redirect(302, req.originalUrl.split('?')[0]);
      return;
    }

    if (!tokensMatch(presentedToken(req), expectedToken)) {
      res
        .status(401)
        .type('text/plain; charset=utf-8')
        .send(
          '需要 admin token。帶 Authorization: Bearer <token>，' +
            '或用瀏覽器開 /admin?token=<token> 一次（會設 cookie）。\n' +
            'token 在啟動 log 裡，或 data/admin-token.txt。',
        );
      return;
    }

    if (isCrossSiteWrite(req)) {
      res
        .status(403)
        .type('text/plain; charset=utf-8')
        .send('跨站寫入一律拒絕（CSRF 防護）。請從 /admin 的頁面操作。');
      return;
    }

    next();
  };
}

module.exports = {
  resolveAdminToken,
  createAdminAuth,
  tokensMatch,
  isCrossSiteWrite,
  ADMIN_COOKIE,
  TOKEN_FILE,
};
