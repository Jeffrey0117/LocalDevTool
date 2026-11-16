'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteHtml, rewriteRootAbsolutePaths, INSPECTOR_PATH } = require('../src/proxy/html-rewrite');

const OPTS = { siteId: 'demo' };

test('根絕對路徑的 src / href / action 被改寫成 /p/<siteId>/...', () => {
  const html = `
    <script src="/assets/app.js"></script>
    <link rel="stylesheet" href="/css/main.css">
    <form action="/submit"><img src='/img/logo.png'></form>
  `;
  const out = rewriteRootAbsolutePaths(html, 'demo');
  assert.ok(out.includes('src="/p/demo/assets/app.js"'));
  assert.ok(out.includes('href="/p/demo/css/main.css"'));
  assert.ok(out.includes('action="/p/demo/submit"'));
  assert.ok(out.includes("src='/p/demo/img/logo.png'"));
});

test('protocol-relative //cdn/x.js 不動（那是跨網域）', () => {
  const html = '<script src="//cdn.example.com/x.js"></script>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('絕對 URL 不動', () => {
  const html = '<img src="https://other.example.com/a.png"><a href="http://x.com/">x</a>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('相對路徑不動（瀏覽器會相對代理路徑解析）', () => {
  const html = '<img src="images/a.png"><a href="./b.html">b</a><a href="../c.html">c</a>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('錨點、mailto、data: URI、javascript: 不動', () => {
  const html =
    '<a href="#top">t</a><a href="mailto:a@b.c">m</a><img src="data:image/png;base64,AAA"><a href="javascript:void(0)">j</a>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('srcset 的每個候選圖都被改寫，寬度描述子保留', () => {
  const html = '<img srcset="/a.png 1x, /b.png 2x, //cdn/c.png 3x, https://x/d.png 4x">';
  const out = rewriteRootAbsolutePaths(html, 'demo');
  assert.ok(out.includes('/p/demo/a.png 1x'));
  assert.ok(out.includes('/p/demo/b.png 2x'));
  assert.ok(out.includes('//cdn/c.png 3x'), 'protocol-relative 不該被改');
  assert.ok(out.includes('https://x/d.png 4x'), '絕對 URL 不該被改');
});

test('poster 也被改寫（追影片來源要用）', () => {
  const out = rewriteRootAbsolutePaths('<video poster="/p.jpg" src="/v.mp4"></video>', 'demo');
  assert.ok(out.includes('poster="/p/demo/p.jpg"'));
  assert.ok(out.includes('src="/p/demo/v.mp4"'));
});

test('inline script 裡的字串不被改寫（只認屬性，不認裸引號）', () => {
  const html = `<script>fetch("/api/orders");const p="/not-an-attribute";</script>`;
  const out = rewriteRootAbsolutePaths(html, 'demo');
  assert.ok(out.includes('fetch("/api/orders")'), 'JS 字串被改寫會弄壞原站邏輯');
  assert.ok(out.includes('"/not-an-attribute"'));
});

test('已經帶 /p/<siteId>/ 前綴的路徑不會被重複改寫', () => {
  const html = '<script src="/p/demo/already.js"></script>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('保留路徑 /__ldt/... 不被改寫（注入的腳本要讀得到）', () => {
  const html = '<script src="/__ldt/inspector.js"></script>';
  assert.equal(rewriteRootAbsolutePaths(html, 'demo'), html);
});

test('rewriteHtml 把 inspector 注入在 </body> 之前', () => {
  const html = '<html><head></head><body><p>hi</p></body></html>';
  const out = rewriteHtml(html, OPTS);
  assert.ok(out.includes(INSPECTOR_PATH), '必須注入 inspector');
  assert.ok(
    out.indexOf(INSPECTOR_PATH) < out.indexOf('</body>'),
    'inspector 要在 </body> 之前',
  );
});

test('rewriteHtml 用 <script src> 注入（不內嵌程式碼）', () => {
  const out = rewriteHtml('<body></body>', OPTS);
  assert.match(out, /<script[^>]+src="\/__ldt\/inspector\.js"[^>]*><\/script>/);
});

test('rewriteHtml 沒有 </body> 時附加到結尾', () => {
  const out = rewriteHtml('<p>no body tag</p>', OPTS);
  assert.ok(out.includes(INSPECTOR_PATH));
  assert.ok(out.startsWith('<p>no body tag</p>'));
});

test('rewriteHtml 只注入一次（即使有多個 </body> 字樣）', () => {
  const out = rewriteHtml('<body></body><!-- </body> --></body>', OPTS);
  const count = out.split(INSPECTOR_PATH).length - 1;
  assert.equal(count, 1);
});

test('rewriteHtml 把 siteId 傳給注入的腳本（腳本要知道自己在哪個站）', () => {
  const out = rewriteHtml('<body></body>', OPTS);
  assert.match(out, /data-ldt-site="demo"/);
});

test('rewriteHtml 同時做路徑改寫與注入', () => {
  const out = rewriteHtml('<body><script src="/a.js"></script></body>', OPTS);
  assert.ok(out.includes('src="/p/demo/a.js"'));
  assert.ok(out.includes(INSPECTOR_PATH));
});

test('空字串與非字串輸入不炸', () => {
  assert.equal(typeof rewriteHtml('', OPTS), 'string');
  assert.equal(rewriteRootAbsolutePaths('', 'demo'), '');
  assert.equal(rewriteRootAbsolutePaths(null, 'demo'), null);
});

test('</BODY> 大寫也認得', () => {
  const out = rewriteHtml('<BODY></BODY>', OPTS);
  assert.ok(out.indexOf(INSPECTOR_PATH) < out.indexOf('</BODY>'));
});
