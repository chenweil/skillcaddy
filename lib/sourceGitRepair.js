import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { canonicalJson } from './canonicalJson.js';
import { inspectGitRegistryRepair } from './sourceGitUpgradeAdapter.js';
import {
  assertNoAffectedLinks,
  classifySkillChanges,
  findAffectedGlobalLinks,
  findAffectedProjectLinks
} from './sourceUpgradePolicy.js';
import { readSourceRecords, writeSourceRecord } from './sourceRegistry.js';
import { validateSourceId } from './sourceRecord.js';

const repairPlans = new WeakMap();

export async function planGitSourceRepair(context, command) {
  const authorization = requireAuthorization(command?.authorization);
  const prepared = await buildRepairPlan(context, command?.request);
  authorization.enforce(prepared.plan);
  repairPlans.set(prepared.plan, {
    authorization,
    originalFingerprint: fingerprintRepairPlan(prepared.plan),
    request: { sourceId: prepared.plan.sourceId }
  });
  return prepared.plan;
}

export async function applyGitSourceRepair(context, plan) {
  const session = repairPlans.get(plan);
  if (!session) {
    assertRepairPlan(plan);
    throw new Error(
      'The Git registry repair plan must be applied by the process that created it'
    );
  }

  assertSameRepairPlan(
    session.originalFingerprint,
    plan,
    'Git source changed since the registry repair plan'
  );
  assertRepairPlan(plan);

  const replanned = await buildRepairPlan(context, session.request);
  session.authorization.enforce(replanned.plan);
  assertSameRepairPlan(
    session.originalFingerprint,
    replanned.plan,
    'Git source changed since the registry repair plan'
  );

  if (replanned.plan.status !== 'ready') {
    return buildRepairResult(replanned.plan);
  }

  const rootDir = requireRootDir(context);
  const record = replanned.record;
  await writeSourceRecord(rootDir, {
    ...record,
    origin: {
      ...record.origin,
      commit: replanned.plan.currentCommit
    },
    skills: replanned.plan.skills
  });
  return buildRepairResult(replanned.plan, 'repaired');
}

async function buildRepairPlan(context, request) {
  const rootDir = requireRootDir(context);
  const projectPath = requireProjectPath(context);
  const sourceId = requireSourceId(request);
  const record = await findGitRecord(rootDir, sourceId);
  const candidate = await inspectGitRegistryRepair({ rootDir }, record);
  const changes = classifySkillChanges(record.skills, candidate.skills);
  const affectedProjectLinks = candidate.status === 'dirty'
    ? []
    : await findAffectedProjectLinks({
        rootDir,
        projectPath,
        installPath: record.installPath,
        removedSkillPaths: changes.removedOrRelocated
      });
  const affectedGlobalLinks = candidate.status === 'dirty'
    ? []
    : await findAffectedGlobalLinks({
        rootDir,
        globalDir: context.globalDir,
        installPath: record.installPath,
        removedSkillPaths: changes.removedOrRelocated
      });

  return {
    record,
    plan: {
      operation: 'repair-source-registry',
      status: candidate.status,
      sourceId,
      installPath: record.installPath,
      input: {
        type: 'git',
        remote: record.origin.remote
      },
      registeredCommit: record.origin.commit,
      currentCommit: candidate.currentCommit,
      skills: candidate.skills,
      warnings: candidate.warnings,
      changes,
      affectedProjectLinks,
      ...(affectedGlobalLinks.length > 0 ? { affectedGlobalLinks } : {})
    }
  };
}

async function findGitRecord(rootDir, sourceId) {
  const records = await readSourceRecords(rootDir);
  const record = records.find((candidate) => candidate.sourceId === sourceId);
  if (!record) {
    throw new SourceAcquisitionError(
      'unresolved-identity',
      `Source is not registered: ${sourceId}`,
      3
    );
  }
  if (record.type !== 'git') {
    throw new SourceAcquisitionError(
      'unsupported-source',
      `Git registry repair requires a Git source: ${sourceId}`
    );
  }
  return record;
}

function buildRepairResult(plan, status = plan.status) {
  return {
    status: status === 'ready' ? 'repaired' : status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    commit: plan.currentCommit,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes
  };
}

function requireAuthorization(authorization) {
  if (authorization?.kind === 'breaking') return { enforce() {} };
  if (authorization?.kind === 'ordinary') {
    return { enforce: (plan) => assertNoAffectedLinks(plan.affectedProjectLinks, plan.affectedGlobalLinks) };
  }
  throw new Error('Git registry repair requires an authorization policy');
}

function requireRootDir(context) {
  if (!context || typeof context.rootDir !== 'string' || !context.rootDir.trim()) {
    throw new Error('Source management requires context.rootDir');
  }
  return path.resolve(context.rootDir);
}

function requireProjectPath(context) {
  if (!context || typeof context.projectPath !== 'string' || !context.projectPath.trim()) {
    throw new Error('Git registry repair requires context.projectPath');
  }
  return path.resolve(context.projectPath);
}

function requireSourceId(request) {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.trim()) {
    throw new Error('Git registry repair requires request.sourceId');
  }
  if (request.input !== undefined) {
    throw new Error('Git registry repair does not accept replacement input');
  }
  validateSourceId(request.sourceId);
  return request.sourceId;
}

function assertRepairPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'repair-source-registry' ||
    !['ready', 'current', 'dirty'].includes(plan.status)
  ) {
    throw new Error('A valid Git registry repair plan is required');
  }
}

function fingerprintRepairPlan(plan) {
  return canonicalJson({
    operation: plan.operation,
    status: plan.status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    registeredCommit: plan.registeredCommit,
    currentCommit: plan.currentCommit,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes,
    affectedProjectLinks: plan.affectedProjectLinks,
    affectedGlobalLinks: plan.affectedGlobalLinks
  });
}

function assertSameRepairPlan(originalFingerprint, plan, message) {
  if (originalFingerprint !== fingerprintRepairPlan(plan)) {
    throw new SourceAcquisitionError('stale-plan', message);
  }
}
