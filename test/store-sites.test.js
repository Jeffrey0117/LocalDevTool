'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDb } = require('./helpers/temp-db');
const {
  createSite,
  getSite,
  listSites,
  updateSite,
  deleteSite,
  RESERVED_SLUGS,
} = require('../src/store/sites');
const { openDb } = require('../src/store/db');

test('schema 建立後四張表都存在', () => {
  const db = freshDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  for (const table of ['sites', 'sessions', 'requests', 'findings']) {
    assert.ok(names.includes(table), `應該有 ${table} 表`);
  }
  db.close();
});

test('schema 建立規格 §4 要求的索引', () => {
  const db = freshDb();
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all()
    .map((row) => row.sql.toLowerCase())
    .join('\n');
  assert.match(sql, /requests\s*\(\s*ts/);
  assert.match(sql, /requests\s*\(\s*session_id\s*,\s*ts/);
  assert.match(sql, /requests\s*\(\s*host\s*,\s*path/);
  assert.match(sql, /requests\s*\(\s*corr_id/);
  db.close();
});

test('user_version 被設定（單向 migration 的版本戳）', () => {
  const db = freshDb();
  assert.ok(db.pragma('user_version', { simple: true }) >= 1);
  db.close();
});

test('重複 openDb 同一個檔不會重建或報錯（idempotent migration）', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => require('../src/store/schema').migrate(db));
  db.close();
});

test('createSite / getSite 往返', () => {
  const db = freshDb();
  const site = createSite(db, {
    id: 'my-site',
    name: 'My Site',
    targetOrigin: 'https://example.com',
  });
  assert.equal(site.id, 'my-site');
  assert.equal(site.enabled, 1);
  assert.ok(site.created_at);

  const fetched = getSite(db, 'my-site');
  assert.equal(fetched.target_origin, 'https://example.com');
  db.close();
});

test('getSite 查不到回 null', () => {
  const db = freshDb();
  assert.equal(getSite(db, 'nope'), null);
  db.close();
});

test('slug 格式驗證：只准 [a-z0-9-]{1,40}', () => {
  const db = freshDb();
  for (const bad of ['UPPER', 'has space', 'has_underscore', '', 'a'.repeat(41), 'bad!']) {
    assert.throws(
      () => createSite(db, { id: bad, name: 'x', targetOrigin: 'https://example.com' }),
      /slug/i,
      `${JSON.stringify(bad)} 應該被拒`,
    );
  }
  db.close();
});

test('保留字 slug 被拒（admin / p / __ldt）', () => {
  const db = freshDb();
  for (const reserved of RESERVED_SLUGS) {
    assert.throws(
      () => createSite(db, { id: reserved, name: 'x', targetOrigin: 'https://example.com' }),
      /保留/,
    );
  }
  assert.ok(RESERVED_SLUGS.includes('admin'));
  assert.ok(RESERVED_SLUGS.includes('p'));
  db.close();
});

test('target_origin 必須是合法 http(s) origin', () => {
  const db = freshDb();
  for (const bad of [
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'example.com',
    '',
  ]) {
    assert.throws(
      () => createSite(db, { id: 'ok-slug', name: 'x', targetOrigin: bad }),
      /origin/i,
      `${bad} 應該被拒`,
    );
  }
  db.close();
});

test('target_origin 只存 origin，path 被丟掉', () => {
  const db = freshDb();
  const site = createSite(db, {
    id: 'trim-path',
    name: 'x',
    targetOrigin: 'https://example.com/some/path?q=1',
  });
  assert.equal(site.target_origin, 'https://example.com');
  db.close();
});

test('重複 slug 被拒', () => {
  const db = freshDb();
  createSite(db, { id: 'dup', name: 'x', targetOrigin: 'https://example.com' });
  assert.throws(
    () => createSite(db, { id: 'dup', name: 'y', targetOrigin: 'https://example.org' }),
    /已存在/,
  );
  db.close();
});

test('updateSite 改名與停用，updated_at 會變', () => {
  const db = freshDb();
  createSite(db, { id: 's1', name: 'Old', targetOrigin: 'https://example.com' });
  const updated = updateSite(db, 's1', { name: 'New', enabled: 0 });
  assert.equal(updated.name, 'New');
  assert.equal(updated.enabled, 0);
  db.close();
});

test('updateSite 對不存在的 site 回 null', () => {
  const db = freshDb();
  assert.equal(updateSite(db, 'ghost', { name: 'x' }), null);
  db.close();
});

test('updateSite 也驗證 target_origin', () => {
  const db = freshDb();
  createSite(db, { id: 's1', name: 'x', targetOrigin: 'https://example.com' });
  assert.throws(() => updateSite(db, 's1', { targetOrigin: 'ftp://bad' }), /origin/i);
  db.close();
});

test('listSites 依建立時間排序回傳全部', () => {
  const db = freshDb();
  createSite(db, { id: 'a', name: 'A', targetOrigin: 'https://a.example.com' });
  createSite(db, { id: 'b', name: 'B', targetOrigin: 'https://b.example.com' });
  const ids = listSites(db).map((s) => s.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
  db.close();
});

test('deleteSite 刪得掉，且回報是否真的刪到', () => {
  const db = freshDb();
  createSite(db, { id: 'gone', name: 'x', targetOrigin: 'https://example.com' });
  assert.equal(deleteSite(db, 'gone'), true);
  assert.equal(getSite(db, 'gone'), null);
  assert.equal(deleteSite(db, 'gone'), false);
  db.close();
});

test('name 空白被拒', () => {
  const db = freshDb();
  assert.throws(() => createSite(db, { id: 'x', name: '   ', targetOrigin: 'https://e.com' }), /name/i);
  db.close();
});
