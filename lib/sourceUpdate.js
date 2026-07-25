import {
  mkdtemp,
  rm,
  rmdir
} from 'node:fs/promises';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { scanEnabledSkills } from './skillStore.js';
import {
  inspectLocalInput,
  stageLocalInput
} from './sourceLocal.js';
import {
  readSourceRecords,
  validateSourceId
} from './sourceRegistry.js';
import {
  checksumDirectory,
  ensureSourceDirectory,
  sourcePathExists
} from './sourceTree.js';
import {
  defaultSourceUpdateFileOperations,
  publishStagedLocalSourceReplacement
} from './sourceUpdateTransaction.js';

const updatePlanRequests = new WeakMap();

export async function planLocalSourceUpdate({
  rootDir,
  archiveLimits,
  projectPath
}, request) {
  const preparedPlan = await buildLocalSourceUpdatePlan({
    rootDir,
    archiveLimits,
    projectPath
  }, request);
  assertNoAffectedProjectLinks(preparedPlan.plan.affectedProjectLinks);
  rememberUpdatePlan(preparedPlan, request, planLocalSourceUpdate);
  return preparedPlan.plan;
}

export async function planBreakingLocalSourceUpdate({
  rootDir,
  archiveLimits,
  projectPath
}, request) {
  const preparedPlan = await buildLocalSourceUpdatePlan({
    rootDir,
    archiveLimits,
    projectPath
  }, request);
  rememberUpdatePlan(preparedPlan, request, planBreakingLocalSourceUpdate);
  return preparedPlan.plan;
}

async function buildLocalSourceUpdatePlan({
  rootDir,
  archiveLimits,
  projectPath
}, request) {
  const sourceId = requireSourceId(request);
  const inputPath = requireUpdateInput(request);
  const record = await findUpdateRecord(rootDir, sourceId);
  const prepared = await inspectLocalInput(inputPath, { archiveLimits });
  const changes = classifySkillChanges(record.skills, prepared.skills);
  const affectedProjectLinks = await findAffectedProjectLinks({
    rootDir,
    projectPath,
    installPath: record.installPath,
    removedSkillPaths: changes.removedOrRelocated
  });
  const plan = {
    operation: 'update-source',
    status: 'ready',
    sourceId,
    installPath: record.installPath,
    input: {
      type: prepared.type,
      name: prepared.basename
    },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings,
    changes,
    affectedProjectLinks
  };

  return { plan, inputPath };
}

export function assertNoAffectedProjectLinks(affectedProjectLinks) {
  if (affectedProjectLinks.length === 0) return;
  throw new SourceAcquisitionError(
    'breaking-replacement',
    `Source replacement would break current-project links: ${
      affectedProjectLinks.map((link) => link.alias).join(', ')
    }. Re-run with --allow-breaking to authorize it.`,
    4
  );
}

function rememberUpdatePlan(preparedPlan, request, replan) {
  const { plan, inputPath } = preparedPlan;
  updatePlanRequests.set(plan, {
    inputPath,
    replan,
    request: {
      sourceId: plan.sourceId,
      input: request.input
    }
  });
}

export async function findAffectedProjectLinks({
  rootDir,
  projectPath,
  installPath,
  removedSkillPaths
}) {
  if (!projectPath || removedSkillPaths.length === 0) return [];
  const removedByTarget = new Map(removedSkillPaths.map((skillPath) => [
    path.resolve(rootDir, installPath, skillPath),
    skillPath
  ]));
  const links = await scanEnabledSkills(projectPath);
  return links
    .filter((link) => link.isSymlink && removedByTarget.has(link.targetPath))
    .map((link) => ({
      alias: link.alias,
      skillPath: removedByTarget.get(link.targetPath)
    }));
}

export async function applyLocalSourceUpdate({
  rootDir,
  archiveLimits,
  projectPath,
  fileOperations = defaultSourceUpdateFileOperations
}, plan) {
  assertUpdatePlan(plan);
  const privateRequest = updatePlanRequests.get(plan);
  if (!privateRequest) {
    throw new Error('The update-source plan must be applied by the process that created it');
  }

  const currentPlan = await privateRequest.replan({
    rootDir,
    archiveLimits,
    projectPath
  }, privateRequest.request);
  assertSameUpdatePlan(plan, currentPlan);

  const destination = path.resolve(rootDir, currentPlan.installPath);
  const record = await findUpdateRecord(rootDir, currentPlan.sourceId);
  await assertActiveSourceMatchesRecord(destination, record);

  const stagingParent = await requireSafeDirectory(rootDir, '.skillcaddy', 'staging');
  const stagingRoot = await mkdtemp(path.join(stagingParent, 'update-'));

  try {
    const prepared = await stageLocalInput(privateRequest.inputPath, stagingRoot, {
      archiveLimits
    });
    assertPreparedInputMatchesPlan(prepared, currentPlan);
    await assertActiveSourceMatchesRecord(destination, record);
    await publishStagedLocalSourceReplacement({
      rootDir,
      destination,
      stagingRoot,
      preparedContentRoot: prepared.contentRoot,
      nextRecord: buildUpdatedSourceRecord(record, currentPlan),
      fileOperations
    });

    return buildUpdateResult(currentPlan);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await removeEmptyDirectory(stagingParent);
  }
}

function requireSourceId(request) {
  if (!request || typeof request.sourceId !== 'string' || !request.sourceId.trim()) {
    throw new Error('Source update requires request.sourceId');
  }
  validateSourceId(request.sourceId);
  return request.sourceId;
}

function requireUpdateInput(request) {
  if (typeof request?.input !== 'string' || !request.input.trim()) {
    throw new Error('Source update requires request.input');
  }
  return path.resolve(request.input);
}

async function findUpdateRecord(rootDir, sourceId) {
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

export async function assertActiveSourceMatchesRecord(destination, record) {
  if (!(await sourcePathExists(destination))) {
    throw new SourceAcquisitionError(
      'source-collision',
      `Registered source content is missing: ${record.sourceId}`,
      3
    );
  }
  if (await checksumDirectory(destination) !== record.integrity?.value) {
    throw new SourceAcquisitionError(
      'source-collision',
      `Registered source content no longer matches its integrity: ${record.sourceId}`,
      3
    );
  }
}

function assertUpdatePlan(plan) {
  if (!plan || plan.operation !== 'update-source' || plan.status !== 'ready') {
    throw new Error('A valid update-source plan is required');
  }
}

function assertSameUpdatePlan(planned, current) {
  if (selectPlanFacts(planned) !== selectPlanFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Local source or replacement content changed since the update plan'
    );
  }
}

function assertPreparedInputMatchesPlan(prepared, plan) {
  const preparedPlan = {
    ...plan,
    input: { type: prepared.type, name: prepared.basename },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  };
  assertSameUpdatePlan(plan, preparedPlan);
}

function selectPlanFacts(plan) {
  return JSON.stringify({
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    integrity: plan.integrity,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes,
    affectedProjectLinks: plan.affectedProjectLinks
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

export function classifySkillChanges(previousSkills, nextSkills) {
  const previous = new Set(previousSkills);
  const next = new Set(nextSkills);
  return {
    unchanged: previousSkills.filter((skillPath) => next.has(skillPath)),
    added: nextSkills.filter((skillPath) => !previous.has(skillPath)),
    removedOrRelocated: previousSkills.filter((skillPath) => !next.has(skillPath))
  };
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
