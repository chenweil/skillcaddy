import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAGE_URLS,
  fetchLeaderboardPage,
  parseLeaderboardHtml
} from '../lib/hot/skillsShProvider.js';
import { resolveHotSource, OFFLINE_SOURCE, LIVE_SOURCE } from '../lib/hot/hotProvider.js';

const fixture = (name) => readFile(new URL(`./fixtures/hot/${name}.html`, import.meta.url), 'utf8');

test('parser reads the embedded leaderboard and drops malformed entries', async () => {
  const entries = parseLeaderboardHtml(await fixture('hot'));

  assert.deepEqual(entries.map((entry) => entry.skillId), ['agent-browser', 'find-skills', 'regressed']);
  // `broken` has no installs and never reaches the ranking.
  assert.ok(!entries.some((entry) => entry.skillId === 'broken'));
  assert.equal(entries[0].key, 'vercel-labs/agent-browser/agent-browser');
  assert.equal(entries[0].isOfficial, true);
  assert.equal(entries[1].isOfficial, false);
  // A `]` inside a name must not end the array early.
  assert.equal(entries[1].name, 'find-skills [beta]');
  // Negative change is not a growth number.
  assert.equal(entries[2].change, null);
});

test('parser keeps weekly buckets for the cumulative windows', async () => {
  const entries = parseLeaderboardHtml(await fixture('home'));
  assert.equal(entries[0].weeklyInstalls.length, 8);
  assert.equal(entries[0].installs, 4491467);
});

test('parser tolerates payloads with no leaderboard', () => {
  assert.deepEqual(parseLeaderboardHtml('<html><body>no payload</body></html>'), []);
  assert.deepEqual(parseLeaderboardHtml(''), []);
  assert.deepEqual(parseLeaderboardHtml(null), []);
});

test('page fetch sends a skillcaddy user agent and normalizes entries', async () => {
  const html = await fixture('hot');
  const calls = [];
  const page = await fetchLeaderboardPage('hot', {
    userAgent: 'skillcaddy/test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });

  assert.equal(calls[0].url, PAGE_URLS.hot);
  assert.equal(calls[0].options.headers['user-agent'], 'skillcaddy/test');
  assert.equal(page.page, 'hot');
  assert.equal(page.entries.length, 3);
});

test('page fetch rejects non-html responses and surfaces Retry-After', async () => {
  await assert.rejects(
    fetchLeaderboardPage('home', {
      fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
    }),
    /returned application\/json/
  );

  await assert.rejects(
    fetchLeaderboardPage('hot', {
      fetchImpl: async () => new Response('slow down', {
        status: 429,
        headers: { 'content-type': 'text/html', 'retry-after': '2' }
      })
    }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 2000);
      return true;
    }
  );
});

test('page fetch enforces the response size cap', async () => {
  const big = `<html>${'x'.repeat(4096)}</html>`;
  await assert.rejects(
    fetchLeaderboardPage('home', {
      maxBytes: 1024,
      fetchImpl: async () => new Response(big, { headers: { 'content-type': 'text/html' } })
    }),
    /size cap/
  );
});

test('provider selection honours the off switch', () => {
  assert.equal(resolveHotSource({ SKILLCADDY_HOT_SOURCE: 'off' }), OFFLINE_SOURCE);
  assert.equal(resolveHotSource({ SKILLCADDY_HOT_SOURCE: 'OFF' }), OFFLINE_SOURCE);
  assert.equal(resolveHotSource({ SKILLCADDY_HOT_SOURCE: '0' }), OFFLINE_SOURCE);
  assert.equal(resolveHotSource({}), LIVE_SOURCE);
  assert.equal(resolveHotSource({ SKILLCADDY_HOT_SOURCE: 'skills.sh' }), LIVE_SOURCE);
});
