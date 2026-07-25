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

export async function publishStagedLocalSourceReplacement({
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
  try {
    try {
      await fileOperations.rename(destination, previousSource);
      await fileOperations.rename(preparedContentRoot, destination);
      await fileOperations.rename(stagedRecord.targetPath, previousRecord);
      await fileOperations.rename(stagedRecord.temporaryPath, stagedRecord.targetPath);
    } catch (error) {
      await rollbackReplacement({
        fileOperations,
        destination,
        previousSource,
        previousRecord,
        stagedRecord
      }, error);
      throw error;
    }

    await fileOperations.rm(previousSource, { recursive: true, force: true });
    await fileOperations.rm(previousRecord, { force: true });
  } finally {
    await discardStagedSourceRecord(stagedRecord);
  }
}

async function rollbackReplacement(state, originalError) {
  try {
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
