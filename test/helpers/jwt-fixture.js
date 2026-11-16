'use strict';

/** Build a fake JWT for tests. No real signing — we never verify signatures. */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function makeJwt(header, payload, signature = 'ZmFrZS1zaWduYXR1cmU') {
  return `${b64url(header)}.${b64url(payload)}.${signature}`;
}

const DEFAULT_HEADER = { alg: 'HS256', typ: 'JWT' };

const DEFAULT_PAYLOAD = {
  sub: 'user-abc-123',
  email: 'victim@example.com',
  name: 'Real Person',
  iss: 'https://issuer.example.com',
  aud: 'api',
  exp: 1800000000,
  iat: 1799999000,
  role: 'admin',
};

module.exports = { b64url, makeJwt, DEFAULT_HEADER, DEFAULT_PAYLOAD };
