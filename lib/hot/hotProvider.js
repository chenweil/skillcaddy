/**
 * The hot ranking provider.
 *
 * The rest of the app talks to this contract and never to an upstream page:
 *
 *   fetchHotRanking({ window, days, force }) →
 *     { source, generatedAt, fetchedAt, stale, window, entries }
 *
 * Two implementations share one shape:
 *   - `skills.sh` (default) — live leaderboard pages through the TTL cache,
 *     degrading to the local snapshot store and then to the bundled snapshot.
 *   - `off` (`SKILLCADDY_HOT_SOURCE=off`) — bundled snapshot only. The escape
 *     hatch for offline use, upstream changes, or terms concerns.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHotCache } from './hotCache.js';
import { computeRanking, parseWindow } from './hotRanking.js';
import { PAGE_TTL_MS, fetchLeaderboardPage } from './skillsShProvider.js';

export const HOT_SOURCE_ENV = 'SKILLCADDY_HOT_SOURCE';
export const LIVE_SOURCE = 'skills.sh';
export const OFFLINE_SOURCE = 'offline';

const CAPTURE_INTERVAL_MS = 10 * 60_000;

/** Which upstream page actually answers a window — only its staleness matters. */
const WINDOW_PAGES = {
  '24h': ['hot'],
  '7d': ['trending'],
  '30d': ['home'],
  '8w': ['home'],
  all: ['home']
};

function primaryPagesFor(windowKey) {
  return WINDOW_PAGES[windowKey] || ['home'];
}

export function resolveHotSource(env = {}) {
  const value = String(env?.[HOT_SOURCE_ENV] ?? '').trim().toLowerCase();
  if (value === 'off' || value === 'false' || value === '0') return OFFLINE_SOURCE;
  return LIVE_SOURCE;
}

