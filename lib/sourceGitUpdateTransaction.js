import { execFile as execFileCallback } from 'node:child_process';
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
