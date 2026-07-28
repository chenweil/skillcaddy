import {
  mkdtemp,
  rm,
  rmdir
} from 'node:fs/promises';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { ensureSourceDirectory } from './sourceTree.js';

export async function createManagedSourceWorkspace(rootDir, prefix) {
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

export async function removeManagedSourceWorkspace(workspace) {
  await rm(workspace.root, { recursive: true, force: true });
  try {
    await rmdir(workspace.parent);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function requireSafeDirectory(rootDir, ...segments) {
  try {
    return await ensureSourceDirectory(rootDir, ...segments);
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}
