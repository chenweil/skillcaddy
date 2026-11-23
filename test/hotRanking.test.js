import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLeaderboardHtml } from '../lib/hot/skillsShProvider.js';
import { computeRanking, parseWindow, snapshotDelta, splitKey } from '../lib/hot/hotRanking.js';

const fixture = async (name) =>
  parseLeaderboardHtml(await readFile(new URL(`./fixtures/hot/${name}.html`, import.meta.url), 'utf8'));

const pages = {
  hot: await fixture('hot'),
  trending: await fixture('trending'),
  home: await fixture('home')
};

function snapshotFor({ latest, baseline = null, coverageDays = 0 }) {
  return {
    latest: new Map(Object.entries(latest)),
    baseline: baseline ? new Map(Object.entries(baseline)) : null,
    coverageDays,
    latestAt: '2026-11-23T00:00:00.000Z',
    baselineAt: baseline ? '2026-11-16T00:00:00.000Z' : null
  };
}

test('24 小时 ranks by change and takes cumulative installs from the cumulative page', () => {
  const { window, entries } = computeRanking({ requested: '24h', pages });

  assert.equal(window.label, '24 小时');
  assert.equal(window.kind, 'upstream');
  assert.deepEqual(entries.map((entry) => entry.skillId), ['agent-browser', 'find-skills', 'regressed']);
  assert.deepEqual(entries.map((entry) => entry.rank), [1, 2, 3]);
  assert.equal(entries[1].windowInstalls, 24);
  // 累计值来自首页，而不是 /hot 的当日安装数。
  assert.equal(entries[1].installs, 4491467);
  // 负增长被夹到 0，不会出现负的「新增」。
  assert.equal(entries[2].windowInstalls, 0);
});

test('7 天 uses the trending page and its install counts', () => {
  const { window, entries } = computeRanking({ requested: '7d', pages });
  assert.equal(window.label, '7 天');
  assert.equal(entries[0].skillId, 'find-skills');
  assert.equal(entries[0].windowInstalls, 121000);
  assert.equal(entries[0].installs, 4491467);
});

test('30 天 sums the latest four weekly buckets, 8 周 sums all eight', () => {
  const month = computeRanking({ requested: '30d', pages });
  const findSkills = month.entries.find((entry) => entry.skillId === 'find-skills');
  // 最新四个桶，不是最早四个。
  assert.equal(findSkills.windowInstalls, 115285 + 110096 + 109742 + 112607);
  assert.equal(month.window.kind, 'derived');

  const eightWeeks = computeRanking({ requested: '8w', pages });
  const first = eightWeeks.entries.find((entry) => entry.skillId === 'find-skills');
  assert.equal(first.windowInstalls, 107199 + 110524 + 121189 + 121665 + 115285 + 110096 + 109742 + 112607);
});

test('全部 ranks by cumulative installs', () => {
  const { entries } = computeRanking({ requested: 'all', pages });
  assert.equal(entries[0].skillId, 'find-skills');
  assert.equal(entries[0].windowInstalls, entries[0].installs);
});

test('24 小时 falls back to the snapshot delta when the hot page is missing', () => {
  const snapshot = snapshotFor({
    latest: { 'acme/tools/alpha': 120, 'acme/tools/beta': 40 },
    baseline: { 'acme/tools/alpha': 100, 'acme/tools/beta': 40 },
    coverageDays: 2
  });

  const { window, entries } = computeRanking({
    requested: '24h',
    pages: { hot: null, trending: null, home: null },
    snapshot
  });

  assert.equal(window.kind, 'snapshot');
  assert.equal(entries[0].skillId, 'alpha');
  assert.equal(entries[0].windowInstalls, 20);
  assert.equal(entries[1].windowInstalls, 0);
});

test('24 小时 degrades to 7 天 with an explicit note when nothing else exists', () => {
  const { window } = computeRanking({
    requested: '24h',
    pages: { hot: null, trending: pages.trending, home: pages.home },
    snapshot: null
  });

  assert.equal(window.actual, '7d');
  assert.match(window.note, /暂用 7 天/);
});

test('自定义窗口 without enough history falls back and says so', () => {
  const snapshot = snapshotFor({
    latest: { 'acme/tools/alpha': 500, 'acme/tools/beta': 300 },
    baseline: { 'acme/tools/alpha': 400, 'acme/tools/beta': 300 },
    coverageDays: 8
  });

  const { window, entries } = computeRanking({ requested: 'custom', days: 30, snapshot });
  assert.equal(window.kind, 'fallback');
  assert.equal(window.actual, '7d');
  assert.match(window.note, /历史不足/);
  assert.equal(entries[0].windowInstalls, 100);
});

test('自定义窗口 with enough history computes the requested period', () => {
  const snapshot = snapshotFor({
    latest: { 'acme/tools/alpha': 900 },
    baseline: { 'acme/tools/alpha': 300 },
    coverageDays: 35
  });

  const { window, entries } = computeRanking({ requested: 'custom', days: 30, snapshot });
  assert.equal(window.kind, 'snapshot');
  assert.equal(window.label, '最近 30 天');
  assert.equal(entries[0].windowInstalls, 600);
});

test('parseWindow clamps custom days and defaults unknown windows to 24 小时', () => {
  assert.deepEqual(
    { key: parseWindow('custom', '999').key, days: parseWindow('custom', '999').days },
    { key: 'custom', days: 90 }
  );
  assert.equal(parseWindow('custom', '0').days, 7);
  assert.equal(parseWindow('nonsense', null).key, '24h');
  assert.equal(parseWindow(undefined, undefined).key, '24h');
});

test('snapshotDelta needs a baseline for windowed growth but not for absolute totals', () => {
  const snapshot = snapshotFor({ latest: { 'a/b/c': 10 }, coverageDays: 3 });
  assert.equal(snapshotDelta(snapshot, 7), null);

  const absolute = snapshotDelta(snapshot, 0);
  assert.equal(absolute[0].windowInstalls, 10);
  assert.equal(absolute[0].source, 'a/b');
  assert.equal(absolute[0].skillId, 'c');
});

test('splitKey keeps owner/repo sources intact', () => {
  assert.deepEqual(splitKey('vercel-labs/skills/find-skills'), {
    key: 'vercel-labs/skills/find-skills',
    source: 'vercel-labs/skills',
    skillId: 'find-skills'
  });
  assert.equal(splitKey('nope'), null);
});
