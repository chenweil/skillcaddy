import {
  mkdtemp,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadRemoteArchive } from './sourceHttp.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';

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

async function downloadArchive(context, parsed, stagingRoot) {
  const downloadPath = path.join(stagingRoot, 'download');
  await downloadRemoteArchive(parsed.input, downloadPath, {
    limits: context.httpLimits,
    lookup: context.httpLookup
  });
  return downloadPath;
}
