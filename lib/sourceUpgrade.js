/**
 * Source upgrade lifecycle
 *
 * This module owns planning, re-planning, authorization, execution,
 * and result projection for all source upgrades.
 *
 * Architecture note: Local, Remote Archive, and Remote File upgrade
 * preparation logic is inlined here as private helpers rather than
 * separate adapter modules, because they are thin wrappers (38-44 lines)
 * with only one caller. The Git upgrade adapter remains a separate module
 * (sourceGitUpgradeAdapter.js) due to its depth (327 lines) and complexity.
 *
 * See ADR-0004 for the centralized upgrade lifecycle decision.
 */
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { createGitUpgradeAdapter } from './sourceGitUpgradeAdapter.js';
import { isRemoteArchiveInput, parseRemoteArchiveInput, parseRemoteSkillFileInput } from './sourceHttp.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';
import { inspectRemoteArchive, stageRemoteArchive } from './sourceArchiveWorkspace.js';
import { inspectRemoteSkillFile, stageRemoteSkillFile } from './sourceRemoteFileWorkspace.js';
import {
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import { executeSourceUpgrade } from './sourceUpgradeExecution.js';
import {
  assertNoAffectedProjectLinks,
  assertSameSourceUpgradePlan,
  classifySkillChanges,
  findAffectedProjectLinks,
  fingerprintSourceUpgradePlan
} from './sourceUpgradePolicy.js';
const sourceUpgradePlans = new WeakMap();
const LOCAL_STALE_PLAN_MESSAGE =
  'Local source or replacement content changed since the update plan';
const REMOTE_ARCHIVE_STALE_PLAN_MESSAGE =
  'Remote Archive changed since the update plan';
const REMOTE_FILE_STALE_PLAN_MESSAGE =
  'Remote SKILL.md changed since the update plan';
const GIT_STALE_PLAN_MESSAGE =
  'Git source changed since the update plan';
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
  const preparedPlan = await buildSourceUpgradePlan(context, request);
  authorizationPolicy.enforce(preparedPlan.plan);
  sourceUpgradePlans.set(preparedPlan.plan, {
    authorizationPolicy,
    originalFingerprint: fingerprintSourceUpgradePlan(preparedPlan.plan),
    stalePlanMessage: preparedPlan.stalePlanMessage,
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
    assertUpdatePlan(plan);
    throw copiedPlanError(plan);
  }
  assertOriginalPlan(
    session.originalFingerprint,
    plan,
    session.stalePlanMessage
  );
  assertUpdatePlan(plan);

  const replannedUpgrade = await buildSourceUpgradePlan(
    context,
    session.request
  );
  session.authorizationPolicy.enforce(replannedUpgrade.plan);
  assertOriginalPlan(
    session.originalFingerprint,
    replannedUpgrade.plan,
    session.stalePlanMessage
  );

  await executeSourceUpgrade(
    context,
    replannedUpgrade,
    session.stalePlanMessage
  );
  return {
    status: 'applied',
    result: buildUpdateResult(replannedUpgrade.plan)
  };
}

function requireAuthorizationPolicy(authorization) {
  const policy = SOURCE_UPGRADE_AUTHORIZATIONS.get(authorization?.kind);
  if (!policy) {
    throw new Error('Source upgrade requires an authorization policy');
  }
  return policy;
}

async function buildSourceUpgradePlan(context, request) {
  const sourceId = requireSourceId(request);
  const record = await findSourceUpgradeRecord(context.rootDir, sourceId);
  const selectedAdapter = selectUpgradeAdapter(context, request, record);
  const adapter = selectedAdapter.adapter;
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
    kind: selectedAdapter.kind,
    record,
    stalePlanMessage: selectedAdapter.stalePlanMessage,
    plan: buildUpgradePlan({
      sourceId,
      record,
      candidate,
      changes,
      affectedProjectLinks
    })
  };
}

function selectUpgradeAdapter(context, request, record) {
  if (record.type === 'git') {
    return {
      adapter: createGitUpgradeAdapter(context, request, record),
      kind: 'git',
      stalePlanMessage: GIT_STALE_PLAN_MESSAGE
    };
  }

  if (record.type === 'remote-file') {
    return {
      adapter: createInlineRemoteFileUpgradeAdapter(context, request, record),
      kind: 'directory',
      stalePlanMessage: REMOTE_FILE_STALE_PLAN_MESSAGE
    };
  }

  if (isRemoteArchiveInput(request?.input)) {
    if (record.type !== 'archive') {
      throw new SourceAcquisitionError(
        'unsupported-source',
        `Remote Archive update requires an Archive source: ${record.sourceId}`
      );
    }
    return {
      adapter: createInlineRemoteArchiveUpgradeAdapter(context, request),
      kind: 'directory',
      stalePlanMessage: REMOTE_ARCHIVE_STALE_PLAN_MESSAGE
    };
  }

  if (!['local', 'archive'].includes(record.type)) {
    throw new SourceAcquisitionError(
      'unsupported-source',
      `Local replacement requires a Local or Archive source: ${record.sourceId}`
    );
  }
  return {
    adapter: createInlineLocalUpgradeAdapter(context, request),
    kind: 'directory',
    stalePlanMessage: LOCAL_STALE_PLAN_MESSAGE
  };
}

