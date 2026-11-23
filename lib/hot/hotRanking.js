/**
 * Window computation for the hot ranking.
 *
 * The upstream exposes three different views of the same leaderboard, and each
 * answers a different window. Everything that decides "what does 24 小时 mean"
 * lives here, including the honest degradation when a page is missing:
 *
 *   24 小时  /hot `change`
 *   7 天     /trending `installs`
 *   30 天    / `weeklyInstalls` — the latest four buckets (28 days)
 *   8 周     / `weeklyInstalls` — all eight buckets (56 days)
 *   全部     / `installs`
 *   自定义 N 本地快照增量；历史不足时退回最近的可计算窗口并在 note 里说明
 *
 * Pure functions only: no I/O, no cache, no clock. Callers pass the pages and
 * an optional snapshot window.
 */

export const WINDOW_OPTIONS = [
  { key: '24h', label: '24 小时', days: 1 },
  { key: '7d', label: '7 天', days: 7 },
  { key: '30d', label: '30 天', days: 30 },
  { key: '8w', label: '8 周', days: 56 },
  { key: 'all', label: '全部', days: null }
];

export const CUSTOM_WINDOW_MAX_DAYS = 90;
const WEEK_BUCKETS_FOR_30D = 4;

/** Normalize a `window` / `days` query pair into a window descriptor. */
export function parseWindow(rawWindow, rawDays) {
  if (rawWindow === 'custom') {
    const parsed = Number.parseInt(rawDays, 10);
    const days = Number.isFinite(parsed) && parsed > 0
      ? Math.min(CUSTOM_WINDOW_MAX_DAYS, parsed)
      : 7;
    return { requested: 'custom', key: 'custom', days, label: `最近 ${days} 天`, kind: 'custom' };
  }

  const option = WINDOW_OPTIONS.find((candidate) => candidate.key === rawWindow);
  if (option) {
    return { requested: option.key, key: option.key, days: option.days, label: option.label, kind: 'fixed' };
  }

  const fallback = WINDOW_OPTIONS[0];
  return {
    requested: typeof rawWindow === 'string' && rawWindow ? rawWindow : fallback.key,
    key: fallback.key,
    days: fallback.days,
    label: fallback.label,
    kind: 'fixed'
  };
}

/**
 * Rank entries for a window.
 *
 * @param {object} input
 * @param {string} input.requested       raw `window` parameter
 * @param {string|number} [input.days]   raw `days` parameter (custom windows)
 * @param {{hot?: Array|null, trending?: Array|null, home?: Array|null}} input.pages
 * @param {object|null} [input.snapshot] result of snapshotStore.readWindow(days)
 */
export function computeRanking({ requested, days, pages = {}, snapshot = null }) {
  const window = parseWindow(requested, days);
  const homeMap = indexByKey(pages.home);
  const trendingMap = indexByKey(pages.trending);
  const hotMap = indexByKey(pages.hot);

  const cumulativeOf = (entry) =>
    homeMap.get(entry.key)?.installs ?? trendingMap.get(entry.key)?.installs ?? hotMap.get(entry.key)?.installs ?? entry.installs;

  const computed = window.key === 'custom'
    ? customWindow(window, snapshot, { homeMap, cumulativeOf })
    : fixedWindow(window, { pages, snapshot, homeMap, cumulativeOf });

  if (!computed) {
    return {
      window: { ...window, actual: window.key, actualLabel: window.label, note: '暂无数据' },
      entries: []
    };
  }

  const entries = rankEntries(computed.rows);
  return {
    window: {
      requested: window.requested,
      actual: computed.actual,
      actualLabel: computed.actualLabel,
      label: computed.actualLabel,
      kind: computed.kind,
      note: computed.note || null
    },
    entries
  };
}

/** Growth between the newest snapshot and the baseline, clamped at 0. */
export function snapshotDelta(snapshot, days) {
  if (!snapshot?.latest) return null;
  if (days > 0 && !snapshot.baseline) return null;

  const rows = [];
  for (const [key, installs] of snapshot.latest) {
    const baseline = days > 0 ? snapshot.baseline.get(key) : 0;
    const growth = Math.max(0, installs - (baseline ?? installs));
    const identity = splitKey(key);
    if (!identity) continue;
    rows.push({
      ...identity,
      name: identity.skillId,
      installs,
      windowInstalls: days > 0 ? growth : installs,
      isOfficial: false
    });
  }
  return rows;
}

