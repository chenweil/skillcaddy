/**
 * Metadata enrichment for hot entries.
 *
 * The leaderboard only knows source, skill, and install counts. Descriptions,
 * categories, covers, stars, and verification are curated in
 * `catalog/overrides.json`, merged with this precedence:
 *
 *   1. skill override
 *   2. source override
 *   3. defaults (display name = name, description = 来自 <source> 的 skill,
 *      category = other, cover = generated, verified = false)
 *
 * Nothing here invents a number: a missing star count stays missing so the UI
 * can hide the metric instead of showing a fabricated one.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const CATEGORIES = [
  { key: 'engineering', label: '工程开发' },
  { key: 'design', label: '设计与视频' },
  { key: 'product', label: '产品与项目' },
  { key: 'content', label: '内容与知识' },
  { key: 'writing', label: '写作与研究' },
  { key: 'growth', label: '营销增长' },
  { key: 'docs', label: '文档与幻灯片' },
  { key: 'other', label: '其他' }
];

export const CATEGORY_KEYS = new Set(CATEGORIES.map((category) => category.key));
export const FALLBACK_CATEGORY = 'other';
export const MAX_DESCRIPTION_LENGTH = 280;
export const MAX_TAGS = 5;

export function categoryLabel(key) {
  return CATEGORIES.find((category) => category.key === key)?.label || CATEGORIES.at(-1).label;
}

export function normalizeCategory(value) {
  return typeof value === 'string' && CATEGORY_KEYS.has(value) ? value : FALLBACK_CATEGORY;
}

/**
 * Read `catalog/overrides.json`, cached in memory and invalidated by mtime so
 * editing the curated file does not need a server restart.
 */
export function createMetadataLoader({ catalogDir }) {
  let cache = { mtimeMs: -1, value: emptyOverrides() };

  return {
    async overrides() {
      if (!catalogDir) return emptyOverrides();
      const filePath = path.join(catalogDir, 'overrides.json');
      try {
        const info = await stat(filePath);
        if (info.mtimeMs === cache.mtimeMs) return cache.value;
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        cache = { mtimeMs: info.mtimeMs, value: normalizeOverrides(parsed) };
        return cache.value;
      } catch {
        return emptyOverrides();
      }
    },

    /** Merge one ranked entry with its overrides into the API entry shape. */
    async decorate(entry) {
      const overrides = await this.overrides();
      return decorateEntry(entry, overrides);
    },

    /** Decorate a list and attach category counts computed from that list. */
    async decorateList(entries) {
      const overrides = await this.overrides();
      const decorated = entries.map((entry) => decorateEntry(entry, overrides));
      return { entries: decorated, categories: countCategories(decorated) };
    }
  };
}

export function emptyOverrides() {
  return { schemaVersion: 1, updatedAt: null, sources: {}, skills: {} };
}

export function normalizeOverrides(parsed) {
  const sources = {};
  const skills = {};
  for (const [key, value] of Object.entries(parsed?.sources || {})) {
    if (value && typeof value === 'object') sources[key] = value;
  }
  for (const [key, value] of Object.entries(parsed?.skills || {})) {
    if (value && typeof value === 'object') skills[key] = value;
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    sources,
    skills
  };
}

export function decorateEntry(entry, overrides) {
  const skillOverride = overrides.skills?.[entry.key] || {};
  const sourceOverride = overrides.sources?.[entry.source] || {};

  const description = clampDescription(
    skillOverride.description || sourceOverride.description || `来自 ${entry.source} 的 skill`
  );
  const category = normalizeCategory(skillOverride.category || sourceOverride.category);
  const stars = firstFinite(skillOverride.stars, sourceOverride.stars);
  const tags = normalizeTags(skillOverride.tags || sourceOverride.tags);

  return {
    id: entry.key,
    source: entry.source,
    skillId: entry.skillId,
    name: entry.name,
    displayName: str(skillOverride.displayName) || entry.name,
    description,
    category,
    categoryLabel: categoryLabel(category),
    cover: coverUrl(skillOverride.cover || sourceOverride.cover),
    installs: entry.installs,
    windowInstalls: entry.windowInstalls,
    stars,
    starsCapturedAt: stars === null ? null : str(skillOverride.starsCapturedAt) || str(sourceOverride.starsCapturedAt),
    verified: Boolean(skillOverride.verified ?? sourceOverride.verified ?? false),
    official: Boolean(entry.isOfficial),
    homepage: str(skillOverride.homepage) || str(sourceOverride.homepage) || defaultHomepage(entry.source),
    author: entry.source.includes('/') ? entry.source.split('/')[0] : entry.source,
    tags,
    rank: entry.rank
  };
}

export function countCategories(entries) {
  const counts = new Map(CATEGORIES.map((category) => [category.key, 0]));
  for (const entry of entries) {
    const key = normalizeCategory(entry.category);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return CATEGORIES
    .map((category) => ({ ...category, count: counts.get(category.key) || 0 }))
    .filter((category) => category.count > 0);
}

function coverUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const clean = value.trim().replace(/^\/+/, '');
  if (!/^covers\/[A-Za-z0-9._-]+\.(webp|png|jpg|jpeg)$/i.test(clean)) return null;
  return `/catalog-assets/${clean}`;
}

function defaultHomepage(source) {
  return isGitHubSource(source) ? `https://github.com/${source}` : `https://${source}`;
}

export function isGitHubSource(source) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag) => typeof tag === 'string' && tag.trim())
    .map((tag) => tag.trim().slice(0, 24))
    .slice(0, MAX_TAGS);
}

function clampDescription(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return null;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
