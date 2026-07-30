import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdtemp,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { canonicalGitRepositoryLocation } from './sourceGitUrl.js';
import { SOURCE_INSTALLING_MARKER } from './sourcePolicy.js';
import { sanitizeGitRemote } from './sourceRecord.js';
import {
  discardStagedSourceRecord,
  publishStagedSourceRecord,
  readSourceRecords,
  stageSourceRecord,
  validateSourceId,
  writeSourceRecord
} from './sourceRegistry.js';
import { sourcePathExists, validateSourceTree } from './sourceTree.js';
import {
  assertNoAffectedProjectLinks,
  classifySkillChanges,
  findAffectedProjectLinks
} from './sourceUpgradePolicy.js';
import { validateStagedSource } from './sourceValidation.js';

const execFile = promisify(execFileCallback);
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

export async function applyGitSourceUpdate({
  rootDir,
  projectPath,
  publishRecord = publishStagedSourceRecord
}, plan) {
  assertGitUpdatePlan(plan);
  const remembered = gitUpdatePlanRequests.get(plan);
  if (!remembered) {
    throw new Error('The Git update-source plan must be applied by the process that created it');
  }

  const currentPlan = await remembered.replan(
    { rootDir, projectPath },
    remembered.request
  );
  assertSamePlan(plan, currentPlan);
  if (currentPlan.status !== 'ready') return buildResult(currentPlan);

  const destination = path.resolve(rootDir, currentPlan.installPath);
  const record = await findGitSourceRecord(rootDir, currentPlan.sourceId);
  const stagedRecord = await stageSourceRecord(rootDir, {
    ...record,
    origin: {
      ...record.origin,
      commit: currentPlan.incomingCommit
    },
    skills: currentPlan.skills
  });
  let recordPublished = false;
  try {
    await publishRecord(stagedRecord);
    recordPublished = true;
    await execGit(destination, [
      'merge',
      '--ff-only',
      '--no-edit',
      currentPlan.incomingCommit
    ], currentPlan.sourceId, 'Could not fast-forward Git source');
    const installedCommit = await readGitOutput(destination, ['rev-parse', 'HEAD']);
    if (installedCommit !== currentPlan.incomingCommit) {
      throw gitUpdateError(
        'git-update',
        `Git source did not advance to the planned commit: ${currentPlan.sourceId}`
      );
    }

    return buildResult(currentPlan, 'updated');
  } catch (error) {
    if (recordPublished) await writeSourceRecord(rootDir, record);
    throw error;
  } finally {
    await discardStagedSourceRecord(stagedRecord);
  }
}

