/**
 * Source upgrade transactions
 *
 * Two strategies for atomic source updates:
 * - DIRECTORY_REPLACEMENT: For local, archive, and remote-file sources
 * - GIT_FAST_FORWARD: For Git sources
 *
 * Both follow the same phase structure:
 * - PREPARE: Stage content and registry entries
 * - COMMIT: Make changes active
 * - CLEANUP: Remove temporary artifacts (directory only)
 * - ROLLBACK: Undo on failure
 * - DISCARD: Clean up staging state
 *
 * See sourceUpgrade.js for the lifecycle orchestration.
 */
import { execFile as execFileCallback } from 'node:child_process';
import {
  lstat,
  rename,
  rm
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  discardStagedSourceRecord,
  publishStagedSourceRecord,
  stageSourceRecord,
  writeSourceRecord
} from './sourceRegistry.js';

const execFile = promisify(execFileCallback);

// === Directory Replacement Strategy ===
// For local, archive, and remote-file sources

export const defaultSourceUpdateFileOperations = { rename, rm };

export async function prepareDirectorySourceReplacement({
  rootDir,
  destination,
  stagingRoot,
  preparedContentRoot,
  nextRecord,
  fileOperations
}) {
  const previousSource = path.join(stagingRoot, 'previous-source');
  const previousRecord = path.join(stagingRoot, 'previous-record.json');
  const stagedRecord = await stageSourceRecord(rootDir, nextRecord);
  return {
    destination,
    fileOperations,
    preparedContentRoot,
    previousRecord,
    previousSource,
    stagedRecord
  };
}

export async function commitDirectorySourceReplacement(state) {
  await state.fileOperations.rename(state.destination, state.previousSource);
  await state.fileOperations.rename(
    state.preparedContentRoot,
    state.destination
  );
  await state.fileOperations.rename(
    state.stagedRecord.targetPath,
    state.previousRecord
  );
  await state.fileOperations.rename(
    state.stagedRecord.temporaryPath,
    state.stagedRecord.targetPath
  );
}

export async function cleanupDirectorySourceReplacement(state) {
  await state.fileOperations.rm(
    state.previousSource,
    { recursive: true, force: true }
  );
  await state.fileOperations.rm(state.previousRecord, { force: true });
}

export async function rollbackDirectorySourceReplacement(state) {
  if (await pathExists(state.previousRecord)) {
    await restorePublishedPath({
      fileOperations: state.fileOperations,
      backup: state.previousRecord,
      target: state.stagedRecord.targetPath,
      removeOptions: { force: true }
    });
  }
  if (await pathExists(state.previousSource)) {
    await restorePublishedPath({
      fileOperations: state.fileOperations,
      backup: state.previousSource,
      target: state.destination,
      removeOptions: { recursive: true, force: true }
    });
  }
}

export async function discardDirectorySourceReplacement(state) {
  await discardStagedSourceRecord(state.stagedRecord);
}

// === Git Fast-Forward Strategy ===
// For Git sources

export async function prepareGitSourceFastForward({
  rootDir,
  record,
  nextRecord,
  incomingCommit,
  publishRecord = publishStagedSourceRecord
}) {
  return {
    destination: path.resolve(rootDir, record.installPath),
    incomingCommit,
    previousRecord: record,
    publishRecord,
    recordPublished: false,
    rootDir,
    sourceId: record.sourceId,
    stagedRecord: await stageSourceRecord(rootDir, nextRecord)
  };
}

export async function commitGitSourceFastForward(state) {
  await state.publishRecord(state.stagedRecord);
  state.recordPublished = true;
  await execGit(state.destination, [
    'merge',
    '--ff-only',
    '--no-edit',
    state.incomingCommit
  ], state.sourceId, 'Could not fast-forward Git source');
  const installedCommit = await readGitOutput(
    state.destination,
    ['rev-parse', 'HEAD']
  );
  if (installedCommit !== state.incomingCommit) {
    throw gitUpdateError(
      'git-update',
      `Git source did not advance to the planned commit: ${state.sourceId}`
    );
  }
}

export async function rollbackGitSourceFastForward(state) {
  if (!state.recordPublished) return;
  await writeSourceRecord(state.rootDir, state.previousRecord);
}

export async function discardGitSourceFastForward(state) {
  await discardStagedSourceRecord(state.stagedRecord);
}

// === Private helpers ===

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function restorePublishedPath({
  fileOperations,
  backup,
  target,
  removeOptions
}) {
  await fileOperations.rm(target, removeOptions);
  await fileOperations.rename(backup, target);
}

async function readGitOutput(directory, args) {
  const result = await execGit(
    directory,
    args,
    'source',
    'Could not inspect Git source'
  );
  return result.stdout.trim();
}

async function execGit(directory, args, sourceId, action) {
  try {
    return await execFile('git', ['-C', directory, ...args]);
  } catch {
    throw gitUpdateError('git-update', `${action}: ${sourceId}`);
  }
}

function gitUpdateError(category, message, exitCode = 1) {
  return new SourceAcquisitionError(category, message, exitCode);
}
