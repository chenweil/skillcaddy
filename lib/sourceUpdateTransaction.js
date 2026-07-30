import {
  lstat,
  rename,
  rm
} from 'node:fs/promises';
import path from 'node:path';
import {
  discardStagedSourceRecord,
  stageSourceRecord
} from './sourceRegistry.js';

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

export async function publishStagedLocalSourceReplacement(options) {
  const state = await prepareDirectorySourceReplacement(options);
  try {
    try {
      await commitDirectorySourceReplacement(state);
    } catch (error) {
      await rollbackReplacement(state, error);
      throw error;
    }

    await cleanupDirectorySourceReplacement(state);
  } finally {
    await discardDirectorySourceReplacement(state);
  }
}

async function rollbackReplacement(state, originalError) {
  try {
    await rollbackDirectorySourceReplacement(state);
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source update failed and rollback could not restore the previous source'
    );
  }
}

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
