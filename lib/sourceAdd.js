import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir
} from 'node:fs/promises';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';
import {
  readSourceRecords,
  validateSourceId,
  writeSourceRecord
} from './sourceRegistry.js';
import { checksumDirectory } from './sourceTree.js';

const addPlanRequests = new WeakMap();

export async function planLocalSourceAdd({ rootDir, archiveLimits }, request) {
  const inputPath = requireLocalInput(request);
  const prepared = await inspectLocalInput(inputPath, { archiveLimits });
  const identity = resolveLocalIdentity(request, prepared.defaultName);
  const plan = {
    operation: 'add-source',
    status: 'ready',
    sourceId: identity.sourceId,
    installPath: identity.installPath,
    input: {
      type: prepared.type,
      name: prepared.basename
    },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  };

  plan.status = await resolveAddStatus(rootDir, plan);
  addPlanRequests.set(plan, {
    inputPath,
    request: {
      input: request.input,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.namespace === undefined ? {} : { namespace: request.namespace })
    }
  });
  return plan;
}

export async function applyLocalSourceAdd({ rootDir, archiveLimits }, plan) {
  assertAddPlan(plan);
  const privateRequest = addPlanRequests.get(plan);
  if (!privateRequest) {
    throw new Error('The add-source plan must be applied by the process that created it');
  }

  const currentPlan = await planLocalSourceAdd(
    { rootDir, archiveLimits },
    privateRequest.request
  );
  assertSamePlannedSource(plan, currentPlan);
  if (currentPlan.status === 'already-installed') {
    return buildAddResult(currentPlan, 'already-installed');
  }

  const stagingParent = path.join(rootDir, '.skillcaddy', 'staging');
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(stagingParent, 'add-'));
  const destination = path.join(rootDir, ...plan.installPath.split('/'));
  let installed = false;

  try {
    const prepared = await stageLocalInput(privateRequest.inputPath, stagingRoot, {
      archiveLimits
    });
    assertPreparedInputMatchesPlan(prepared, plan);
    await assertAddDestinationAvailable(rootDir, plan);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(prepared.contentRoot, destination);
    installed = true;

    try {
      await writeSourceRecord(rootDir, buildLocalSourceRecord(plan), { overwrite: false });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw collisionError(`Source identity was registered while applying: ${plan.sourceId}`);
      }
      throw error;
    }
    return buildAddResult(plan, 'added');
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await removeEmptyDirectory(stagingParent);
  }
}

function requireLocalInput(request) {
  if (!request || typeof request.input !== 'string' || !request.input.trim()) {
    throw new Error('Source add requires request.input');
  }
  return path.resolve(request.input);
}

function resolveLocalIdentity(request, defaultName) {
  const name = request.name === undefined ? defaultName : request.name;
  const namespace = request.namespace;
  if (typeof name !== 'string' || !name) {
    throw identityError('Local source name must be a non-empty identity segment');
  }
  if (namespace !== undefined && (typeof namespace !== 'string' || !namespace)) {
    throw identityError('Local source namespace must be a non-empty identity segment');
  }

  const sourceId = namespace
    ? `personal/${namespace}/${name}`
    : `personal/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw identityError(
      `Invalid local source identity: ${sourceId}. Use --name and --namespace with safe identity segments.`
    );
  }
  return {
    sourceId,
    installPath: `personal/${namespace ? `${namespace}--` : ''}${name}`
  };
}

async function resolveAddStatus(rootDir, plan) {
  const records = await readSourceRecords(rootDir);
  const sameIdentity = records.find((record) => record.sourceId === plan.sourceId);
  const sameDestination = records.find((record) => record.installPath === plan.installPath);

  if (sameIdentity) {
    if (
      sameIdentity.type !== 'local' ||
      sameIdentity.installPath !== plan.installPath ||
      sameIdentity.integrity?.value !== plan.integrity.value ||
      JSON.stringify(sameIdentity.skills) !== JSON.stringify(plan.skills)
    ) {
      throw collisionError(
        `Source identity already exists with different content: ${plan.sourceId}. Use source update or another namespace.`
      );
    }
    const destination = path.join(rootDir, ...sameIdentity.installPath.split('/'));
    if (!(await pathExists(destination))) {
      throw collisionError(`Registered source content is missing: ${plan.sourceId}`);
    }
    if (await checksumDirectory(destination) !== plan.integrity.value) {
      throw collisionError(`Registered source content no longer matches its integrity: ${plan.sourceId}`);
    }
    return 'already-installed';
  }

  if (sameDestination || await pathExists(path.join(rootDir, ...plan.installPath.split('/')))) {
    throw collisionError(
      `Source destination collision: ${plan.installPath}. Use --namespace to choose another identity.`
    );
  }
  return 'ready';
}

async function assertAddDestinationAvailable(rootDir, plan) {
  if (await resolveAddStatus(rootDir, plan) !== 'ready') {
    throw collisionError(`Source was installed while applying: ${plan.sourceId}`);
  }
}

function buildLocalSourceRecord(plan) {
  return {
    schemaVersion: 1,
    sourceId: plan.sourceId,
    bucket: 'personal',
    type: 'local',
    installPath: plan.installPath,
    origin: {
      kind: 'local',
      name: plan.input.name
    },
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function assertAddPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid add-source plan is required');
  }
}

function assertSamePlannedSource(planned, current) {
  const selectFacts = (value) => JSON.stringify({
    sourceId: value.sourceId,
    installPath: value.installPath,
    input: value.input,
    integrity: value.integrity,
    skills: value.skills,
    warnings: value.warnings
  });
  if (selectFacts(planned) !== selectFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Local source content changed since the add plan'
    );
  }
}

function assertPreparedInputMatchesPlan(prepared, plan) {
  assertSamePlannedSource(plan, {
    ...plan,
    input: { type: prepared.type, name: prepared.basename },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  });
}

function buildAddResult(plan, status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings
  };
}

function identityError(message) {
  return new SourceAcquisitionError('unresolved-identity', message, 3);
}

function collisionError(message) {
  return new SourceAcquisitionError('source-collision', message, 3);
}

async function removeEmptyDirectory(directory) {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
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
