import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { parseRemoteArchiveInput } from './sourceHttp.js';
import {
  inspectRemoteArchive,
  stageRemoteArchive
} from './sourceArchiveWorkspace.js';
import {
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  assertActiveSourceMatchesRecord,
  classifySkillChanges,
  findAffectedProjectLinks
} from './sourceUpgradePolicy.js';
import {
  defaultSourceUpdateFileOperations,
  publishStagedLocalSourceReplacement
} from './sourceUpdateTransaction.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';

const archiveUpdatePlanRequests = new WeakMap();

export async function planArchiveSourceUpdate(context, request) {
  const preparedPlan = await buildArchiveUpdatePlan(context, request);
  assertNoAffectedProjectLinks(preparedPlan.plan.affectedProjectLinks);
  rememberArchiveUpdatePlan(
    preparedPlan,
    request,
    planArchiveSourceUpdate
  );
  return preparedPlan.plan;
}

export async function planBreakingArchiveSourceUpdate(context, request) {
  const preparedPlan = await buildArchiveUpdatePlan(context, request);
  rememberArchiveUpdatePlan(
    preparedPlan,
    request,
    planBreakingArchiveSourceUpdate
  );
  return preparedPlan.plan;
}

export async function applyArchiveSourceUpdate(context, plan) {
  assertArchiveUpdatePlan(plan);
  const privateRequest = archiveUpdatePlanRequests.get(plan);
  if (!privateRequest) {
    throw new Error('The update-source plan must be applied by the process that created it');
  }
  const currentPlan = await privateRequest.replan(
    context,
    privateRequest.request
  );
  assertSameArchiveUpdatePlan(plan, currentPlan);
  const record = await findArchiveRecord(context.rootDir, currentPlan.sourceId);
  const destination = path.resolve(context.rootDir, record.installPath);
  await assertActiveSourceMatchesRecord(destination, record);

  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'archive-update-'
  );
  const fileOperations = context.fileOperations ||
    defaultSourceUpdateFileOperations;

  try {
    const prepared = await stageRemoteArchive(
      context,
      privateRequest.parsed,
      workspace.root
    );
    assertPreparedArchiveMatchesPlan(prepared, currentPlan);
    await assertActiveSourceMatchesRecord(destination, record);
    await publishStagedLocalSourceReplacement({
      rootDir: context.rootDir,
      destination,
      stagingRoot: workspace.root,
      preparedContentRoot: prepared.contentRoot,
      nextRecord: buildUpdatedArchiveRecord(record, currentPlan),
      fileOperations
    });
    return buildArchiveUpdateResult(currentPlan);
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function buildArchiveUpdatePlan(context, request) {
  const sourceId = requireSourceId(request);
  const parsed = parseRemoteArchiveInput(request?.input);
  const record = await findArchiveRecord(context.rootDir, sourceId);
  const prepared = await inspectRemoteArchive(
    context,
    parsed,
    'skillcaddy-archive-update-plan-'
  );
  const changes = classifySkillChanges(record.skills, prepared.skills);
  const affectedProjectLinks = await findAffectedProjectLinks({
    rootDir: context.rootDir,
    projectPath: context.projectPath,
    installPath: record.installPath,
    removedSkillPaths: changes.removedOrRelocated
  });
  return {
    parsed,
    plan: {
      operation: 'update-source',
      status: 'ready',
      sourceId,
      installPath: record.installPath,
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
      warnings: prepared.warnings,
      changes,
      affectedProjectLinks
    }
  };
}

function rememberArchiveUpdatePlan(preparedPlan, request, replan) {
  archiveUpdatePlanRequests.set(preparedPlan.plan, {
    parsed: preparedPlan.parsed,
    replan,
    request: {
      sourceId: preparedPlan.plan.sourceId,
      input: request.input
    }
  });
}

async function findArchiveRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw new SourceAcquisitionError(
      'unresolved-identity',
      `Source is not registered: ${sourceId}`,
      3
    );
  }
  if (record.type !== 'archive') {
    throw new SourceAcquisitionError(
      'unsupported-source',
      `Remote Archive update requires an Archive source: ${sourceId}`
    );
  }
  return record;
}

function requireSourceId(request) {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.trim()) {
    throw new Error('Source update requires request.sourceId');
  }
  validateSourceId(request.sourceId);
  return request.sourceId;
}

function assertNoAffectedProjectLinks(affectedProjectLinks) {
  if (affectedProjectLinks.length === 0) return;
  throw new SourceAcquisitionError(
    'breaking-replacement',
    `Source replacement would break current-project links: ${
      affectedProjectLinks.map((link) => link.alias).join(', ')
    }. Re-run with --allow-breaking to authorize it.`,
    4
  );
}

function assertArchiveUpdatePlan(plan) {
  if (
    !plan ||
    plan.operation !== 'update-source' ||
    plan.status !== 'ready' ||
    plan.input?.type !== 'remote-zip'
  ) {
    throw new Error('A valid Archive update-source plan is required');
  }
}

function assertSameArchiveUpdatePlan(planned, current) {
  if (selectArchiveUpdateFacts(planned) !== selectArchiveUpdateFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Remote Archive changed since the update plan'
    );
  }
}

function assertPreparedArchiveMatchesPlan(prepared, plan) {
  assertSameArchiveUpdatePlan(plan, {
    ...plan,
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  });
}

function selectArchiveUpdateFacts(plan) {
  return JSON.stringify({
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes,
    affectedProjectLinks: plan.affectedProjectLinks
  });
}

function buildUpdatedArchiveRecord(record, plan) {
  return {
    ...record,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function buildArchiveUpdateResult(plan) {
  return {
    status: 'updated',
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes
  };
}
