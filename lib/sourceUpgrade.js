import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { createLocalUpgradeAdapter } from './sourceLocalUpgradeAdapter.js';
import {
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  cleanupDirectorySourceReplacement,
  commitDirectorySourceReplacement,
  defaultSourceUpdateFileOperations,
  discardDirectorySourceReplacement,
  prepareDirectorySourceReplacement,
  rollbackDirectorySourceReplacement
} from './sourceUpdateTransaction.js';
import {
  assertActiveSourceMatchesRecord,
  assertNoAffectedProjectLinks,
  assertSameSourceUpgradePlan,
  classifySkillChanges,
  findAffectedProjectLinks,
  fingerprintSourceUpgradePlan
} from './sourceUpgradePolicy.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';
const sourceUpgradePlans = new WeakMap();
const LOCAL_STALE_PLAN_MESSAGE =
  'Local source or replacement content changed since the update plan';
const LEGACY_UPGRADE_INPUT_TYPES = new Set([
  'git',
  'remote-file',
  'remote-zip'
]);
const SOURCE_UPGRADE_NOT_OWNED = Object.freeze({ status: 'not-owned' });
const SOURCE_UPGRADE_AUTHORIZATIONS = new Map([
  ['ordinary', Object.freeze({
    enforce(plan) {
      assertNoAffectedProjectLinks(plan.affectedProjectLinks);
    }
  })],
  ['breaking', Object.freeze({
    enforce() {}
  })]
]);

export async function planSourceUpgrade(context, command) {
  const request = command?.request;
  const authorizationPolicy = requireAuthorizationPolicy(
    command?.authorization
  );
  const preparedPlan = await buildLocalInputUpgradePlan(context, request);
  authorizationPolicy.enforce(preparedPlan.plan);
  sourceUpgradePlans.set(preparedPlan.plan, {
    authorizationPolicy,
    originalFingerprint: fingerprintSourceUpgradePlan(preparedPlan.plan),
    request: {
      sourceId: preparedPlan.plan.sourceId,
      input: request.input
    }
  });
  return preparedPlan.plan;
}

export async function applySourceUpgrade(context, plan) {
  const session = sourceUpgradePlans.get(plan);
  if (!session) {
    if (LEGACY_UPGRADE_INPUT_TYPES.has(plan?.input?.type)) {
      return SOURCE_UPGRADE_NOT_OWNED;
    }
    assertUpdatePlan(plan);
    throw new Error(
      'The update-source plan must be applied by the process that created it'
    );
  }
  assertOriginalPlan(session.originalFingerprint, plan);
  assertUpdatePlan(plan);

  const replannedUpgrade = await buildLocalInputUpgradePlan(
    context,
    session.request
  );
  session.authorizationPolicy.enforce(replannedUpgrade.plan);
  assertOriginalPlan(session.originalFingerprint, replannedUpgrade.plan);

  const destination = path.resolve(
    context.rootDir,
    replannedUpgrade.record.installPath
  );
  await assertActiveSourceMatchesRecord(destination, replannedUpgrade.record);
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'update-'
  );

  try {
    const candidate = await replannedUpgrade.adapter.prepare(workspace.root);
    assertPreparedCandidateMatchesPlan(candidate, replannedUpgrade.plan);
    await assertActiveSourceMatchesRecord(
      destination,
      replannedUpgrade.record
    );
    const publication = await prepareDirectorySourceReplacement({
      rootDir: context.rootDir,
      destination,
      stagingRoot: workspace.root,
      preparedContentRoot: candidate.contentRoot,
      nextRecord: buildUpdatedSourceRecord(
        replannedUpgrade.record,
        replannedUpgrade.plan
      ),
      fileOperations: context.fileOperations ||
        defaultSourceUpdateFileOperations
    });
    await runDirectoryReplacement(publication);
    return {
      status: 'applied',
      result: buildUpdateResult(replannedUpgrade.plan)
    };
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

function requireAuthorizationPolicy(authorization) {
  const policy = SOURCE_UPGRADE_AUTHORIZATIONS.get(authorization?.kind);
  if (!policy) {
    throw new Error('Source upgrade requires an authorization policy');
  }
  return policy;
}

async function buildLocalInputUpgradePlan(context, request) {
  const sourceId = requireSourceId(request);
  const record = await findLocalInputUpgradeRecord(context.rootDir, sourceId);
  const adapter = createLocalUpgradeAdapter(context, request);
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
      status: 'ready',
      sourceId,
      installPath: record.installPath,
      input: candidate.input,
      integrity: candidate.integrity,
      skills: candidate.skills,
      warnings: candidate.warnings,
      changes,
      affectedProjectLinks
    }
  };
}

async function runDirectoryReplacement(publication) {
  let phase = 'prepared';

  try {
    phase = 'committing';
    await commitDirectorySourceReplacement(publication);
    phase = 'committed';
    phase = 'cleanup';
    await cleanupDirectorySourceReplacement(publication);
  } catch (error) {
    if (phase === 'committing') {
      await rollbackBeforeCommit(publication, error);
    }
    throw error;
  } finally {
    await discardDirectorySourceReplacement(publication);
  }
}

async function rollbackBeforeCommit(publication, originalError) {
  try {
    await rollbackDirectorySourceReplacement(publication);
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source update failed and rollback could not restore the previous source'
    );
  }
}

async function findLocalInputUpgradeRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw new SourceAcquisitionError(
      'unresolved-identity',
      `Source is not registered: ${sourceId}`,
      3
    );
  }
  if (!['local', 'archive'].includes(record.type)) {
    throw new SourceAcquisitionError(
      'unsupported-source',
      `Local replacement requires a Local or Archive source: ${sourceId}`
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

function assertUpdatePlan(plan) {
  if (!plan || plan.operation !== 'update-source' || plan.status !== 'ready') {
    throw new Error('A valid update-source plan is required');
  }
}

function assertOriginalPlan(originalFingerprint, plan) {
  assertSameSourceUpgradePlan(
    originalFingerprint,
    plan,
    LOCAL_STALE_PLAN_MESSAGE
  );
}

function assertPreparedCandidateMatchesPlan(candidate, plan) {
  assertOriginalPlan(fingerprintSourceUpgradePlan(plan), {
    ...plan,
    input: candidate.input,
    integrity: candidate.integrity,
    skills: candidate.skills,
    warnings: candidate.warnings
  });
}

function buildUpdatedSourceRecord(record, plan) {
  return {
    ...record,
    origin: record.type === 'archive'
      ? record.origin
      : {
          kind: 'local',
          name: plan.input.name
        },
    integrity: plan.integrity,
    skills: plan.skills
  };
}

function buildUpdateResult(plan) {
  return {
    status: 'updated',
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes
  };
}
