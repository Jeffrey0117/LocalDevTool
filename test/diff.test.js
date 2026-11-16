'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { lineDiff, formatDiff } = require('../src/admin/diff');

/** 把 diff 壓成好讀的字串，方便斷言。 */
function summarize(diff) {
  return diff.map((part) => `${part.type[0]}:${part.text}`).join('|');
}

test('完全相同 → 全部 same', () => {
  const diff = lineDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(summarize(diff), 's:a|s:b|s:c');
});

test('新增一行', () => {
  const diff = lineDiff('a\nc', 'a\nb\nc');
  assert.equal(summarize(diff), 's:a|a:b|s:c');
});

test('刪除一行', () => {
  const diff = lineDiff('a\nb\nc', 'a\nc');
  assert.equal(summarize(diff), 's:a|d:b|s:c');
});

test('改一行 = 一刪一加', () => {
  const diff = lineDiff('a\nOLD\nc', 'a\nNEW\nc');
  const summary = summarize(diff);
  assert.ok(summary.includes('d:OLD'));
  assert.ok(summary.includes('a:NEW'));
  assert.ok(summary.startsWith('s:a'));
  assert.ok(summary.endsWith('s:c'));
});

test('完全不同', () => {
  const diff = lineDiff('x', 'y');
  assert.equal(summarize(diff), 'd:x|a:y');
});

test('空輸入', () => {
  assert.deepEqual(lineDiff('', ''), [{ type: 'same', text: '' }]);
  assert.equal(summarize(lineDiff('', 'a')), 'd:|a:a');
});

test('非字串輸入不炸', () => {
  assert.ok(Array.isArray(lineDiff(null, undefined)));
  assert.ok(Array.isArray(lineDiff(123, {})));
});

test('只在開頭新增（不該把整份都標成改過）', () => {
  const diff = lineDiff('b\nc', 'a\nb\nc');
  assert.equal(summarize(diff), 'a:a|s:b|s:c');
});

test('只在結尾新增', () => {
  const diff = lineDiff('a\nb', 'a\nb\nc');
  assert.equal(summarize(diff), 's:a|s:b|a:c');
});

test('重複行不會錯位', () => {
  // 兩個 'a' 刪哪一個都是同樣短的編輯，所以斷言語意而不是某一種排列：
  // 正好刪掉一個 a，另一個 a 與 b 都保留。
  const diff = lineDiff('a\na\nb', 'a\nb');
  assert.equal(diff.filter((p) => p.type === 'del' && p.text === 'a').length, 1);
  assert.equal(diff.filter((p) => p.type === 'same' && p.text === 'a').length, 1);
  assert.equal(diff.filter((p) => p.type === 'same' && p.text === 'b').length, 1);
  assert.equal(diff.filter((p) => p.type === 'add').length, 0);
});

test('CRLF 與 LF 都能切行', () => {
  const diff = lineDiff('a\r\nb', 'a\r\nb');
  assert.equal(summarize(diff), 's:a|s:b');
});

test('大檔有上限，不會卡死（LCS 是 O(n*m)）', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const other = big.replace('line 2500', 'CHANGED');
  const started = Date.now();
  const diff = lineDiff(big, other);
  assert.ok(Date.now() - started < 5000, 'diff 不該花超過 5 秒');
  assert.ok(diff.length > 0);
});

test('formatDiff 產生 unified 風格的文字', () => {
  const text = formatDiff(lineDiff('a\nOLD\nc', 'a\nNEW\nc'));
  assert.match(text, /^ a$/m);
  assert.match(text, /^-OLD$/m);
  assert.match(text, /^\+NEW$/m);
});
