import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyLocalSourceAdd,
  planLocalSourceAdd
} from './sourceAdd.js';
import {
  applyArchiveSourceAdd,
  planArchiveSourceAdd
} from './sourceArchiveAdd.js';
import {
  applyArchiveSourceUpdate,
  planArchiveSourceUpdate,
  planBreakingArchiveSourceUpdate
} from './sourceArchiveUpdate.js';
import {
  applyGitSourceAdd,
  planGitSourceAdd
} from './sourceGitAdd.js';
import { isGitSourceInput } from './sourceGitUrl.js';
import { isRemoteArchiveInput } from './sourceHttp.js';
import {
  applyLocalSourceUpdate,
  planBreakingLocalSourceUpdate,
  planLocalSourceUpdate
} from './sourceUpdate.js';
import { readSourceRecords, validateSourceId } from './sourceRegistry.js';
import {
  applySourceMigrationPlan,
  buildSourceMigrationPlan
} from './sourceMigration.js';
import { SOURCE_FOLDERS } from './sourcePolicy.js';
import { readSourceDirectory } from './sourceTree.js';

export async function listSources(context) {
  const rootDir = requireRootDir(context);
  const registered = await readSourceRecords(rootDir);
  const registeredPaths = new Set(registered.map((record) => record.installPath));
  const unmanaged = await findUnmanagedSourceEntries(rootDir, registeredPaths);

  const sources = [
    ...await Promise.all(registered.map(async (record) => ({
      inventoryId: record.sourceId,
      status: 'registered',
      sourceId: record.sourceId,
      installPath: record.installPath,
      exists: await pathExists(path.join(rootDir, record.installPath))
    }))),
    ...unmanaged
  ];

  return {
    sources: sources.sort(compareInventoryEntries)
  };
}

export async function inspectSource(context, sourceId) {
  const rootDir = requireRootDir(context);
  validateSourceId(sourceId);
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) throw new Error(`Source is not registered: ${sourceId}`);
  return record;
}

export async function planSourceMigration(context) {
  return buildSourceMigrationPlan(requireRootDir(context));
}

export async function applySourceMigration(context, plan) {
  return applySourceMigrationPlan(requireRootDir(context), plan);
}

export async function planAddSource(context, request) {
  if (isGitSourceInput(request?.input)) {
    return planGitSourceAdd({
      rootDir: requireRootDir(context)
    }, request);
  }
  if (isRemoteArchiveInput(request?.input)) {
    return planArchiveSourceAdd({
      rootDir: requireRootDir(context),
      archiveLimits: context?.archiveLimits,
      httpLimits: context?.httpLimits,
      httpLookup: context?.httpLookup
    }, request);
  }
  return planLocalSourceAdd({
    rootDir: requireRootDir(context),
    archiveLimits: context?.archiveLimits
  }, request);
}

export async function applyAddSource(context, plan) {
  if (plan?.input?.type === 'git') {
    return applyGitSourceAdd({
      rootDir: requireRootDir(context)
    }, plan);
  }
  if (plan?.input?.type === 'remote-zip') {
    return applyArchiveSourceAdd({
      rootDir: requireRootDir(context),
      archiveLimits: context?.archiveLimits,
      httpLimits: context?.httpLimits,
      httpLookup: context?.httpLookup
    }, plan);
  }
  return applyLocalSourceAdd({
    rootDir: requireRootDir(context),
    archiveLimits: context?.archiveLimits
  }, plan);
}

export async function planUpdateSource(context, request) {
  if (isRemoteArchiveInput(request?.input)) {
    return planArchiveSourceUpdate({
      rootDir: requireRootDir(context),
      archiveLimits: context?.archiveLimits,
      httpLimits: context?.httpLimits,
      httpLookup: context?.httpLookup,
      projectPath: context?.projectPath
    }, request);
  }
  return planLocalSourceUpdate({
    rootDir: requireRootDir(context),
    archiveLimits: context?.archiveLimits,
    projectPath: context?.projectPath
  }, request);
}

export async function planBreakingUpdateSource(context, request) {
  if (isRemoteArchiveInput(request?.input)) {
    return planBreakingArchiveSourceUpdate({
      rootDir: requireRootDir(context),
      archiveLimits: context?.archiveLimits,
      httpLimits: context?.httpLimits,
      httpLookup: context?.httpLookup,
      projectPath: context?.projectPath
    }, request);
  }
  return planBreakingLocalSourceUpdate({
    rootDir: requireRootDir(context),
    archiveLimits: context?.archiveLimits,
    projectPath: context?.projectPath
  }, request);
}

export async function applyUpdateSource(context, plan) {
  if (plan?.input?.type === 'remote-zip') {
    return applyArchiveSourceUpdate({
      rootDir: requireRootDir(context),
      archiveLimits: context?.archiveLimits,
      httpLimits: context?.httpLimits,
      httpLookup: context?.httpLookup,
      projectPath: context?.projectPath,
      fileOperations: context?.fileOperations
    }, plan);
  }
  return applyLocalSourceUpdate({
    rootDir: requireRootDir(context),
    archiveLimits: context?.archiveLimits,
    projectPath: context?.projectPath,
    fileOperations: context?.fileOperations
  }, plan);
}

async function findUnmanagedSourceEntries(rootDir, registeredPaths) {
  const sources = [];
  for (const bucket of SOURCE_FOLDERS) {
    const entries = await readSourceDirectory(path.join(rootDir, bucket));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const installPath = `${bucket}/${entry.name}`;
      if (registeredPaths.has(installPath)) continue;
      sources.push({
        inventoryId: `unmanaged:${installPath}`,
        status: 'unmanaged',
        sourceId: null,
        installPath,
        exists: true
      });
    }
  }
  return sources;
}

function requireRootDir(context) {
  if (!context || typeof context.rootDir !== 'string' || !context.rootDir.trim()) {
    throw new Error('Source management requires context.rootDir');
  }
  return path.resolve(context.rootDir);
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

function compareInventoryEntries(left, right) {
  const statusOrder = { registered: 0, unmanaged: 1 };
  return statusOrder[left.status] - statusOrder[right.status] ||
    left.inventoryId.localeCompare(right.inventoryId);
}
