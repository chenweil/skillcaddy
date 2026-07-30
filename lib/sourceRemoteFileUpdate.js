import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { parseRemoteSkillFileInput } from './sourceHttp.js';
import {
  inspectRemoteSkillFile,
  stageRemoteSkillFile
} from './sourceRemoteFileWorkspace.js';
import { readSourceRecords, validateSourceId } from './sourceRegistry.js';
import {
  assertActiveSourceMatchesRecord,
  assertNoAffectedProjectLinks,
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

const remoteFileUpdatePlanRequests = new WeakMap();

export async function planRemoteFileSourceUpdate(context, request) {
  const preparedPlan = await buildRemoteFileUpdatePlan(context, request);
  assertNoAffectedProjectLinks(preparedPlan.plan.affectedProjectLinks);
  rememberRemoteFileUpdatePlan(
    preparedPlan,
    request,
    planRemoteFileSourceUpdate
  );
  return preparedPlan.plan;
}

export async function planBreakingRemoteFileSourceUpdate(context, request) {
  const preparedPlan = await buildRemoteFileUpdatePlan(context, request);
  rememberRemoteFileUpdatePlan(
    preparedPlan,
    request,
    planBreakingRemoteFileSourceUpdate
  );
  return preparedPlan.plan;
}

export async function applyRemoteFileSourceUpdate(context, plan) {
  assertRemoteFileUpdatePlan(plan);
  const privateRequest = remoteFileUpdatePlanRequests.get(plan);
  if (!privateRequest) {
    throw new Error('The update-source plan must be applied by the process that created it');
  }

  const currentPlan = await privateRequest.replan(context, privateRequest.request);
  assertSameRemoteFileUpdatePlan(plan, currentPlan);

  const destination = path.resolve(context.rootDir, currentPlan.installPath);
  const record = await findRemoteFileRecord(context.rootDir, currentPlan.sourceId);
  await assertActiveSourceMatchesRecord(destination, record);
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'remote-file-update-'
  );
  const fileOperations = context.fileOperations || defaultSourceUpdateFileOperations;

  try {
    const prepared = await stageRemoteSkillFile(
      context,
      privateRequest.parsed,
      workspace.root
    );
    assertPreparedRemoteFileMatchesPlan(prepared, currentPlan);
    await assertActiveSourceMatchesRecord(destination, record);
    await publishStagedLocalSourceReplacement({
      rootDir: context.rootDir,
      destination,
      stagingRoot: workspace.root,
      preparedContentRoot: prepared.contentRoot,
      nextRecord: buildUpdatedRemoteFileRecord(record, currentPlan),
      fileOperations
    });
    return buildRemoteFileUpdateResult(currentPlan);
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function buildRemoteFileUpdatePlan(context, request) {
  const sourceId = requireSourceId(request);
  const record = await findRemoteFileRecord(context.rootDir, sourceId);
  const parsed = parseRemoteSkillFileInput(request.input ?? record.origin.display);
  const prepared = await inspectRemoteSkillFile(
    context,
    parsed,
    'skillcaddy-remote-file-update-plan-'
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
        type: 'remote-file',
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

function rememberRemoteFileUpdatePlan(preparedPlan, request, replan) {
  remoteFileUpdatePlanRequests.set(preparedPlan.plan, {
    parsed: preparedPlan.parsed,
    replan,
    request: {
      sourceId: preparedPlan.plan.sourceId,
      ...(request.input === undefined ? {} : { input: request.input })
    }
  });
}

async function findRemoteFileRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw new SourceAcquisitionError(
      'unresolved-identity',
      `Source is not registered: ${sourceId}`,
      3
    );
  }
  if (record.type !== 'remote-file') {
    throw new SourceAcquisitionError(
      'unsupported-source',
      `Remote file update requires a Remote file source: ${sourceId}`
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

function assertRemoteFileUpdatePlan(plan) {
  if (
    !plan ||
    plan.operation !== 'update-source' ||
    plan.status !== 'ready' ||
    plan.input?.type !== 'remote-file'
  ) {
    throw new Error('A valid Remote file update-source plan is required');
  }
}

function assertSameRemoteFileUpdatePlan(planned, current) {
  if (selectRemoteFileUpdateFacts(planned) !== selectRemoteFileUpdateFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Remote SKILL.md changed since the update plan'
    );
  }
}

function assertPreparedRemoteFileMatchesPlan(prepared, plan) {
  assertSameRemoteFileUpdatePlan(plan, {
    ...plan,
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  });
}

function selectRemoteFileUpdateFacts(plan) {
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

function buildUpdatedRemoteFileRecord(record, plan) {
  return {
    ...record,
    origin: plan.origin,
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function buildRemoteFileUpdateResult(plan) {
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
