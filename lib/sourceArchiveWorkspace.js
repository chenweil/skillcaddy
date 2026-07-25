import {
  mkdtemp,
  rm,
  rmdir
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { downloadRemoteArchive } from './sourceHttp.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';
import { ensureSourceDirectory } from './sourceTree.js';

export async function inspectRemoteArchive(context, parsed, prefix) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const downloadPath = await downloadArchive(context, parsed, stagingRoot);
    return await inspectLocalInput(downloadPath, {
      archiveLimits: context.archiveLimits
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function stageRemoteArchive(context, parsed, stagingRoot) {
  const downloadPath = await downloadArchive(context, parsed, stagingRoot);
  return stageLocalInput(downloadPath, stagingRoot, {
    archiveLimits: context.archiveLimits
  });
}

export async function createManagedArchiveWorkspace(rootDir, prefix) {
  const parent = await requireSafeDirectory(
    rootDir,
    '.skillcaddy',
    'staging'
  );
  return {
    parent,
    root: await mkdtemp(path.join(parent, prefix))
  };
}

export async function removeManagedArchiveWorkspace(workspace) {
  await rm(workspace.root, { recursive: true, force: true });
  try {
    await rmdir(workspace.parent);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function downloadArchive(context, parsed, stagingRoot) {
  const downloadPath = path.join(stagingRoot, 'download');
  await downloadRemoteArchive(parsed.input, downloadPath, {
    limits: context.httpLimits,
    lookup: context.httpLookup
  });
  return downloadPath;
}

async function requireSafeDirectory(rootDir, ...segments) {
  try {
    return await ensureSourceDirectory(rootDir, ...segments);
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}
