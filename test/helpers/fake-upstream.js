'use strict';

const http = require('node:http');

const { track } = require('./open-resources');

/**
 * 真的起一台上游 origin server（綁 port 0）。
 * 規格 §11 要求不要 mock fetch —— mock 掉就測不到 header 過濾、解壓、binary 完整性這些真東西。
 */
async function startFakeUpstream(handler) {
  const received = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      });
      try {
        handler(req, res, Buffer.concat(chunks));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`fake upstream handler threw: ${error.message}`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    received,
    lastRequest: () => received[received.length - 1],
    close: track(() => new Promise((resolve) => server.close(resolve))),
  };
}

module.exports = { startFakeUpstream };
