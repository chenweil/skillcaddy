import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDomain } from 'tldts';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  downloadRemoteArchive,
  parseRemoteArchiveRequest
} from './sourceHttp.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';
import {
  createSourceRecord,
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  checksumDirectory,
  ensureSourceDirectory,
  sourcePathExists
} from './sourceTree.js';

const archiveAddPlanRequests = new WeakMap();

export async function planArchiveSourceAdd(context, request) {
  const parsed = parseRemoteArchiveRequest(request);
  const plan = await buildArchiveAddPlan(context, parsed);
  archiveAddPlanRequests.set(plan, parsed);
  return plan;
}

export async function applyArchiveSourceAdd(context, plan) {
  assertArchiveAddPlan(plan);
  const parsed = archiveAddPlanRequests.get(plan);
  if (!parsed) {
    throw new Error('The add-source plan must be applied by the process that created it');
  }
  const currentPlan = await buildArchiveAddPlan(context, parsed);
  assertSameArchivePlan(plan, currentPlan);
  if (currentPlan.status === 'already-installed') {
    return buildArchiveAddResult(currentPlan, 'already-installed');
  }

  const installBucket = await requireSafeDirectory(context.rootDir, 'official');
  const stagingParent = await requireSafeDirectory(
    context.rootDir,
    '.skillcaddy',
    'staging'
  );
  const stagingRoot = await mkdtemp(path.join(stagingParent, 'archive-add-'));
  const downloadPath = path.join(stagingRoot, 'download');
  const destination = path.join(
    installBucket,
    path.basename(currentPlan.installPath)
  );
  let installed = false;

  try {
    await downloadRemoteArchive(parsed.input, downloadPath, {
      limits: context.httpLimits,
      lookup: context.httpLookup
    });
    const prepared = await stageLocalInput(downloadPath, stagingRoot, {
      archiveLimits: context.archiveLimits
    });
    assertPreparedArchiveMatchesPlan(prepared, currentPlan);
    await assertArchiveDestinationAvailable(context.rootDir, currentPlan);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(prepared.contentRoot, destination);
    installed = true;
    try {
      await createSourceRecord(
        context.rootDir,
        buildArchiveSourceRecord(currentPlan)
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw collisionError(
          `Source identity was registered while applying: ${currentPlan.sourceId}`
        );
      }
      throw error;
    }
    return buildArchiveAddResult(currentPlan, 'added');
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await removeEmptyDirectory(stagingParent);
  }
}

