import {
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
  const state = {
    sourceBackedUp: false,
    sourcePublished: false,
    recordBackedUp: false,
    recordPublished: false
  };

  try {
    await fileOperations.rename(destination, previousSource);
    state.sourceBackedUp = true;
    await fileOperations.rename(preparedContentRoot, destination);
    state.sourcePublished = true;
    await fileOperations.rename(stagedRecord.targetPath, previousRecord);
    state.recordBackedUp = true;
    await fileOperations.rename(stagedRecord.temporaryPath, stagedRecord.targetPath);
    state.recordPublished = true;

    await fileOperations.rm(previousSource, { recursive: true, force: true });
    state.sourceBackedUp = false;
    await fileOperations.rm(previousRecord, { force: true });
    state.recordBackedUp = false;
  } catch (error) {
    await rollbackReplacement({
      fileOperations,
      destination,
      previousSource,
      previousRecord,
      stagedRecord,
      ...state
    }, error);
    throw error;
  } finally {
    await discardStagedSourceRecord(stagedRecord);
  }
}

async function rollbackReplacement(state, originalError) {
  try {
    if (state.recordBackedUp) {
      if (state.recordPublished) {
        await state.fileOperations.rm(state.stagedRecord.targetPath, { force: true });
      }
      await state.fileOperations.rename(state.previousRecord, state.stagedRecord.targetPath);
    }
    if (state.sourceBackedUp) {
      if (state.sourcePublished) {
        await state.fileOperations.rm(state.destination, { recursive: true, force: true });
      }
      await state.fileOperations.rename(state.previousSource, state.destination);
    }
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source update failed and rollback could not restore the previous source'
    );
  }
}
