'use strict';

const { newId } = require('../util/ids');

/**
 * Inspect 的工作佇列（規格 §8：單一時間最多 2 個並行，超過排隊）。
 *
 * 為什麼要限制：每個 job 是一顆真的 Chromium，記憶體以百 MB 計。
 * 不設上限的話，連點幾次「分析」就能把機器吃垮。
 *
 * job 本身用不可變快照：狀態變更是「換一個新物件放回 Map」，
 * 不是原地改欄位，所以已經拿到快照的呼叫端不會看到它在腳下變形。
 */

const DEFAULT_MAX_JOBS = 50;

/**
 * @param {{ maxConcurrent: number, runner: (input: object) => Promise<object>, maxJobs?: number }} options
 */
function createJobQueue(options) {
  const maxConcurrent = Math.max(1, options.maxConcurrent || 1);
  const maxJobs = Math.max(1, options.maxJobs || DEFAULT_MAX_JOBS);

  /** @type {Map<string, object>} id → 不可變的 job 快照 */
  const jobs = new Map();
  /** @type {Map<string, { promise: Promise<object>, resolve: (job: object) => void }>} */
  const waiters = new Map();
  /** @type {string[]} 還沒開始跑的 id */
  const queued = [];
  /** @type {string[]} 建立順序，用來做保留上限的淘汰 */
  const order = [];

  let running = 0;

  function patch(id, changes) {
    const current = jobs.get(id);
    if (current === undefined) return null;
    const next = Object.freeze({ ...current, ...changes });
    jobs.set(id, next);
    return next;
  }

  /** 只淘汰已結束的 job，還在跑的留著。 */
  function evictOldJobs() {
    while (order.length > maxJobs) {
      const index = order.findIndex((id) => {
        const job = jobs.get(id);
        return job === undefined || job.status === 'done' || job.status === 'failed';
      });
      if (index === -1) return; // 全都還在跑，這次不淘汰
      const [victim] = order.splice(index, 1);
      jobs.delete(victim);
      waiters.delete(victim);
    }
  }

  function pump() {
    while (running < maxConcurrent && queued.length > 0) {
      const id = queued.shift();
      const job = jobs.get(id);
      if (job === undefined) continue; // 已被淘汰

      running += 1;
      patch(id, { status: 'running', startedAt: new Date().toISOString() });

      Promise.resolve()
        .then(() => options.runner(job.input))
        .then((result) => {
          patch(id, { status: 'done', result, error: null });
        })
        .catch((error) => {
          // 只留可讀訊息，不留堆疊 —— 報告會被人看到。
          patch(id, {
            status: 'failed',
            result: null,
            error: error && error.message ? error.message : String(error),
            howToFix: error && error.howToFix ? error.howToFix : undefined,
          });
        })
        .then(() => {
          patch(id, { finishedAt: new Date().toISOString() });
          running -= 1;

          const waiter = waiters.get(id);
          if (waiter) waiter.resolve(jobs.get(id) || null);

          pump();
        });
    }
  }

  /** @param {object} input @returns {{ id: string, status: string }} */
  function submit(input) {
    const id = newId('insp');
    jobs.set(
      id,
      Object.freeze({
        id,
        input,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      }),
    );
    order.push(id);

    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    waiters.set(id, { promise, resolve });

    queued.push(id);
    evictOldJobs();
    pump();

    const current = jobs.get(id);
    return { id, status: current ? current.status : 'queued' };
  }

  /** @param {string} id @returns {object|null} */
  function get(id) {
    return jobs.get(id) || null;
  }

  /** @param {string} id @returns {Promise<object|null>} 結束後的 job，id 不存在回 null */
  async function waitFor(id) {
    const job = jobs.get(id);
    if (job === undefined) return null;
    if (job.status === 'done' || job.status === 'failed') return job;

    const waiter = waiters.get(id);
    if (waiter === undefined) return job;
    return waiter.promise;
  }

  return { submit, get, waitFor, stats: () => ({ running, queued: queued.length, total: jobs.size }) };
}

module.exports = { createJobQueue, DEFAULT_MAX_JOBS };