async function buildArchiveAddPlan(context, parsed) {
  const stagingRoot = await mkdtemp(
    path.join(tmpdir(), 'skillcaddy-archive-plan-')
  );
  const downloadPath = path.join(stagingRoot, 'download');
  try {
    await downloadRemoteArchive(parsed.input, downloadPath, {
      limits: context.httpLimits,
      lookup: context.httpLookup
    });
    const prepared = await inspectLocalInput(downloadPath, {
      archiveLimits: context.archiveLimits
    });
    const identity = await resolveArchiveIdentity(context.rootDir, parsed);
    const plan = {
      operation: 'add-source',
      status: 'ready',
      sourceId: identity.sourceId,
      installPath: identity.installPath,
      input: {
        type: 'remote-zip',
        display: parsed.display
      },
      origin: {
        kind: parsed.protocol,
        display: parsed.display
      },
      integrity: prepared.integrity,
      skills: prepared.skills,
      warnings: prepared.warnings
    };
    plan.status = await resolveArchiveAddStatus(context.rootDir, plan);
    return plan;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function resolveArchiveIdentity(rootDir, parsed) {
  const records = await readSourceRecords(rootDir);
  if (parsed.namespace) {
    return existingOrAvailableIdentity(
      rootDir,
      records,
      archiveIdentity(parsed.namespace, parsed.name)
    );
  }

  const defaultIdentity = archiveIdentity(null, parsed.name);
  const sameDefault = records.find(
    (record) => record.sourceId === defaultIdentity.sourceId
  );
  if (
    sameDefault?.type === 'archive' &&
    archiveDomain(sameDefault.origin.display) === parsed.registrableDomain
  ) {
    return {
      sourceId: sameDefault.sourceId,
      installPath: sameDefault.installPath
    };
  }
  if (
    !sameDefault &&
    await installPathAvailable(rootDir, records, defaultIdentity.installPath)
  ) {
    return defaultIdentity;
  }
  return existingOrAvailableIdentity(
    rootDir,
    records,
    archiveIdentity(parsed.registrableDomain, parsed.name)
  );
}

async function existingOrAvailableIdentity(rootDir, records, identity) {
  const existing = records.find((record) => record.sourceId === identity.sourceId);
  if (existing) {
    return { sourceId: existing.sourceId, installPath: existing.installPath };
  }
  if (await installPathAvailable(rootDir, records, identity.installPath)) {
    return identity;
  }
  throw collisionError(`Source destination collision: ${identity.installPath}`);
}

function archiveIdentity(namespace, name) {
  const sourceId = namespace
    ? `official/${namespace}/${name}`
    : `official/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw identityError(
      'Remote Archive name and namespace must form a safe source identity'
    );
  }
  return {
    sourceId,
    installPath: `official/${namespace ? `${namespace}--` : ''}${name}`
  };
}

async function resolveArchiveAddStatus(rootDir, plan) {
  const records = await readSourceRecords(rootDir);
  const existing = records.find((record) => record.sourceId === plan.sourceId);
  if (!existing) return 'ready';
  if (
    existing.type !== 'archive' ||
    existing.installPath !== plan.installPath ||
    existing.integrity?.value !== plan.integrity.value ||
    JSON.stringify(existing.skills) !== JSON.stringify(plan.skills)
  ) {
    throw collisionError(
      `Source identity already exists with different content: ${plan.sourceId}. Use source update.`
    );
  }
  const destination = path.join(rootDir, ...existing.installPath.split('/'));
  if (!(await sourcePathExists(destination))) {
    throw collisionError(`Registered source content is missing: ${plan.sourceId}`);
  }
  if (await checksumDirectory(destination) !== plan.integrity.value) {
    throw collisionError(
      `Registered source content no longer matches its integrity: ${plan.sourceId}`
    );
  }
  return 'already-installed';
}

async function assertArchiveDestinationAvailable(rootDir, plan) {
  if (await resolveArchiveAddStatus(rootDir, plan) !== 'ready') {
    throw collisionError(`Source was installed while applying: ${plan.sourceId}`);
  }
  const records = await readSourceRecords(rootDir);
  if (!(await installPathAvailable(rootDir, records, plan.installPath))) {
    throw collisionError(
      `Source destination was occupied while applying: ${plan.installPath}`
    );
  }
}

async function installPathAvailable(rootDir, records, installPath) {
  return !records.some((record) => record.installPath === installPath) &&
    !await sourcePathExists(path.join(rootDir, ...installPath.split('/')));
}

function buildArchiveSourceRecord(plan) {
  return {
    schemaVersion: 1,
    sourceId: plan.sourceId,
    bucket: 'official',
    type: 'archive',
    installPath: plan.installPath,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function assertArchiveAddPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    plan.input?.type !== 'remote-zip' ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid Archive add-source plan is required');
  }
}

function assertSameArchivePlan(planned, current) {
  const selectFacts = (value) => JSON.stringify({
    sourceId: value.sourceId,
    installPath: value.installPath,
    input: value.input,
    origin: value.origin,
    integrity: value.integrity,
    skills: value.skills,
    warnings: value.warnings
  });
  if (selectFacts(planned) !== selectFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Remote Archive changed since the add plan'
    );
  }
}

function assertPreparedArchiveMatchesPlan(prepared, plan) {
  assertSameArchivePlan(plan, {
    ...plan,
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  });
}

function buildArchiveAddResult(plan, status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings
  };
}

function archiveDomain(display) {
  const hostname = new URL(display).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ||
    hostname.toLowerCase();
}

function identityError(message) {
  return new SourceAcquisitionError('unresolved-identity', message, 3);
}

function collisionError(message) {
  return new SourceAcquisitionError('source-collision', message, 3);
}

async function requireSafeDirectory(rootDir, ...segments) {
  try {
    return await ensureSourceDirectory(rootDir, ...segments);
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}

async function removeEmptyDirectory(directory) {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}