export function createHotProvider({
  catalogDir,
  cache = createHotCache(),
  snapshots = null,
  fetchPage = fetchLeaderboardPage,
  userAgent = 'skillcaddy',
  env = process.env,
  now = () => Date.now()
} = {}) {
  if (!catalogDir) throw new Error('Hot provider requires the catalog directory');
  const configuredSource = resolveHotSource(env);
  let fallbackCache = null;
  let lastCaptureMs = 0;

  async function bundledSnapshot() {
    if (fallbackCache) return fallbackCache;
    const parsed = JSON.parse(await readFile(path.join(catalogDir, 'hot-fallback.json'), 'utf8'));
    const entries = normalizeBundledEntries(parsed?.entries);
    const withChange = entries.filter((entry) => entry.change !== null);
    fallbackCache = {
      generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
      pages: {
        home: entries,
        trending: entries,
        hot: withChange.length > 0 ? withChange : entries
      }
    };
    return fallbackCache;
  }

  async function loadLivePages(force) {
    const wanted = ['hot', 'trending', 'home'];
    const results = await Promise.all(
      wanted.map(async (page) => {
        try {
          const loaded = await cache.load(page, {
            ttlMs: PAGE_TTL_MS[page],
            force,
            fetcher: () => fetchPage(page, { userAgent })
          });
          return [page, loaded];
        } catch {
          return [page, null];
        }
      })
    );

    const pages = {};
    let generatedAt = null;
    const stalePages = new Set();
    for (const [page, loaded] of results) {
      if (!loaded) {
        pages[page] = null;
        continue;
      }
      pages[page] = loaded.value?.entries || null;
      if (loaded.stale) stalePages.add(page);
      if (!generatedAt || loaded.fetchedAt > generatedAt) generatedAt = loaded.fetchedAt;
    }
    return { pages, generatedAt, stalePages };
  }

  async function capture(pages) {
    if (!snapshots || !Array.isArray(pages.home) || pages.home.length === 0) return;
    const nowMs = now();
    if (nowMs - lastCaptureMs < CAPTURE_INTERVAL_MS) return;
    lastCaptureMs = nowMs;
    try {
      await snapshots.capture(pages.home.map((entry) => ({ key: entry.key, installs: entry.installs })));
      await snapshots.recordRefresh(new Date(nowMs).toISOString());
    } catch {
      // A cache write failure must never break the ranking response.
    }
  }

  async function rank({ requested, days, pages, source, generatedAt, stale }) {
    const window = parseWindow(requested, days);
    const snapshot = snapshots ? await snapshots.readWindow(window.days ?? 0).catch(() => null) : null;
    const ranking = computeRanking({ requested, days, pages, snapshot });
    return {
      source,
      generatedAt: generatedAt || new Date(now()).toISOString(),
      fetchedAt: new Date(now()).toISOString(),
      stale: Boolean(stale),
      window: ranking.window,
      entries: ranking.entries
    };
  }

  return {
    source: configuredSource,

    async fetchHotRanking({ window = '24h', days, force = false } = {}) {
      if (configuredSource === OFFLINE_SOURCE) {
        const bundled = await bundledSnapshot();
        const ranked = await rank({
          requested: window,
          days,
          pages: bundled.pages,
          source: OFFLINE_SOURCE,
          generatedAt: bundled.generatedAt,
          stale: true
        });
        return { ...ranked, offlineSnapshotAt: bundled.generatedAt };
      }

      const live = await loadLivePages(force);
      const windowDescriptor = parseWindow(window, days);
      const stale = primaryPagesFor(windowDescriptor.key).some((page) => live.stalePages.has(page));
      const liveRanking = await rank({
        requested: windowDescriptor.requested,
        days,
        pages: live.pages,
        source: LIVE_SOURCE,
        generatedAt: live.generatedAt,
        stale
      });

      if (liveRanking.entries.length > 0) {
        await capture(live.pages);
        return liveRanking;
      }

      // Upstream unreachable and nothing cached: serve the bundled snapshot and
      // label it, rather than showing an empty page.
      const bundled = await bundledSnapshot();
      const offline = await rank({
        requested: window,
        days,
        pages: bundled.pages,
        source: OFFLINE_SOURCE,
        generatedAt: bundled.generatedAt,
        stale: true
      });
      return { ...offline, offlineSnapshotAt: bundled.generatedAt, stale: true };
    },

    /** Force a refresh of every page. Rate limiting lives in the HTTP layer. */
    async refresh() {
      if (configuredSource === OFFLINE_SOURCE) {
        return { source: OFFLINE_SOURCE, refreshed: false };
      }
      const live = await loadLivePages(true);
      await capture(live.pages);
      return {
        source: LIVE_SOURCE,
        refreshed: true,
        generatedAt: live.generatedAt,
        stalePages: [...live.stalePages]
      };
    },

    /** Ranked entries for the same upstream source, used by the detail page. */
    async sameSourceEntries(source) {
      const ranking = await this.fetchHotRanking({ window: 'all', force: false });
      return ranking.entries.filter((entry) => entry.source === source);
    },

    cache,
    snapshots,
    bundledSnapshot
  };
}

function normalizeBundledEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = typeof item.source === 'string' ? item.source.trim() : '';
    const skillId = typeof item.skillId === 'string' ? item.skillId.trim() : '';
    if (!source || !skillId) continue;
    const key = `${source}/${skillId}`;
    if (seen.has(key)) continue;
    if (typeof item.installs !== 'number' || !Number.isFinite(item.installs) || item.installs < 0) continue;
    seen.add(key);
    entries.push({
      key,
      source,
      skillId,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : skillId,
      installs: Math.trunc(item.installs),
      change: typeof item.change === 'number' && Number.isFinite(item.change) ? Math.max(0, Math.trunc(item.change)) : null,
      weeklyInstalls: Array.isArray(item.weeklyInstalls)
        ? item.weeklyInstalls.filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0).slice(-8)
        : null,
      isOfficial: item.isOfficial === true
    });
  }
  return entries;
}
