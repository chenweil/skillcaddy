import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  SourceAcquisitionError,
  sourceCollisionError
} from './sourceAcquisitionError.js';
import { parseRemoteSkillFileRequest } from './sourceHttp.js';
import {
  inspectRemoteSkillFile,
  stageRemoteSkillFile
} from './sourceRemoteFileWorkspace.js';
import {
  createSourceRecord,
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  checksumDirectory,
  ensureSourceDirectory,
  sourceInstallPathAvailable,
  sourcePathExists
} from './sourceTree.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';

const remoteFileAddPlanRequests = new WeakMap();

export async function planRemoteFileSourceAdd(context, request) {
  const parsed = parseRemoteSkillFileRequest(request);
  const plan = await buildRemoteFileAddPlan(context, parsed);
  remoteFileAddPlanRequests.set(plan, parsed);
  return plan;
}

export async function applyRemoteFileSourceAdd(context, plan) {
  assertRemoteFileAddPlan(plan);
  const parsed = remoteFileAddPlanRequests.get(plan);
  if (!parsed) {
    throw new Error('The add-source plan must be applied by the process that created it');
  }
  const currentPlan = await buildRemoteFileAddPlan(context, parsed);
  assertSameRemoteFilePlan(plan, currentPlan);
  if (currentPlan.status === 'already-installed') {
    return buildRemoteFileAddResult(currentPlan, 'already-installed');
  }

  const installBucket = await requireSafeDirectory(context.rootDir, 'official');
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'remote-file-add-'
  );
  const destination = path.join(installBucket, path.basename(currentPlan.installPath));
  let installed = false;

  try {
    const prepared = await stageRemoteSkillFile(context, parsed, workspace.root);
    assertPreparedRemoteFileMatchesPlan(prepared, currentPlan);
    await assertRemoteFileDestinationAvailable(context.rootDir, currentPlan);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(prepared.contentRoot, destination);
    installed = true;
    try {
      await createSourceRecord(context.rootDir, buildRemoteFileSourceRecord(currentPlan));
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw sourceCollisionError(
          `Source identity was registered while applying: ${currentPlan.sourceId}`
        );
      }
      throw error;
    }
    return buildRemoteFileAddResult(currentPlan, 'added');
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function buildRemoteFileAddPlan(context, parsed) {
  const identity = remoteFileIdentity(parsed.name);
  const prepared = await inspectRemoteSkillFile(
    context,
    parsed,
    'skillcaddy-remote-file-plan-'
  );
  const plan = {
    operation: 'add-source',
    status: 'ready',
    sourceId: identity.sourceId,
    installPath: identity.installPath,
    input: {
      type: 'remote-file',
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
  plan.status = await resolveRemoteFileAddStatus(context.rootDir, plan);
  return plan;
}

function remoteFileIdentity(name) {
  if (name.includes('/')) throw remoteFileIdentityError();
  const sourceId = `official/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw remoteFileIdentityError();
  }
  return { sourceId, installPath: sourceId };
}

function remoteFileIdentityError() {
  return new SourceAcquisitionError(
    'unresolved-identity',
    'Remote file name must be a single safe identity segment',
    3
  );
}

async function resolveRemoteFileAddStatus(rootDir, plan) {
  const records = await readSourceRecords(rootDir);
  const existing = records.find((record) => record.sourceId === plan.sourceId);
  if (!existing) return 'ready';
  if (
    existing.type !== 'remote-file' ||
    existing.installPath !== plan.installPath ||
    existing.origin.display !== plan.origin.display
  ) {
    throw sourceCollisionError(
      `Source identity is registered with incompatible source facts: ${plan.sourceId}.`
    );
  }
  if (
    existing.integrity?.value !== plan.integrity.value ||
    JSON.stringify(existing.skills) !== JSON.stringify(plan.skills)
  ) {
    throw sourceCollisionError(
      `Source identity already exists with different content: ${plan.sourceId}. Use source update.`,
      plan.sourceId
    );
  }
  const destination = path.join(rootDir, ...existing.installPath.split('/'));
  if (!(await sourcePathExists(destination))) {
    throw sourceCollisionError(`Registered source content is missing: ${plan.sourceId}`);
  }
  if (await checksumDirectory(destination) !== plan.integrity.value) {
    throw sourceCollisionError(
      `Registered source content no longer matches its integrity: ${plan.sourceId}`
    );
  }
  return 'already-installed';
}

async function assertRemoteFileDestinationAvailable(rootDir, plan) {
  if (await resolveRemoteFileAddStatus(rootDir, plan) !== 'ready') {
    throw sourceCollisionError(`Source was installed while applying: ${plan.sourceId}`);
  }
  const records = await readSourceRecords(rootDir);
  if (!(await sourceInstallPathAvailable(rootDir, records, plan.installPath))) {
    throw sourceCollisionError(
      `Source destination was occupied while applying: ${plan.installPath}`
    );
  }
}

function buildRemoteFileSourceRecord(plan) {
  return {
    schemaVersion: 1,
    sourceId: plan.sourceId,
    bucket: 'official',
    type: 'remote-file',
    installPath: plan.installPath,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function assertRemoteFileAddPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    plan.input?.type !== 'remote-file' ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid Remote file add-source plan is required');
  }
}

function assertSameRemoteFilePlan(planned, current) {
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
      'Remote SKILL.md changed since the add plan'
    );
  }
}

function assertPreparedRemoteFileMatchesPlan(prepared, plan) {
  assertSameRemoteFilePlan(plan, {
    ...plan,
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  });
}

function buildRemoteFileAddResult(plan, status) {
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

async function requireSafeDirectory(rootDir, ...segments) {
  try {
    return await ensureSourceDirectory(rootDir, ...segments);
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}
