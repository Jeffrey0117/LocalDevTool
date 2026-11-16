'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobQueue } = require('../src/inspector/jobs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('同一時間最多跑 2 個，第三個排隊（規格 §8）', async () => {
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;

  const queue = createJobQueue({
    maxConcurrent: 2,
    runner: () => {
      const gate = gates[started];
      started += 1;
      return gate.promise;
    },
  });

  const a = queue.submit({ url: 'https://a' });
  const b = queue.submit({ url: 'https://b' });
  const c = queue.submit({ url: 'https://c' });
  await tick();

  assert.equal(started, 2, '只該有兩個真的開始跑');
  assert.equal(queue.get(a.id).status, 'running');
  assert.equal(queue.get(b.id).status, 'running');
  assert.equal(queue.get(c.id).status, 'queued');

  gates[0].resolve({ ok: true });
  await tick();
  await tick();

  assert.equal(started, 3, '一個做完就該輪到排隊的');
  assert.equal(queue.get(c.id).status, 'running');

  gates[1].resolve({ ok: true });
  gates[2].resolve({ ok: true });
  await tick();
  await tick();
});

test('完成後結果存進 job', async () => {
  const queue = createJobQueue({
    maxConcurrent: 2,
    runner: async (input) => ({ analyzed: input.url }),
  });

  const job = queue.submit({ url: 'https://example.com' });
  await queue.waitFor(job.id);

  const finished = queue.get(job.id);
  assert.equal(finished.status, 'done');
  assert.deepEqual(finished.result, { analyzed: 'https://example.com' });
  assert.ok(finished.finishedAt);
});

test('失敗時狀態是 failed，並保留可讀的錯誤訊息（不是整個堆疊）', async () => {
  const queue = createJobQueue({
    maxConcurrent: 2,
    runner: async () => {
      throw new Error('瀏覽器啟動失敗');
    },
  });

  const job = queue.submit({ url: 'https://example.com' });
  await queue.waitFor(job.id);

  const finished = queue.get(job.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error, '瀏覽器啟動失敗');
  assert.equal(finished.result, null);
  assert.ok(!String(finished.error).includes('at '), '不該夾帶堆疊');
});

test('一個 job 失敗不會卡住後面的（並行額度要還回去）', async () => {
  let calls = 0;
  const queue = createJobQueue({
    maxConcurrent: 1,
    runner: async () => {
      calls += 1;
      if (calls === 1) throw new Error('第一個就爆');
      return { ok: true };
    },
  });

  const first = queue.submit({ url: 'https://a' });
  const second = queue.submit({ url: 'https://b' });

  await queue.waitFor(first.id);
  await queue.waitFor(second.id);

  assert.equal(queue.get(first.id).status, 'failed');
  assert.equal(queue.get(second.id).status, 'done');
});

test('get 不存在的 id 回 null', () => {
  const queue = createJobQueue({ maxConcurrent: 2, runner: async () => ({}) });
  assert.equal(queue.get('nope'), null);
});

test('submit 回傳的 id 可讀且唯一', () => {
  const queue = createJobQueue({ maxConcurrent: 2, runner: async () => ({}) });
  const a = queue.submit({ url: 'https://a' });
  const b = queue.submit({ url: 'https://b' });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^insp_/);
});

test('job 記下輸入與排隊時間', () => {
  const queue = createJobQueue({ maxConcurrent: 2, runner: async () => ({}) });
  const job = queue.submit({ url: 'https://example.com', waitMs: 1234 });
  const stored = queue.get(job.id);
  assert.equal(stored.input.url, 'https://example.com');
  assert.equal(stored.input.waitMs, 1234);
  assert.ok(stored.queuedAt);
});

test('超過保留上限的舊 job 被丟掉，不會無限吃記憶體', async () => {
  const queue = createJobQueue({ maxConcurrent: 2, runner: async () => ({}), maxJobs: 3 });
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const job = queue.submit({ url: `https://${i}` });
    ids.push(job.id);
    await queue.waitFor(job.id);
  }
  assert.equal(queue.get(ids[0]), null, '最舊的應該被清掉');
  assert.ok(queue.get(ids[4]), '最新的要留著');
});

test('waitFor 不存在的 id 回 null 而不是永遠不回來', async () => {
  const queue = createJobQueue({ maxConcurrent: 2, runner: async () => ({}) });
  assert.equal(await queue.waitFor('nope'), null);
});
