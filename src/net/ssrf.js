'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

/**
 * SSRF 防護（規格 §6.2）。
 *
 * 代理任意網址是這個產品的本質，所以不能用白名單；底線是「不准打到內網」。
 * 檢查在兩個時機各做一次：登記 site 時、以及**每次代理請求時**。
 * 後者是關鍵 —— 只在登記時檢查的話，攻擊者可以讓 DNS 第二次解析回 127.0.0.1（DNS rebinding）。
 */

/** 不論解析結果如何都封鎖的主機名（雲端 metadata 端點）。 */
const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** @param {string} ip @returns {boolean} */
function isPrivateV4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 判不出來就保守擋下
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local（含 169.254.169.254 metadata）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** @param {string} ip @returns {boolean} */
function isPrivateV6(ip) {
  const lower = ip.toLowerCase();

  // IPv4-mapped（::ffff:127.0.0.1）必須穿透去看裡面那個 v4 位址。
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  // fc00::/7 unique-local：第一個 byte 是 fc 或 fd
  if (/^f[cd]/.test(lower)) return true;
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * @param {unknown} ip
 * @returns {boolean} true = 私有 / 不可代理。無法判定時回 true（保守）
 */
function isPrivateAddress(ip) {
  if (typeof ip !== 'string' || ip.trim() === '') return true;
  const value = ip.trim();
  if (net.isIPv4(value)) return isPrivateV4(value);
  if (net.isIPv6(value)) return isPrivateV6(value);
  return true;
}

/** @param {unknown} hostname @returns {boolean} */
function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string') return true;
  return BLOCKED_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/** @param {string} message @returns {Error} */
function ssrfError(message) {
  const error = new Error(message);
  error.code = 'SSRF_BLOCKED';
  return error;
}

/**
 * 驗證一個目標網址可不可以代理。
 *
 * @param {string} target origin 或完整 URL
 * @param {{ allowPrivate?: boolean, lookup?: (host: string) => Promise<{address: string}[]> }} [options]
 *   lookup 可注入，測試才不需要真的打 DNS
 * @returns {Promise<{ hostname: string, addresses: string[] }>}
 * @throws {Error} code = 'SSRF_BLOCKED'
 */
async function assertSafeTarget(target, options = {}) {
  const allowPrivate = options.allowPrivate === true;
  const lookup = options.lookup || ((host) => dns.lookup(host, { all: true }));

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw ssrfError(`不是合法的 URL / origin：${target}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ssrfError(`只接受 http(s)，收到 ${parsed.protocol}`);
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw ssrfError(`主機名 ${parsed.hostname} 已被封鎖（雲端 metadata 端點），不受 ALLOW_PRIVATE 影響`);
  }

  let records;
  try {
    records = await lookup(parsed.hostname);
  } catch (error) {
    throw ssrfError(`DNS 解析 ${parsed.hostname} 失敗：${error.message}`);
  }

  const addresses = (Array.isArray(records) ? records : [])
    .map((record) => (typeof record === 'string' ? record : record && record.address))
    .filter((address) => typeof address === 'string');

  if (addresses.length === 0) {
    throw ssrfError(`DNS 解析 ${parsed.hostname} 沒有回傳任何位址`);
  }

  if (!allowPrivate) {
    const offending = addresses.filter((address) => isPrivateAddress(address));
    if (offending.length > 0) {
      throw ssrfError(
        `${parsed.hostname} 解析到私有位址 ${offending.join(', ')}，已拒絕。` +
          '若要代理本機 dev server，請設 LOCALDEVTOOL_ALLOW_PRIVATE=1（並理解其風險）。',
      );
    }
  }

  return { hostname: parsed.hostname, addresses };
}

module.exports = {
  isPrivateAddress,
  isBlockedHostname,
  assertSafeTarget,
  BLOCKED_HOSTNAMES,
};
