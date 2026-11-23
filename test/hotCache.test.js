import assert from 'node:assert/strict';
import test from 'node:test';
import { createHotCache } from '../lib/hot/hotCache.js';

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    }
  };
}

test('a fresh entry inside its TTL never refetches', async () => {
  const time = clock();
  const cache = createHotCache({ now: time.now });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { entries: [1] };
  };

  const first = await cache.load('hot', { ttlMs: 60_000, fetcher });
  time.advance(30_000);
  const second = await cache.load('hot', { ttlMs: 60_000, fetcher });

  assert.equal(calls, 1);
  assert.equal(first.stale, false);
  assert.equal(second.stale, false);
  assert.deepEqual(second.value, { entries: [1] });
});

test('an expired entry refetches and reports a new timestamp', async () => {
  const time = clock();
  const cache = createHotCache({ now: time.now });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { entries: [calls] };
  };

  await cache.load('hot', { ttlMs: 1000, fetcher });
  time.advance(1001);
  const refreshed = await cache.load('hot', { ttlMs: 1000, fetcher });

  assert.equal(calls, 2);
  assert.equal(refreshed.stale, false);
});

test('a failing refresh serves the last good value as stale', async () => {
  const time = clock();
  const cache = createHotCache({ now: time.now });
  let shouldFail = false;
  const fetcher = async () => {
    if (shouldFail) throw new Error('upstream down');
    return { entries: ['cached'] };
  };

  await cache.load('home', { ttlMs: 10, fetcher });
  time.advance(20);
  shouldFail = true;
  const result = await cache.load('home', { ttlMs: 10, fetcher });

  assert.equal(result.stale, true);
  assert.deepEqual(result.value, { entries: ['cached'] });
  assert.equal(result.error.message, 'upstream down');
});

test('without a cached value a failing fetch still throws', async () => {
  const cache = createHotCache();
  await assert.rejects(
    cache.load('missing', { ttlMs: 10, fetcher: async () => { throw new Error('boom'); } }),
    /boom/
  );
});

test('Retry-After blocks retries until the window passes', async () => {
  const time = clock();
  const cache = createHotCache({ now: time.now });
  let calls = 0;

  const failing = async () => {
    calls += 1;
    const error = new Error('429');
    error.status = 429;
    error.retryAfterMs = 30_000;
    throw error;
  };

  await assert.rejects(cache.load('hot', { ttlMs: 10, fetcher: failing }), /429/);
  assert.equal(cache.isBlocked('hot'), true);

  // 被 429 挡住时，有缓存就继续用缓存，不发请求。
  cache.set('hot', { entries: ['stale'] });
  time.advance(20);
  const served = await cache.load('hot', { ttlMs: 10, fetcher: failing });
  assert.equal(served.stale, true);
  assert.equal(calls, 1);

  time.advance(30_001);
  assert.equal(cache.isBlocked('hot'), false);
});

test('force bypasses the TTL and the backoff for an explicit refresh', async () => {
  const time = clock();
  const cache = createHotCache({ now: time.now });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { entries: [calls] };
  };

  await cache.load('hot', { ttlMs: 60_000, fetcher });
  await cache.load('hot', { ttlMs: 60_000, fetcher, force: true });

  assert.equal(calls, 2);
});
