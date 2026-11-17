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

/**
 * 把 IPv6 文字展開成 8 個 16-bit 數字。判不出來回 null（呼叫端要保守處理）。
 *
 * 為什麼要自己展開：同一個位址有好幾種合法寫法，用字串比對一定會漏。
 * `::ffff:127.0.0.1` 和 `::ffff:7f00:1` 是**同一個** loopback 位址。
 *
 * @param {string} ip 已經是小寫、且 net.isIPv6 認可的字串
 * @returns {number[]|null}
 */
function hextetsOf(ip) {
  if (ip.split('::').length > 2) return null;

  // 結尾若是帶點的 IPv4（最後 32 bits），先換成兩個 hextet 再統一處理。
  let text = ip;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted !== null) {
    const bytes = dotted[1].split('.').map(Number);
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    const pair = [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]];
    text = text.slice(0, -dotted[1].length) + pair.map((n) => n.toString(16)).join(':');
  }

  const compressed = text.includes('::');
  const [left, right] = text.split('::');
  const toNumbers = (segment) =>
    segment === undefined || segment === ''
      ? []
      : segment.split(':').map((piece) => Number.parseInt(piece, 16));

  const head = toNumbers(left);
  const tail = compressed ? toNumbers(right) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (!compressed && fill !== 0)) return null;

  const all = [...head, ...new Array(fill).fill(0), ...tail];
  if (all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return all;
}

/**
 * 取出包在 IPv6 裡的 IPv4 位址：v4-mapped（::ffff:/96）與 NAT64 的
 * well-known prefix（64:ff9b::/96）都要穿透，否則它們是現成的 SSRF 繞道。
 *
 * @param {number[]} hextets
 * @returns {string|null} 點分十進位，不是這兩種前綴則回 null
 */
function embeddedV4(hextets) {
  const isMapped = hextets.slice(0, 5).every((n) => n === 0) && hextets[5] === 0xffff;
  const isNat64 =
    hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((n) => n === 0);
  if (!isMapped && !isNat64) return null;

  const [high, low] = hextets.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** @param {string} ip @returns {boolean} */
function isPrivateV6(ip) {
  const lower = ip.toLowerCase();

  const hextets = hextetsOf(lower);
  if (hextets === null) return true; // 判不出來就保守擋下

  // v4-mapped / NAT64 必須穿透去看裡面那個 v4 位址。
  const inner = embeddedV4(hextets);
  if (inner !== null) return isPrivateV4(inner);

  if (lower === '::1' || lower === '::') return true;

  // ::/96 剩下的都是已廢棄的 IPv4-compatible 寫法（::127.0.0.1），
  // 公網上不可路由，擋掉不會誤殺任何真實目標。
  if (hextets.slice(0, 6).every((n) => n === 0)) return true;

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
