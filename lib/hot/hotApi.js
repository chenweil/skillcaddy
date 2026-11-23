/**
 * Application layer for the hot surface: ranking, detail, install, refresh.
 *
 * Everything the HTTP layer needs, with no request/response objects involved,
 * so tests can drive it directly. The allowlist rules live here:
 *
 *   - The web surface may only install a source that is present in the current
 *     hot data or in the curated overrides.
 *   - The source must be a GitHub `owner/repo`; the URL is constructed here.
 *   - Non-GitHub sources are visible but not installable.
 */

import { canonicalGitRepositoryLocation } from '../sourceGitUrl.js';
import {
  findInstalledRecord,
  isInstallableSource,
  readInstalledIndex,
  sourceError,
  sourceRepositoryUrl
} from '../catalog.js';
import { CATEGORIES, categoryLabel, createMetadataLoader, isGitHubSource } from './hotMetadata.js';
import { findRecordByLocation, readSkillPreview } from './skillPreview.js';

export const FORCED_REFRESH_INTERVAL_MS = 30_000;
const RELATED_LIMIT = 6;

export function createHotApi({
  libraryRoot,
  catalogDir,
  provider,
  installer,
  metadata = createMetadataLoader({ catalogDir }),
  snapshots = provider?.snapshots || null,
  now = () => Date.now()
} = {}) {
  if (!libraryRoot) throw new Error('Hot API requires the library root');
  if (!provider) throw new Error('Hot API requires a hot provider');

  let lastForcedRefreshMs = 0;

  async function installedIndex() {
    return readInstalledIndex(libraryRoot).catch(() => new Map());
  }

  function withInstallState(entries, index) {
    return entries.map((entry) => ({
      ...entry,
      installed: Boolean(findInstalledRecord(index, entry.source)),
      installable: isInstallableSource(entry.source)
    }));
  }

  async function ranking({ window, days, category } = {}) {
    const ranked = await provider.fetchHotRanking({ window, days });
    const decorated = await metadata.decorateList(ranked.entries);
    const index = await installedIndex();
    const entries = withInstallState(decorated.entries, index);
    const filtered = category && category !== 'all'
      ? entries.filter((entry) => entry.category === category)
      : entries;

    return {
      generatedAt: ranked.generatedAt,
      fetchedAt: ranked.fetchedAt,
      source: ranked.source,
      stale: Boolean(ranked.stale),
      offlineSnapshotAt: ranked.offlineSnapshotAt || null,
      window: ranked.window,
      categories: decorated.categories,
      total: filtered.length,
      windowTotal: entries.length,
      entries: filtered
    };
  }

  async function detail({ source, skill, window = '24h', days } = {}) {
    if (!source) throw sourceError('invalid_request', 'source 必须指定');
    const all = await provider.fetchHotRanking({ window: 'all' });
    let entry = findEntry(all.entries, source, skill);
    let ranked = all;

    if (!entry) {
      ranked = await provider.fetchHotRanking({ window: '24h' });
      entry = findEntry(ranked.entries, source, skill);
    }

    const overrides = await metadata.overrides();
    const key = entry?.key || `${source}/${skill || ''}`;
    const decorated = entry
      ? await metadata.decorate(entry)
      : await metadata.decorate({
          key,
          source,
          skillId: skill,
          name: skill,
          installs: 0,
          windowInstalls: 0,
          isOfficial: false,
          rank: null
        });

    const index = await installedIndex();
    const record = findInstalledRecord(index, source);
    const sourceType = isGitHubSource(source) ? 'git' : 'external';
    const firstSeenMap = snapshots ? await snapshots.firstSeen().catch(() => ({})) : {};
    const skillMd = record ? await readSkillPreview({ libraryRoot, record, skillId: decorated.skillId }) : null;

    const [sameSource, related, windowRanking] = await Promise.all([
      skillsInSource(source, decorated.skillId),
      relatedEntries(decorated),
      provider.fetchHotRanking({ window, days }).catch(() => null)
    ]);

    const windowEntry = windowRanking
      ? findEntry(windowRanking.entries, source, decorated.skillId)
      : null;

    return {
      entry: {
        ...decorated,
        windowInstalls: windowEntry ? windowEntry.windowInstalls : decorated.windowInstalls,
        rank: windowEntry ? windowEntry.rank : decorated.rank,
        installed: Boolean(record),
        installable: isInstallableSource(source)
      },
      window: windowRanking?.window || { requested: window, actual: window, label: window, kind: 'fixed', note: null },
      installed: Boolean(record),
      installedSourceId: record?.sourceId || null,
      sourceType,
      sourceTypeLabel: sourceType === 'git' ? 'Git' : '外部来源',
      repositoryUrl: sourceRepositoryUrl(source),
      sourceUrl: decorated.homepage,
      validation: buildValidation(decorated, record),
      skills: sameSource,
      skillMd: skillMd || { available: false },
      related,
      firstSeen: firstSeenMap[key] || null,
      updatedAt: ranked.generatedAt,
      stale: Boolean(ranked.stale)
    };
  }

  async function skillsInSource(source, currentSkillId) {
    const ranked = await provider.fetchHotRanking({ window: 'all' });
    const entries = ranked.entries.filter((entry) => entry.source === source);
    const decorated = await metadata.decorateList(entries);
    return decorated.entries
      .sort((left, right) => right.installs - left.installs)
      .map((entry) => ({
        skillId: entry.skillId,
        name: entry.displayName,
        description: entry.description,
        current: entry.skillId === currentSkillId
      }));
  }

  async function relatedEntries(entry) {
    const ranked = await provider.fetchHotRanking({ window: 'all' });
    const decorated = await metadata.decorateList(ranked.entries);
    return decorated.entries
      .filter((candidate) => candidate.category === entry.category && candidate.source !== entry.source)
      .slice(0, RELATED_LIMIT)
      .map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        skillId: candidate.skillId,
        displayName: candidate.displayName,
        description: candidate.description,
        category: candidate.category,
        categoryLabel: candidate.categoryLabel,
        windowInstalls: candidate.windowInstalls,
        installs: candidate.installs
      }));
  }

  async function assertAllowlisted(source) {
    if (!isInstallableSource(source)) {
      throw sourceError('unsupported_source', `暂不支持一键添加：${source}`);
    }

    const overrides = await metadata.overrides();
    if (overrides.sources?.[source]) return;
    const overrideKeys = Object.keys(overrides.skills || {});
    if (overrideKeys.some((key) => key.startsWith(`${source}/`))) return;

    for (const window of ['all', '24h']) {
      const ranked = await provider.fetchHotRanking({ window });
      if (ranked.entries.some((entry) => entry.source === source)) return;
    }

    throw sourceError('unknown_source', `热门列表里没有该来源：${source}`);
  }

  async function install({ source }) {
    if (typeof source !== 'string' || !source.trim()) {
      throw sourceError('invalid_request', 'source 必须指定');
    }
    const normalized = source.trim();
    await assertAllowlisted(normalized);

    if (!installer) throw sourceError('install_unavailable', '安装管线未启用');
    const result = await installer.run(normalized);
    return {
      ...result,
      source: normalized,
      repositoryUrl: sourceRepositoryUrl(normalized)
    };
  }

  async function refresh() {
    const nowMs = now();
    const elapsed = nowMs - lastForcedRefreshMs;
    if (lastForcedRefreshMs > 0 && elapsed < FORCED_REFRESH_INTERVAL_MS) {
      throw sourceError('rate_limited', `强制刷新过于频繁，请 ${Math.ceil((FORCED_REFRESH_INTERVAL_MS - elapsed) / 1000)} 秒后重试`);
    }
    lastForcedRefreshMs = nowMs;
    const result = await provider.refresh();
    return { ...result, refreshedAt: new Date(nowMs).toISOString() };
  }

  return {
    ranking,
    detail,
    install,
    refresh,
    categories: CATEGORIES,
    categoryLabel,
    resolveRecord: (source) => findRecordByLocation(libraryRoot, source, canonicalGitRepositoryLocation)
  };
}

function findEntry(entries, source, skill) {
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => {
    if (entry.source !== source) return false;
    if (!skill) return true;
    return entry.skillId === skill || entry.name === skill;
  }) || null;
}

function buildValidation(entry, record) {
  return {
    sourceReview: entry.verified ? '已审核' : '未审核',
    formatCheck: record ? `已登记 ${record.skills.length} 个 skill` : '未登记',
    execution: '不执行',
    integrity: record?.integrity ? '已登记' : null
  };
}
