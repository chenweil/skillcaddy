import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  readFile,
  readdir,
  readlink,
  realpath
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readSourceRecords, writeSourceRecord } from './sourceRegistry.js';
import { sanitizeGitRemote, validateSourceRecord } from './sourceRecord.js';
import { SOURCE_FOLDERS } from './sourcePolicy.js';
import { scanSkills } from './skillStore.js';

const execFile = promisify(execFileCallback);

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
        reason: error.reason || 'unresolved-source',
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
  if (!plan || plan.dryRun !== true || !Array.isArray(plan.records) || !Array.isArray(plan.unresolved)) {
    throw new Error('A source migration plan is required');
  }

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
  if (entry.unsafe) throw new MigrationConflict('unsafe-path', 'Source entry is a symbolic link');
  await validateSourceTree(rootDir, entry.sourcePath);
  const discoveredSkills = discoverEntrySkills(rootDir, entry.installPath, skills);
  if (discoveredSkills.length === 0) throw new Error('No skills discovered by the existing state scanner');

  if (await pathExists(path.join(entry.sourcePath, '.git'))) {
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

async function inspectGitSource(sourcePath) {
  let remoteOutput;
  try {
    ({ stdout: remoteOutput } = await execFile('git', [
      '-C',
      sourcePath,
      'remote',
      'get-url',
      '--all',
      'origin'
    ]));
  } catch {
    throw new MigrationConflict('ambiguous-remote', 'Git source has no readable origin remote');
  }
  const remotes = [...new Set(
    remoteOutput.split('\n').map((remote) => remote.trim()).filter(Boolean)
  )];
  if (remotes.length !== 1) {
    throw new MigrationConflict('ambiguous-remote', 'Git source must have one unambiguous origin remote');
  }

  let remote;
  let repositoryPath;
  try {
    remote = sanitizeGitRemote(remotes[0]);
    repositoryPath = parseRepositoryPath(remote);
  } catch (error) {
    throw new MigrationConflict('ambiguous-remote', error.message);
  }
  const { stdout: commitOutput } = await execFile('git', ['-C', sourcePath, 'rev-parse', 'HEAD']);
  const ref = await readGitRef(sourcePath);

  return {
    sourceId: `github/${repositoryPath}`,
    origin: {
      kind: 'git',
      remote,
      ...(ref ? { ref } : {}),
      commit: commitOutput.trim()
    }
  };
}

function parseRepositoryPath(remote) {
  let repositoryPath;
  if (remote.includes('://')) {
    repositoryPath = new URL(remote).pathname;
  } else {
    repositoryPath = remote.slice(remote.indexOf(':') + 1);
  }

  const normalized = repositoryPath
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (normalized.split('/').length < 2) throw new Error('Git origin does not identify an owner and repository');
  return normalized;
}

async function findSourceEntries(rootDir) {
  const entries = [];
  for (const bucket of SOURCE_FOLDERS) {
    const bucketPath = path.join(rootDir, bucket);
    for (const entry of await safeReaddir(bucketPath)) {
      if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
        entries.push({
          bucket,
          installPath: `${bucket}/${entry.name}`,
          sourcePath: path.join(bucketPath, entry.name),
          unsafe: entry.isSymbolicLink()
        });
      }
    }
  }
  return entries;
}

function discoverEntrySkills(rootDir, installPath, skills) {
  const sourcePath = path.join(rootDir, installPath);
  return skills
    .map((skill) => path.relative(sourcePath, skill.path))
    .filter((relative) => !relative.startsWith('..') && !path.isAbsolute(relative))
    .map((relative) => relative ? relative.split(path.sep).join('/') : '.')
    .sort();
}

async function checksumDirectory(directory) {
  const hash = createHash('sha256');

  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(directory, entryPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await walk(entryPath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await readFile(entryPath));
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(entryPath)}\0`);
      } else {
        throw new Error(`Unsupported source entry: ${relativePath}`);
      }
    }
  }

  await walk(directory);
  return hash.digest('hex');
}

async function safeReaddir(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function validateSourceTree(rootDir, sourcePath) {
  const [resolvedRoot, resolvedSource] = await Promise.all([
    realpath(path.resolve(rootDir)),
    realpath(sourcePath)
  ]);
  if (!isInsideOrEqual(resolvedRoot, resolvedSource)) {
    throw new MigrationConflict('unsafe-path', 'Source path resolves outside the central-library root');
  }

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.name === '.git') {
        if (relativeDirectory) {
          throw new MigrationConflict('nested-repository', `Nested Git repository: ${relativePath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(entryPath);
        if (path.isAbsolute(target)) {
          throw new MigrationConflict('unsafe-path', `Absolute symlink: ${relativePath}`);
        }
        let resolvedTarget;
        try {
          resolvedTarget = await realpath(entryPath);
        } catch {
          throw new MigrationConflict('unsafe-path', `Broken symlink: ${relativePath}`);
        }
        if (!isInsideOrEqual(resolvedSource, resolvedTarget)) {
          throw new MigrationConflict('unsafe-path', `Escaping symlink: ${relativePath}`);
        }
      } else if (!entry.isFile()) {
        const stat = await lstat(entryPath);
        throw new MigrationConflict('unsafe-path', `Unsupported entry mode ${stat.mode}: ${relativePath}`);
      }
    }
  }

  await walk(sourcePath);
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

async function readGitRef(sourcePath) {
  try {
    const { stdout } = await execFile('git', [
      '-C',
      sourcePath,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD'
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function isInsideOrEqual(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

class MigrationConflict extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
