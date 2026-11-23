/**
 * Snapshot store for the hot ranking: `~/.skillcaddy/cache/hot/`.
 *
 * The user cache — not the library, not the code root, never part of a library
 * image or a sync. It exists for the things the upstream cannot answer:
 * arbitrary `N`-day windows, rolling 24 h after the first day, and the local
 * `firstSeen` date.
 *
 * Files:
 *   snapshots/YYYY-MM-DDTHH.json  { schemaVersion, capturedAt, entries: [{ key, installs }] }
 *   meta.json                     { schemaVersion, firstSeen, lastCaptureAt, lastRefreshAt }
 *
 * Writes are atomic (temp file + rename) and serialized through an in-process
 * promise chain, which is enough because the server is single-process.
 *
 * Retention: hourly for 7 days, then the 00:00 bucket only for 90 days.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SNAPSHOT_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})\.json$/;

export const HOURLY_RETENTION_DAYS = 7;
export const DAILY_RETENTION_DAYS = 90;
const SCHEMA_VERSION = 1;

export function createSnapshotStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new Error('Snapshot store requires a directory');

  const snapshotsDir = path.join(dir, 'snapshots');
  const metaPath = path.join(dir, 'meta.json');
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function readMetaFile() {
    try {
      const parsed = JSON.parse(await readFile(metaPath, 'utf8'));
      return {
        schemaVersion: SCHEMA_VERSION,
        firstSeen: parsed?.firstSeen && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {},
        lastCaptureAt: typeof parsed?.lastCaptureAt === 'string' ? parsed.lastCaptureAt : null,
        lastRefreshAt: typeof parsed?.lastRefreshAt === 'string' ? parsed.lastRefreshAt : null
      };
    } catch {
      return { schemaVersion: SCHEMA_VERSION, firstSeen: {}, lastCaptureAt: null, lastRefreshAt: null };
    }
  }

  async function listSnapshotFiles() {
    let names;
    try {
      names = await readdir(snapshotsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const match = SNAPSHOT_NAME.exec(name);
        if (!match) return null;
        const capturedAt = new Date(`${match[1]}T${match[2]}:00:00.000Z`);
        const stamp = capturedAt.getTime();
        if (!Number.isFinite(stamp)) return null;
        return { name, hour: match[2], capturedAt, stamp };
      })
      .filter(Boolean)
      .sort((left, right) => left.stamp - right.stamp);
  }

  async function readSnapshot(file) {
    try {
      const parsed = JSON.parse(await readFile(path.join(snapshotsDir, file.name), 'utf8'));
      const entries = new Map();
      for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        if (typeof entry?.key !== 'string') continue;
        if (typeof entry?.installs !== 'number' || !Number.isFinite(entry.installs)) continue;
        entries.set(entry.key, Math.trunc(entry.installs));
      }
      return { capturedAt: parsed?.capturedAt || file.capturedAt.toISOString(), stamp: file.stamp, entries };
    } catch {
      return null;
    }
  }

  async function prune(nowMs) {
    const files = await listSnapshotFiles();
    const removals = [];
    for (const file of files) {
      const age = nowMs - file.stamp;
      if (age <= HOURLY_RETENTION_DAYS * DAY_MS) continue;
      if (age <= DAILY_RETENTION_DAYS * DAY_MS && file.hour === '00') continue;
      removals.push(rm(path.join(snapshotsDir, file.name), { force: true }).catch(() => {}));
    }
    await Promise.all(removals);
  }

  return {
    dir,

    /** Capture the cumulative installs of every ranked entry. Serialized and atomic. */
    capture(entries) {
      return enqueue(async () => {
        const nowMs = now();
        const capturedAt = new Date(nowMs);
        const name = `${capturedAt.toISOString().slice(0, 13)}.json`;
        const payload = {
          schemaVersion: SCHEMA_VERSION,
          capturedAt: capturedAt.toISOString(),
          entries: entries
            .filter((entry) => typeof entry?.key === 'string' && Number.isFinite(entry?.installs))
            .map((entry) => ({ key: entry.key, installs: Math.trunc(entry.installs) }))
        };

        await mkdir(snapshotsDir, { recursive: true });
        const tempPath = path.join(snapshotsDir, `.${name}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
        await writeFile(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
        await rename(tempPath, path.join(snapshotsDir, name));

        const meta = await readMetaFile();
        for (const entry of payload.entries) {
          if (!meta.firstSeen[entry.key]) meta.firstSeen[entry.key] = capturedAt.toISOString();
        }
        meta.lastCaptureAt = capturedAt.toISOString();
        await writeMeta(meta);
        await prune(nowMs);
        return { capturedAt: payload.capturedAt, count: payload.entries.length };
      });
    },

    /** Record a successful upstream refresh (drives the `更新于` label). */
    recordRefresh(at = null) {
      return enqueue(async () => {
        const meta = await readMetaFile();
        meta.lastRefreshAt = at || new Date(now()).toISOString();
        await writeMeta(meta);
        return meta.lastRefreshAt;
      });
    },

    meta() {
      return readMetaFile();
    },

    async firstSeen() {
      const meta = await readMetaFile();
      return meta.firstSeen;
    },

    /**
     * Absolute installs at the newest snapshot plus the baseline snapshot at or
     * before `now - days`.
     *
     * `coverageDays` is how far back the store actually reaches, so callers can
     * label a fallback instead of pretending the window was honoured.
     */
    async readWindow(days) {
      const files = await listSnapshotFiles();
      if (files.length === 0) return null;

      const nowMs = now();
      const latestFile = files[files.length - 1];
      const latest = await readSnapshot(latestFile);
      if (!latest) return null;

      const coverageDays = Math.max(0, (nowMs - files[0].stamp) / DAY_MS);
      if (!Number.isFinite(days) || days <= 0) {
        return { latest: latest.entries, baseline: null, coverageDays, latestAt: latest.capturedAt, baselineAt: null };
      }

      const cutoff = nowMs - days * DAY_MS;
      let baselineFile = null;
      for (const file of files) {
        if (file.stamp <= cutoff) baselineFile = file;
      }
      const baseline = baselineFile ? await readSnapshot(baselineFile) : null;

      return {
        latest: latest.entries,
        baseline: baseline ? baseline.entries : null,
        coverageDays,
        latestAt: latest.capturedAt,
        baselineAt: baseline ? baseline.capturedAt : null
      };
    }
  };

  async function writeMeta(meta) {
    const tempPath = `${metaPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await rename(tempPath, metaPath);
  }
}