export async function updateRegisteredGitSources(context, { allowBreaking = false } = {}) {
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

async function buildGitSourceUpdatePlan({ rootDir, projectPath }, request) {
  const sourceId = requireSourceId(request);
  if (request.input !== undefined) {
    throw new Error('Git source update does not accept replacement input');
  }
  const record = await findGitSourceRecord(rootDir, sourceId);
  const destination = path.resolve(rootDir, record.installPath);
  if (!(await sourcePathExists(destination))) {
    throw gitUpdateError(
      'source-collision',
      `Registered source content is missing: ${sourceId}`,
      3
    );
  }

  const currentCommit = await readGitOutput(destination, ['rev-parse', 'HEAD'], sourceId);
  const branch = await readGitOutput(
    destination,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    sourceId
  );
  if (branch !== record.origin.ref) {
    throw gitUpdateError(
      'source-collision',
      `Registered Git source is not on its tracked ref: ${sourceId}`,
      3
    );
  }
  const configuredRemote = sanitizeGitRemote(
    await readGitOutput(destination, ['config', '--get', 'remote.origin.url'], sourceId)
  );
  if (
    canonicalGitRepositoryLocation(configuredRemote) !==
    canonicalGitRepositoryLocation(record.origin.remote)
  ) {
    throw gitUpdateError(
      'source-collision',
      `Registered Git source origin does not match its source record: ${sourceId}`,
      3
    );
  }

  const status = await readGitOutput(destination, ['status', '--porcelain'], sourceId);
  if (status) {
    return {
      plan: buildPlan({
        record,
        status: 'dirty',
        currentCommit,
        incomingCommit: currentCommit,
        skills: record.skills,
        warnings: [],
        changes: classifySkillChanges(record.skills, record.skills),
        affectedProjectLinks: []
      })
    };
  }

  await execGit(
    destination,
    ['fetch', '--no-tags', 'origin', `refs/heads/${record.origin.ref}`],
    sourceId,
    'Could not fetch Git source'
  );
  const incomingCommit = await readGitOutput(destination, ['rev-parse', 'FETCH_HEAD'], sourceId);
  if (incomingCommit === currentCommit) {
    if (record.origin.commit !== currentCommit) {
      throw gitUpdateError(
        'source-collision',
        `Registered Git source commit does not match its source record: ${sourceId}`,
        3
      );
    }
    return {
      plan: buildPlan({
        record,
        status: 'current',
        currentCommit,
        incomingCommit,
        skills: record.skills,
        warnings: [],
        changes: classifySkillChanges(record.skills, record.skills),
        affectedProjectLinks: []
      })
    };
  }

  if (!await isAncestor(destination, currentCommit, incomingCommit, sourceId)) {
    throw gitUpdateError(
      'non-fast-forward',
      `Git source cannot advance by fast-forward: ${sourceId}`
    );
  }
  if (record.origin.commit !== currentCommit) {
    throw gitUpdateError(
      'source-collision',
      `Registered Git source commit does not match its source record: ${sourceId}`,
      3
    );
  }

  const prepared = await inspectGitTrees(
    destination,
    currentCommit,
    incomingCommit,
    record
  );
  if (JSON.stringify(prepared.current.skills) !== JSON.stringify(record.skills)) {
    throw gitUpdateError(
      'source-collision',
      `Registered Git source skills do not match its source record: ${sourceId}`,
      3
    );
  }
  const changes = classifySkillChanges(
    prepared.current.skills,
    prepared.incoming.skills
  );
  const affectedProjectLinks = await findAffectedProjectLinks({
    rootDir,
    projectPath,
    installPath: record.installPath,
    removedSkillPaths: changes.removedOrRelocated
  });
  return {
    plan: buildPlan({
      record,
      status: 'ready',
      currentCommit,
      incomingCommit,
      skills: prepared.incoming.skills,
      warnings: prepared.incoming.warnings,
      changes,
      affectedProjectLinks
    })
  };
}

async function inspectGitTrees(destination, currentCommit, incomingCommit, record) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'skillcaddy-git-update-'));
  const contentRoot = path.join(stagingRoot, 'repository');
  try {
    await execGit(
      stagingRoot,
      ['clone', '--quiet', '--no-checkout', '--', destination, contentRoot],
      record.sourceId,
      'Could not inspect incoming Git source'
    );
    const current = await checkoutAndValidateTree({
      stagingRoot,
      contentRoot,
      commit: currentCommit,
      record
    });
    const incoming = currentCommit === incomingCommit
      ? current
      : await checkoutAndValidateTree({
          stagingRoot,
          contentRoot,
          commit: incomingCommit,
          record
        });
    return { current, incoming };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function checkoutAndValidateTree({
  stagingRoot,
  contentRoot,
  commit,
  record
}) {
  await execGit(
    contentRoot,
    ['checkout', '--quiet', '--detach', commit],
    record.sourceId,
    'Could not inspect Git source tree'
  );
  if (await sourcePathExists(path.join(contentRoot, SOURCE_INSTALLING_MARKER))) {
    throw gitUpdateError(
      'source-validation',
      `Git source contains reserved publication marker: ${SOURCE_INSTALLING_MARKER}`
    );
  }
  await validateSourceTree(stagingRoot, contentRoot);
  const validated = await validateStagedSource(contentRoot);
  assertFocusContainsSkill(validated.skills, record.focus);
  return validated;
}

function buildPlan({
  record,
  status,
  currentCommit,
  incomingCommit,
  skills,
  warnings,
  changes,
  affectedProjectLinks
}) {
  return {
    operation: 'update-source',
    status,
    sourceId: record.sourceId,
    installPath: record.installPath,
    input: {
      type: 'git',
      remote: record.origin.remote
    },
    currentCommit,
    incomingCommit,
    skills,
    warnings,
    changes,
    affectedProjectLinks
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

function assertSamePlan(planned, current) {
  const facts = (plan) => JSON.stringify({
    status: plan.status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    currentCommit: plan.currentCommit,
    incomingCommit: plan.incomingCommit,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes,
    affectedProjectLinks: plan.affectedProjectLinks
  });
  if (facts(planned) !== facts(current)) {
    throw gitUpdateError('stale-plan', 'Git source changed since the update plan');
  }
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
    throw gitUpdateError('unresolved-identity', `Source is not registered: ${sourceId}`, 3);
  }
  if (record.type !== 'git') {
    throw gitUpdateError('unsupported-source', `Git update requires a Git source: ${sourceId}`);
  }
  if (!record.origin.ref || !record.origin.commit) {
    throw gitUpdateError(
      'unresolved-identity',
      `Git source record requires a tracked ref and commit: ${sourceId}`,
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

async function readGitOutput(directory, args, sourceId = 'source') {
  const result = await execGit(directory, args, sourceId, 'Could not inspect Git source');
  return result.stdout.trim();
}

async function isAncestor(directory, ancestor, descendant, sourceId) {
  try {
    await execFile('git', [
      '-C',
      directory,
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant
    ]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw gitUpdateError('git-update', `Could not compare Git source commits: ${sourceId}`);
  }
}

async function execGit(directory, args, sourceId, action) {
  try {
    return await execFile('git', ['-C', directory, ...args]);
  } catch {
    throw gitUpdateError('git-update', `${action}: ${sourceId}`);
  }
}

function assertFocusContainsSkill(skills, focus) {
  if (!focus?.path) return;
  if (!skills.some(
    (skillPath) => skillPath === focus.path || skillPath.startsWith(`${focus.path}/`)
  )) {
    throw gitUpdateError(
      'source-validation',
      `Git source focus contains no scanner-visible skill: ${focus.path}`
    );
  }
}

function gitUpdateError(category, message, exitCode = 1) {
  return new SourceAcquisitionError(category, message, exitCode);
}