function buildUpgradePlan({
  sourceId,
  record,
  candidate,
  changes,
  affectedProjectLinks
}) {
  return {
    operation: 'update-source',
    status: candidate.status || 'ready',
    sourceId,
    installPath: record.installPath,
    input: candidate.input,
    ...(candidate.origin ? { origin: candidate.origin } : {}),
    ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
    ...(candidate.currentCommit ? {
      currentCommit: candidate.currentCommit,
      incomingCommit: candidate.incomingCommit
    } : {}),
    skills: candidate.skills,
    warnings: candidate.warnings,
    changes,
    affectedProjectLinks
  };
}

async function findSourceUpgradeRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw new SourceAcquisitionError(
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
  validateSourceId(request.sourceId);
  return request.sourceId;
}

function assertUpdatePlan(plan) {
  const validStatus = plan?.input?.type === 'git'
    ? ['ready', 'current', 'dirty'].includes(plan?.status)
    : plan?.status === 'ready';
  if (!plan || plan.operation !== 'update-source' || !validStatus) {
    throw new Error('A valid update-source plan is required');
  }
}

function copiedPlanError(plan) {
  return new Error(
    plan.input?.type === 'git'
      ? 'The Git update-source plan must be applied by the process that created it'
      : 'The update-source plan must be applied by the process that created it'
  );
}

function assertOriginalPlan(originalFingerprint, plan, stalePlanMessage) {
  assertSameSourceUpgradePlan(
    originalFingerprint,
    plan,
    stalePlanMessage
  );
}

function buildUpdateResult(plan, status = plan.status) {
  if (plan.input.type === 'git') {
    return {
      status: status === 'ready' ? 'updated' : status,
      sourceId: plan.sourceId,
      installPath: plan.installPath,
      commit: plan.incomingCommit,
      skills: plan.skills,
      warnings: plan.warnings,
      changes: plan.changes
    };
  }
  return {
    status: status === 'ready' ? 'updated' : status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    ...(plan.origin ? { origin: plan.origin } : {}),
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes
  };
}

// === Private: Inline upgrade adapters ===

function createInlineLocalUpgradeAdapter(context, request) {
  const inputPath = requireUpdateInput(request);

  return {
    inspect: async () => projectLocalCandidate(
      await inspectLocalInput(inputPath, { archiveLimits: context?.archiveLimits })
    ),
    prepare: async (workspaceRoot) => projectLocalCandidate(
      await stageLocalInput(inputPath, workspaceRoot, { archiveLimits: context?.archiveLimits })
    )
  };
}

function createInlineRemoteArchiveUpgradeAdapter(context, request) {
  const parsed = parseRemoteArchiveInput(request?.input);

  return {
    async inspect() {
      const candidate = await inspectRemoteArchive(
        context,
        parsed,
        'skillcaddy-archive-update-plan-'
      );
      return projectRemoteArchiveCandidate(parsed, candidate);
    },
    async prepare(stagingRoot) {
      const candidate = await stageRemoteArchive(
        context,
        parsed,
        stagingRoot
      );
      return projectRemoteArchiveCandidate(parsed, candidate);
    }
  };
}

function createInlineRemoteFileUpgradeAdapter(context, request, record) {
  const parsed = parseRemoteSkillFileInput(
    request?.input ?? record.origin.display
  );

  return {
    async inspect() {
      const candidate = await inspectRemoteSkillFile(
        context,
        parsed,
        'skillcaddy-remote-file-update-plan-'
      );
      return projectRemoteFileCandidate(parsed, candidate);
    },
    async prepare(stagingRoot) {
      const candidate = await stageRemoteSkillFile(
        context,
        parsed,
        stagingRoot
      );
      return projectRemoteFileCandidate(parsed, candidate);
    }
  };
}

// === Private: Projection helpers ===

function requireUpdateInput(request) {
  if (typeof request?.input !== 'string' || !request.input.trim()) {
    throw new Error('Source update requires request.input');
  }
  return path.resolve(request.input);
}

function projectLocalCandidate(prepared) {
  return {
    ...(prepared.contentRoot ? { contentRoot: prepared.contentRoot } : {}),
    input: {
      type: prepared.type,
      name: prepared.basename
    },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  };
}

function projectRemoteArchiveCandidate(parsed, candidate) {
  return {
    ...candidate,
    input: {
      type: 'remote-zip',
      display: parsed.display
    },
    origin: {
      kind: parsed.protocol,
      display: parsed.display
    }
  };
}

function projectRemoteFileCandidate(parsed, candidate) {
  return {
    ...candidate,
    input: {
      type: 'remote-file',
      display: parsed.display
    },
    origin: {
      kind: parsed.protocol,
      display: parsed.display
    }
  };
}