function fixedWindow(window, { pages, snapshot, homeMap, cumulativeOf }) {
  switch (window.key) {
    case '24h': {
      const rows = fromEntries(pages.hot, (entry) => Math.max(0, entry.change ?? 0), cumulativeOf);
      if (rows) return { rows, actual: '24h', actualLabel: window.label, kind: 'upstream' };

      const delta = snapshotDelta(snapshot, 1);
      if (delta) {
        return { rows: delta, actual: '24h', actualLabel: window.label, kind: 'snapshot' };
      }

      const weekly = fromEntries(pages.trending, (entry) => entry.installs, cumulativeOf);
      if (weekly) {
        return {
          rows: weekly,
          actual: '7d',
          actualLabel: '7 天',
          kind: 'fallback',
          note: '24 小时数据不可用，暂用 7 天'
        };
      }
      return null;
    }

    case '7d': {
      const rows = fromEntries(pages.trending, (entry) => entry.installs, cumulativeOf);
      if (rows) return { rows, actual: '7d', actualLabel: window.label, kind: 'upstream' };

      const weekly = fromWeeklyBuckets(pages.home, 1, cumulativeOf);
      if (weekly) return { rows: weekly, actual: '7d', actualLabel: window.label, kind: 'derived' };

      const delta = snapshotDelta(snapshot, 7);
      if (delta) return { rows: delta, actual: '7d', actualLabel: window.label, kind: 'snapshot' };
      return null;
    }

    case '30d': {
      const rows = fromWeeklyBuckets(pages.home, WEEK_BUCKETS_FOR_30D, cumulativeOf);
      if (rows) return { rows, actual: '30d', actualLabel: window.label, kind: 'derived' };

      const delta = snapshotDelta(snapshot, 30);
      if (delta) return { rows: delta, actual: '30d', actualLabel: window.label, kind: 'snapshot' };

      const weekly = fromEntries(pages.trending, (entry) => entry.installs, cumulativeOf);
      if (weekly) {
        return { rows: weekly, actual: '7d', actualLabel: '7 天', kind: 'fallback', note: '30 天数据不可用，暂用 7 天' };
      }
      return null;
    }

    case '8w': {
      const rows = fromWeeklyBuckets(pages.home, Infinity, cumulativeOf);
      if (rows) return { rows, actual: '8w', actualLabel: window.label, kind: 'derived' };

      const delta = snapshotDelta(snapshot, 56);
      if (delta) return { rows: delta, actual: '8w', actualLabel: window.label, kind: 'snapshot' };
      return null;
    }

    case 'all':
    default: {
      const rows = fromEntries(pages.home, (entry) => entry.installs, cumulativeOf);
      if (rows) return { rows, actual: 'all', actualLabel: window.label, kind: 'upstream' };

      const absolute = snapshotDelta(snapshot, 0);
      if (absolute) {
        return {
          rows: absolute,
          actual: 'all',
          actualLabel: window.label,
          kind: 'snapshot',
          note: '累计安装数来自本地快照'
        };
      }
      return null;
    }
  }
}

function customWindow(window, snapshot, { homeMap, cumulativeOf }) {
  if (!snapshot) return null;

  const exact = snapshotDelta(snapshot, window.days);
  if (exact && snapshot.coverageDays >= window.days) {
    return { rows: exact, actual: 'custom', actualLabel: window.label, kind: 'snapshot' };
  }

  // Not enough history: use the largest computable fixed window below N and say so.
  const candidates = WINDOW_OPTIONS
    .filter((option) => option.days && option.days <= window.days)
    .sort((left, right) => right.days - left.days);

  for (const candidate of candidates) {
    const series = snapshotDelta(snapshot, candidate.days);
    if (series && snapshot.coverageDays >= candidate.days) {
      return {
        rows: series,
        actual: candidate.key,
        actualLabel: candidate.label,
        kind: 'fallback',
        note: `历史不足，暂用 ${candidate.label.replace(/\s/g, ' ')}`
      };
    }
  }

  const rows = fromEntriesFromSnapshotAbsolute(snapshot, cumulativeOf, homeMap);
  if (rows) {
    return {
      rows,
      actual: 'all',
      actualLabel: '全部',
      kind: 'fallback',
      note: '历史不足，暂用全部'
    };
  }
  return null;
}

function fromEntriesFromSnapshotAbsolute(snapshot, cumulativeOf, homeMap) {
  const rows = snapshotDelta(snapshot, 0);
  if (!rows) return null;
  return rows.map((row) => ({
    ...row,
    installs: homeMap.get(`${row.source}/${row.skillId}`)?.installs ?? row.installs,
    windowInstalls: cumulativeOf(row)
  }));
}

function fromEntries(entries, metric, cumulativeOf) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.map((entry) => ({
    key: entry.key,
    source: entry.source,
    skillId: entry.skillId,
    name: entry.name,
    installs: cumulativeOf(entry),
    windowInstalls: metric(entry),
    isOfficial: Boolean(entry.isOfficial)
  }));
}

function fromWeeklyBuckets(entries, bucketCount, cumulativeOf) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const usable = entries.filter((entry) => Array.isArray(entry.weeklyInstalls) && entry.weeklyInstalls.length > 0);
  if (usable.length === 0) return null;

  return usable.map((entry) => {
    const buckets = entry.weeklyInstalls.slice(-Math.min(bucketCount, entry.weeklyInstalls.length));
    return {
      key: entry.key,
      source: entry.source,
      skillId: entry.skillId,
      name: entry.name,
      installs: cumulativeOf(entry),
      windowInstalls: buckets.reduce((total, value) => total + value, 0),
      isOfficial: Boolean(entry.isOfficial)
    };
  });
}

function rankEntries(rows) {
  const deduped = new Map();
  for (const row of rows) {
    if (!row?.key) continue;
    const existing = deduped.get(row.key);
    if (!existing || row.windowInstalls > existing.windowInstalls) deduped.set(row.key, row);
  }

  return [...deduped.values()]
    .sort((left, right) =>
      right.windowInstalls - left.windowInstalls ||
      right.installs - left.installs ||
      left.name.localeCompare(right.name)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function indexByKey(entries) {
  const map = new Map();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.key) map.set(entry.key, entry);
    }
  }
  return map;
}

/** `owner/repo/skill` → `{ source: 'owner/repo', skillId: 'skill' }`. */
export function splitKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.lastIndexOf('/');
  if (at <= 0 || at === key.length - 1) return null;
  return { key, source: key.slice(0, at), skillId: key.slice(at + 1) };
}
