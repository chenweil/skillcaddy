import { access } from 'node:fs/promises';
import path from 'node:path';
import { inspectGitSource } from './sourceGit.js';
import { SourceMigrationIssue } from './sourceMigrationIssue.js';
import { readSourceRecords, writeSourceRecord } from './sourceRegistry.js';
import { validateSourceRecord } from './sourceRecord.js';
import { scanSkills } from './skillStore.js';
import {
  checksumDirectory,
  findSourceEntries,
  validateSourceTree
} from './sourceTree.js';

export async function buildSourceMigrationPlan(rootDir) {
  const [registered, skills] = await Promise.all([
    readSourceRecords(rootDir),
    scanSkills(rootDir)
  ]);
  const registeredPaths = new Set(registered.map((record) => record.installPath));
  const records = [];
  const unresolved = [];

  for (const entry of await findSourceEntries(rootDir)) {
    if (registeredPaths.has(entry.installPath)) continue;
    try {
      const record = await buildMigrationRecord(rootDir, entry, skills);
      records.push(validateSourceRecord(rootDir, record));
    } catch (error) {
      unresolved.push({
        installPath: entry.installPath,
        reason: resolveIssueReason(error),
        detail: error.message
      });
    }
  }

  removeDuplicateIdentities(records, unresolved, registered);
  return {
    dryRun: true,
    records: records.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    unresolved: unresolved.sort((left, right) => left.installPath.localeCompare(right.installPath))
  };
}

export async function applySourceMigrationPlan(rootDir, plan) {
  assertMigrationPlan(plan);
  const registered = await readSourceRecords(rootDir);
  const registeredById = new Map(registered.map((record) => [record.sourceId, record]));
  const currentPlan = await buildSourceMigrationPlan(rootDir);
  const currentById = new Map(currentPlan.records.map((record) => [record.sourceId, record]));
  const pending = [];
  const unchanged = [];

  for (const requestedRecord of plan.records) {
    const validated = validateSourceRecord(rootDir, requestedRecord);
    const existing = registeredById.get(validated.sourceId);
    if (existing) {
      if (!recordsEqual(existing, validated)) {
        throw new Error(`Source migration plan conflicts with registered source: ${validated.sourceId}`);
      }
      unchanged.push(validated.sourceId);
      continue;
    }

    const current = currentById.get(validated.sourceId);
    if (!current || !recordsEqual(current, validated)) {
      throw new Error(`Source migration plan is stale for: ${validated.sourceId}`);
    }
    pending.push(validated);
  }

  for (const record of pending) await writeSourceRecord(rootDir, record);
  return {
    dryRun: false,
    written: pending.map((record) => record.sourceId),
    unchanged,
    unresolved: plan.unresolved
  };
}

async function buildMigrationRecord(rootDir, entry, skills) {
  if (entry.unsafe) {
    throw new SourceMigrationIssue('unsafe-path', 'Source entry is a symbolic link');
  }
  await validateSourceTree(rootDir, entry.sourcePath);
  const discoveredSkills = discoverEntrySkills(rootDir, entry.installPath, skills);
  if (discoveredSkills.length === 0) {
    throw new Error('No skills discovered by the existing state scanner');
  }

  try {
    return await buildGitRecord(entry, discoveredSkills);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return buildLegacyLocalRecord(entry, discoveredSkills);
}

async function buildGitRecord(entry, discoveredSkills) {
  await access(path.join(entry.sourcePath, '.git'));
  const git = await inspectGitSource(entry.sourcePath);
  return {
    schemaVersion: 1,
    sourceId: git.sourceId,
    bucket: 'github',
    type: 'git',
    installPath: entry.installPath,
    origin: git.origin,
    skills: discoveredSkills
  };
}

async function buildLegacyLocalRecord(entry, discoveredSkills) {
  return {
    schemaVersion: 1,
    sourceId: entry.installPath,
    bucket: entry.bucket,
    type: 'legacy-local',
    installPath: entry.installPath,
    origin: { kind: 'unknown' },
    integrity: {
      algorithm: 'sha256',
      value: await checksumDirectory(entry.sourcePath)
    },
    skills: discoveredSkills
  };
}

function discoverEntrySkills(rootDir, installPath, skills) {
  const sourcePath = path.join(rootDir, installPath);
  return skills
    .map((skill) => path.relative(sourcePath, skill.path))
    .filter((relative) => !relative.startsWith('..') && !path.isAbsolute(relative))
    .map((relative) => relative ? relative.split(path.sep).join('/') : '.')
    .sort();
}

function removeDuplicateIdentities(records, unresolved, registered) {
  const pathsById = new Map();
  for (const record of [...registered, ...records]) {
    const paths = pathsById.get(record.sourceId) || [];
    paths.push(record.installPath);
    pathsById.set(record.sourceId, paths);
  }

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const paths = [...new Set(pathsById.get(record.sourceId))];
    if (paths.length < 2) continue;
    records.splice(index, 1);
    unresolved.push({
      installPath: record.installPath,
      reason: 'duplicate-identity',
      detail: `Source identity ${record.sourceId} also resolves from: ${paths.join(', ')}`
    });
  }
}

function resolveIssueReason(error) {
  if (error.reason) return error.reason;
  return /Invalid sourceId/.test(error.message) ? 'invalid-identity' : 'unresolved-source';
}

function assertMigrationPlan(plan) {
  if (!plan || plan.dryRun !== true || !Array.isArray(plan.records) || !Array.isArray(plan.unresolved)) {
    throw new Error('A source migration plan is required');
  }
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
