import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { createGitUpgradeAdapter } from './sourceGitUpgradeAdapter.js';
import {
  commitGitSourceFastForward,
  discardGitSourceFastForward,
  prepareGitSourceFastForward,
  rollbackGitSourceFastForward
} from './sourceGitUpdateTransaction.js';
import {
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  assertNoAffectedProjectLinks,
  assertSameSourceUpgradePlan,
  classifySkillChanges,
  findAffectedProjectLinks,
  fingerprintSourceUpgradePlan
} from './sourceUpgradePolicy.js';

const gitUpdatePlanRequests = new WeakMap();

export async function planGitSourceUpdate(context, request) {
  const prepared = await buildGitSourceUpdatePlan(context, request);
  assertNoAffectedProjectLinks(prepared.plan.affectedProjectLinks);
  rememberPlan(prepared.plan, request, planGitSourceUpdate);
  return prepared.plan;
}

export async function planBreakingGitSourceUpdate(context, request) {
  const prepared = await buildGitSourceUpdatePlan(context, request);
  rememberPlan(prepared.plan, request, planBreakingGitSourceUpdate);
  return prepared.plan;
}

export async function applyGitSourceUpdate(context, plan) {
  assertGitUpdatePlan(plan);
  const remembered = gitUpdatePlanRequests.get(plan);
  if (!remembered) {
    throw new Error(
      'The Git update-source plan must be applied by the process that created it'
    );
  }

  const currentPlan = await remembered.replan(context, remembered.request);
  assertSameSourceUpgradePlan(
    fingerprintSourceUpgradePlan(plan),
    currentPlan,
    'Git source changed since the update plan'
  );
  if (currentPlan.status !== 'ready') return buildResult(currentPlan);
  const record = await findGitSourceRecord(
    context.rootDir,
    currentPlan.sourceId
  );

  const publication = await prepareGitSourceFastForward({
    rootDir: context.rootDir,
    record,
    nextRecord: buildUpdatedGitSourceRecord(record, currentPlan),
    incomingCommit: currentPlan.incomingCommit,
    publishRecord: context.publishRecord
  });
  try {
    try {
      await commitGitSourceFastForward(publication);
    } catch (error) {
      await rollbackGitSourceFastForward(publication);
      throw error;
    }
    return buildResult(currentPlan, 'updated');
  } finally {
    await discardGitSourceFastForward(publication);
  }
}

export async function updateRegisteredGitSources(
  context,
  { allowBreaking = false } = {}
) {
  const records = await readSourceRecords(context.rootDir);
  const sources = [];

  for (const record of records.filter((candidate) => candidate.type === 'git')) {
    try {
      const plan = await (
        allowBreaking ? planBreakingGitSourceUpdate : planGitSourceUpdate
      )(context, { sourceId: record.sourceId });
      const result = await applyGitSourceUpdate(context, plan);
      if (plan.changes.removedOrRelocated.length > 0) {
        sources.push(batchResult(
          record.sourceId,
          'breaking',
          'breaking-replacement',
          true
        ));
      } else {
        sources.push(batchResult(record.sourceId, result.status));
      }
    } catch (error) {
      sources.push(batchResult(
        record.sourceId,
        error.category === 'breaking-replacement' ? 'breaking' : 'failed',
        error.category || 'failure',
        false
      ));
    }
  }

  return { sources };
}

async function buildGitSourceUpdatePlan(context, request) {
  const sourceId = requireSourceId(request);
  if (request.input !== undefined) {
    throw new Error('Git source update does not accept replacement input');
  }
  const record = await findGitSourceRecord(context.rootDir, sourceId);
  const adapter = createGitUpgradeAdapter(context, request, record);
  const candidate = await adapter.inspect();
  const changes = classifySkillChanges(record.skills, candidate.skills);
  const affectedProjectLinks = await findAffectedProjectLinks({
    rootDir: context.rootDir,
    projectPath: context.projectPath,
    installPath: record.installPath,
    removedSkillPaths: changes.removedOrRelocated
  });
  return {
    adapter,
    record,
    plan: {
      operation: 'update-source',
      status: candidate.status,
      sourceId,
      installPath: record.installPath,
      input: candidate.input,
      currentCommit: candidate.currentCommit,
      incomingCommit: candidate.incomingCommit,
      skills: candidate.skills,
      warnings: candidate.warnings,
      changes,
      affectedProjectLinks
    }
  };
}

function rememberPlan(plan, request, replan) {
  gitUpdatePlanRequests.set(plan, {
    request: { sourceId: request.sourceId },
    replan
  });
}

function assertGitUpdatePlan(plan) {
  if (
    !plan ||
    plan.operation !== 'update-source' ||
    plan.input?.type !== 'git' ||
    !['ready', 'current', 'dirty'].includes(plan.status)
  ) {
    throw new Error('A valid Git update-source plan is required');
  }
}

function buildUpdatedGitSourceRecord(record, plan) {
  return {
    ...record,
    origin: {
      ...record.origin,
      commit: plan.incomingCommit
    },
    skills: plan.skills
  };
}

function buildResult(plan, status = plan.status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    commit: plan.incomingCommit,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes
  };
}

function batchResult(sourceId, status, category, applied) {
  return {
    sourceId,
    status,
    ...(category ? { category } : {}),
    ...(applied === undefined ? {} : { applied })
  };
}

async function findGitSourceRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw gitUpdateError(
      'unresolved-identity',
      `Source is not registered: ${sourceId}`,
      3
    );
  }
  return record;
}

function requireSourceId(request) {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.trim()) {
    throw new Error('Source update requires request.sourceId');
  }
  return validateSourceId(request.sourceId);
}

function gitUpdateError(category, message, exitCode = 1) {
  return new SourceAcquisitionError(category, message, exitCode);
}
