/**
 * Source acquisition lifecycle
 *
 * This module owns selection, planning, re-planning, execution,
 * and result projection for all source acquisitions.
 *
 * Architecture note: Execution logic is inlined as private helpers
 * rather than a separate module (sourceAcquisitionExecution.js),
 * because it has only one caller. Tests go through the sourceManager
 * seam, not directly.
 *
 * See ADR-0005 for the centralized acquisition lifecycle decision.
 */
import {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { createGitAcquisitionAdapter } from './sourceGitAcquisitionAdapter.js';
import {
  isDefiniteGitSourceInput,
  isGitSourceInput
} from './sourceGitUrl.js';
import {
  isRemoteArchiveInput,
  isRemoteSkillFileInput
} from './sourceHttp.js';
import {
  createLocalAcquisitionAdapter
} from './sourceLocalAcquisitionAdapter.js';
import {
  createRemoteArchiveAcquisitionAdapter
} from './sourceRemoteArchiveAcquisitionAdapter.js';
import {
  createRemoteFileAcquisitionAdapter
} from './sourceRemoteFileAcquisitionAdapter.js';
import { SourceAcquisitionError, sourceCollisionError } from './sourceAcquisitionError.js';
import {
  assertOriginalSourceAcquisitionPlan,
  assertSameSourceAcquisitionFacts,
  assertSourceAcquisitionDestinationAvailable,
  fingerprintSourceAcquisitionFacts,
  fingerprintSourceAcquisitionPlan,
  resolveSourceAcquisitionStatus
} from './sourceAcquisitionPolicy.js';
import {
  SOURCE_INSTALLING_MARKER,
  SOURCE_INSTALLING_MARKER_CONTENT
} from './sourcePolicy.js';
import { createSourceRecord, readSourceRecords } from './sourceRegistry.js';
import {
  ensureSourceDirectory,
  sourcePathExists
} from './sourceTree.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';

const sourceAcquisitionPlans = new WeakMap();
const SOURCE_INPUT_TYPES = new Set([
  'git',
  'local-directory',
  'local-zip',
  'remote-file',
  'remote-zip'
]);

export async function planSourceAcquisition(context, request) {
  const acquisition = await buildSourceAcquisition(context, request);
  sourceAcquisitionPlans.set(acquisition.plan, {
    originalFingerprint: fingerprintSourceAcquisitionPlan(acquisition.plan),
    factsFingerprint: acquisition.factsFingerprint,
    request: snapshotRequest(request),
    stalePlanMessage: acquisition.adapter.stalePlanMessage
  });
  return acquisition.plan;
}

export async function applySourceAcquisition(context, plan) {
  const session = sourceAcquisitionPlans.get(plan);
  if (!session) {
    assertAcquisitionPlan(plan);
    throw copiedPlanError(plan);
  }
  assertOriginalSourceAcquisitionPlan(
    session.originalFingerprint,
    plan,
    session.stalePlanMessage
  );
  assertAcquisitionPlan(plan);

  const acquisition = await buildSourceAcquisition(context, session.request);
  assertSameSourceAcquisitionFacts(
    session.factsFingerprint,
    acquisition.plan,
    session.stalePlanMessage
  );
  if (acquisition.plan.status === 'already-installed') {
    return buildAcquisitionResult(acquisition.plan);
  }

  await runSourceAcquisition(context, acquisition);
  return buildAcquisitionResult(acquisition.plan, 'added');
}

async function buildSourceAcquisition(context, request) {
  if (isDefiniteGitSourceInput(request?.input)) {
    return inspectAcquisition(
      context,
      createGitAcquisitionAdapter(context, request)
    );
  }
  if (isRemoteSkillFileInput(request?.input)) {
    return inspectAcquisition(
      context,
      createRemoteFileAcquisitionAdapter(context, request)
    );
  }
  if (isRemoteArchiveInput(request?.input)) {
    try {
      return await inspectAcquisition(
        context,
        createRemoteArchiveAcquisitionAdapter(context, request)
      );
    } catch (error) {
      if (!isAmbiguousHttpsSource(request.input)) throw error;
      try {
        return await inspectAcquisition(
          context,
          createGitAcquisitionAdapter(context, request)
        );
      } catch {
        throw error;
      }
    }
  }
  return inspectAcquisition(
    context,
    createLocalAcquisitionAdapter(context, request)
  );
}

async function inspectAcquisition(context, adapter) {
  const candidate = await adapter.inspect();
  const records = await readSourceRecords(context.rootDir);
  const identity = await adapter.resolveIdentity(candidate, records);
  const plan = buildSourceAcquisitionPlan(identity, candidate, 'ready');
  plan.status = await resolveSourceAcquisitionStatus({
    rootDir: context.rootDir,
    plan,
    adapter,
    records
  });
  const factsFingerprint = fingerprintSourceAcquisitionFacts(plan);
  return {
    adapter,
    plan,
    factsFingerprint,
    projectPlan: (prepared) => buildSourceAcquisitionPlan(
      identity,
      prepared,
      plan.status
    )
  };
}

function buildSourceAcquisitionPlan(identity, candidate, status) {
  return {
    operation: 'add-source',
    status,
    sourceId: identity.sourceId,
    installPath: identity.installPath,
    input: candidate.input,
    ...(candidate.origin ? { origin: candidate.origin } : {}),
    ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
    ...(candidate.focus ? { focus: candidate.focus } : {}),
    skills: candidate.skills,
    warnings: candidate.warnings
  };
}

function buildAcquisitionResult(plan, status = plan.status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    ...(plan.origin ? { origin: plan.origin } : {}),
    ...(plan.integrity ? { integrity: plan.integrity } : {}),
    ...(plan.focus ? { focus: plan.focus } : {}),
    skills: plan.skills,
    warnings: plan.warnings
  };
}

function assertAcquisitionPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    !SOURCE_INPUT_TYPES.has(plan.input?.type) ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid add-source plan is required');
  }
}

function copiedPlanError(plan) {
  return new Error(
    plan.input?.type === 'git'
      ? 'The Git add-source plan must be applied by the process that created it'
      : 'The add-source plan must be applied by the process that created it'
  );
}

function snapshotRequest(request) {
  return {
    input: request?.input,
    ...(request?.name === undefined ? {} : { name: request.name }),
    ...(request?.namespace === undefined
      ? {}
      : { namespace: request.namespace })
  };
}

function isAmbiguousHttpsSource(input) {
  if (!isGitSourceInput(input) || isDefiniteGitSourceInput(input)) return false;
  let url;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return !/\.zip$/i.test(url.pathname);
}

// === Private: Execution phase ===

const defaultSourceAcquisitionFileOperations = {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile
};

async function runSourceAcquisition(context, acquisition) {
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'add-'
  );
  const fileOperations = {
    ...defaultSourceAcquisitionFileOperations,
    ...context.acquisitionFileOperations
  };
  const publishRecord = context.createSourceRecord || createSourceRecord;
  let destination;
  let installed = false;

  try {
    const candidate = await acquisition.adapter.prepare(workspace.root);
    assertSameSourceAcquisitionFacts(
      acquisition.factsFingerprint,
      acquisition.projectPlan(candidate),
      acquisition.adapter.stalePlanMessage
    );
    await assertSourceAcquisitionDestinationAvailable({
      rootDir: context.rootDir,
      plan: acquisition.plan,
      adapter: acquisition.adapter
    });
    await assertNoReservedPublicationMarker(candidate.contentRoot);
    destination = await resolveSafeDestination(
      context.rootDir,
      acquisition.plan.installPath
    );
    await installPreparedDirectory({
      preparedRoot: candidate.contentRoot,
      destination,
      fileOperations
    });
    installed = true;

    try {
      await publishRecord(
        context.rootDir,
        acquisition.adapter.buildRecord(acquisition.plan)
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw sourceCollisionError(
          `Source identity was registered while applying: ${acquisition.plan.sourceId}`
        );
      }
      throw error;
    }
  } catch (error) {
    if (installed) {
      await removeFailedPublication(fileOperations, destination, error);
    }
    throw error;
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function installPreparedDirectory({
  preparedRoot,
  destination,
  fileOperations
}) {
  try {
    await fileOperations.mkdir(destination);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw sourceCollisionError(
        `Source destination was occupied while applying: ${destination}`
      );
    }
    throw error;
  }

  const markerPath = path.join(destination, SOURCE_INSTALLING_MARKER);
  try {
    await fileOperations.writeFile(
      markerPath,
      SOURCE_INSTALLING_MARKER_CONTENT,
      { flag: 'wx' }
    );
    for (const entry of await fileOperations.readdir(
      preparedRoot,
      { withFileTypes: true }
    )) {
      await fileOperations.rename(
        path.join(preparedRoot, entry.name),
        path.join(destination, entry.name)
      );
    }
    await fileOperations.rm(markerPath);
  } catch (error) {
    await removeFailedPublication(fileOperations, destination, error);
    throw error;
  }
}

async function removeFailedPublication(
  fileOperations,
  destination,
  originalError
) {
  try {
    await fileOperations.rm(destination, { recursive: true, force: true });
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source acquisition failed and rollback could not remove partial content'
    );
  }
}

async function resolveSafeDestination(rootDir, installPath) {
  const segments = installPath.split('/');
  const parentSegments = segments.slice(0, -1);
  try {
    const parent = await ensureSourceDirectory(rootDir, ...parentSegments);
    return path.join(parent, segments.at(-1));
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}

async function assertNoReservedPublicationMarker(contentRoot) {
  if (!await sourcePathExists(
    path.join(contentRoot, SOURCE_INSTALLING_MARKER)
  )) {
    return;
  }
  throw new SourceAcquisitionError(
    'source-validation',
    `Source contains reserved publication marker: ${SOURCE_INSTALLING_MARKER}`
  );
}
