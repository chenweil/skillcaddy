/**
 * Catalog surface for the hot page: installed detection and the install
 * pipeline.
 *
 * Two rules from the design are structural here, not cosmetic:
 *
 *   1. **Installed is derived from the source registry**, never from a hot-list
 *      flag. Comparison goes through `canonicalGitRepositoryLocation()`, so
 *      HTTPS, SSH, `.git`, and tree URL variants are the same source.
 *   2. **Adding means source acquisition into the library root only.** No
 *      project, global, Hermes, or Claude enablement link is ever created here.
 */

import { canonicalGitRepositoryLocation } from './sourceGitUrl.js';
import { applyAddSource, planAddSource } from './sourceManager.js';
import { readSourceRecords } from './sourceRegistry.js';

/** GitHub `owner/repo`. The server builds the URL; the client never supplies one. */
export const GITHUB_SOURCE_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const MAX_CONCURRENT_INSTALLS = 2;

export function isInstallableSource(source) {
  return typeof source === 'string' && GITHUB_SOURCE_PATTERN.test(source);
}

export function sourceRepositoryUrl(source) {
  if (!isInstallableSource(source)) return null;
  return `https://github.com/${source}.git`;
}

export function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Canonical `host/owner/repo` for every registered Git source.
 * Records whose remote cannot be parsed are skipped rather than guessed at.
 */
export function buildInstalledIndex(records) {
  const index = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.type !== 'git' || typeof record?.origin?.remote !== 'string') continue;
    let location;
    try {
      location = canonicalGitRepositoryLocation(record.origin.remote);
    } catch {
      continue;
    }
    if (!index.has(location)) index.set(location, record);
  }
  return index;
}

export function findInstalledRecord(index, source) {
  if (!index || !isInstallableSource(source)) return null;
  let location;
  try {
    location = canonicalGitRepositoryLocation(`https://github.com/${source}.git`);
  } catch {
    return null;
  }
  return index.get(location) || null;
}

export async function readInstalledIndex(libraryRoot) {
  return buildInstalledIndex(await readSourceRecords(libraryRoot));
}

/**
 * Install queue: dedupe by source, at most `concurrency` acquisitions at once.
 *
 * `plan`/`apply` are injectable so tests exercise the allowlist and the
 * dedupe without running git.
 */
export function createSourceInstaller({
  libraryRoot,
  concurrency = MAX_CONCURRENT_INSTALLS,
  plan = planAddSource,
  apply = applyAddSource,
  readRecords = readSourceRecords
} = {}) {
  if (!libraryRoot) throw new Error('Source installer requires the library root');

  const inFlight = new Map();
  const waiting = [];
  let active = 0;

  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  async function run(source) {
    if (!isInstallableSource(source)) {
      throw sourceError('unsupported_source', `暂不支持一键添加：${source}`);
    }

    const index = buildInstalledIndex(await readRecords(libraryRoot));
    const installed = findInstalledRecord(index, source);
    if (installed) {
      return { status: 'already-installed', sourceId: installed.sourceId, installPath: installed.installPath };
    }

    const existing = inFlight.get(source);
    if (existing) return existing;

    const task = (async () => {
      await acquire();
      try {
        const context = { rootDir: libraryRoot };
        const planResult = await plan(context, { input: sourceRepositoryUrl(source) });
        const result = await apply(context, planResult);
        return {
          status: result.status === 'already-installed' ? 'already-installed' : 'installed',
          sourceId: result.sourceId,
          installPath: result.installPath,
          skills: result.skills,
          warnings: result.warnings
        };
      } finally {
        release();
      }
    })();

    inFlight.set(source, task);
    try {
      return await task;
    } finally {
      inFlight.delete(source);
    }
  }

  return {
    run,
    get inFlightCount() {
      return inFlight.size;
    },
    get activeCount() {
      return active;
    }
  };
}
