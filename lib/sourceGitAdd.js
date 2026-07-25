import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdtemp,
  rename,
  rm,
  rmdir
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  cloneAndInspectGitSource,
  prioritizeFocusedSkills
} from './sourceGitStaging.js';
import {
  canonicalGitRepositoryLocation,
  parseGitSourceRequest
} from './sourceGitUrl.js';
import {
  createSourceRecord,
  readSourceRecords
} from './sourceRegistry.js';
import {
  ensureSourceDirectory,
  sourcePathExists
} from './sourceTree.js';

const execFile = promisify(execFileCallback);
const gitAddPlanRequests = new WeakMap();

export async function planGitSourceAdd({ rootDir }, request) {
  const parsed = parseGitSourceRequest(request);
  const plan = await buildGitSourcePlan(rootDir, parsed);
  gitAddPlanRequests.set(plan, parsed);
  return plan;
}

export async function applyGitSourceAdd({ rootDir }, plan) {
  assertGitAddPlan(plan);
  const parsed = gitAddPlanRequests.get(plan);
  if (!parsed) {
    throw new Error('The add-source plan must be applied by the process that created it');
  }

  const currentPlan = await buildGitSourcePlan(rootDir, parsed);
  assertSamePlannedSource(plan, currentPlan);
  if (currentPlan.status === 'already-installed') {
    return buildAddResult(currentPlan, 'already-installed');
  }

  const githubBucket = await requireSafeDirectory(rootDir, 'github');
  const stagingParent = await requireSafeDirectory(rootDir, '.skillcaddy', 'staging');
  const stagingRoot = await mkdtemp(path.join(stagingParent, 'git-add-'));
  const destination = path.join(githubBucket, path.basename(plan.installPath));
  let installed = false;

  try {
    const prepared = await cloneAndInspectGitSource(stagingRoot, parsed);
    assertPreparedSourceMatchesPlan(prepared, plan);
    await assertGitAddDestinationAvailable(rootDir, plan);
    const currentGithubBucket = await requireSafeDirectory(rootDir, 'github');
    if (currentGithubBucket !== githubBucket) {
      throw sourceSafetyError('Git source bucket changed while applying the add plan');
    }

    await publishPreparedDirectory(prepared.contentRoot, destination);
    installed = true;
    try {
      await createSourceRecord(rootDir, buildGitSourceRecord(plan));
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw collisionError(`Source identity was registered while applying: ${plan.sourceId}`);
      }
      throw error;
    }
    return buildAddResult(plan, 'added');
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await removeEmptyDirectory(stagingParent);
  }
}

async function buildGitSourcePlan(rootDir, parsed) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'skillcaddy-git-plan-'));
  try {
    const prepared = await cloneAndInspectGitSource(stagingRoot, parsed);
    const identity = await resolveGitIdentity(rootDir, parsed);
    const plan = {
      operation: 'add-source',
      status: 'ready',
      sourceId: identity.sourceId,
      installPath: identity.installPath,
      input: {
        type: 'git',
        remote: parsed.displayRemote
      },
      origin: {
        kind: 'git',
        remote: parsed.displayRemote,
        ref: prepared.ref,
        commit: prepared.commit
      },
      ...(prepared.focus ? { focus: prepared.focus } : {}),
      skills: prioritizeFocusedSkills(prepared.skills, prepared.focus),
      warnings: prepared.warnings
    };
    plan.status = await resolveGitAddStatus(rootDir, plan);
    return plan;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function resolveGitIdentity(rootDir, parsed) {
  const records = await readSourceRecords(rootDir);
  const sameIdentity = records.find((record) => record.sourceId === parsed.sourceId);
  if (sameIdentity) {
    return {
      sourceId: parsed.sourceId,
      installPath: sameIdentity.installPath
    };
  }

  const defaultPath = `github/${parsed.repository}`;
  if (await installPathAvailable(rootDir, records, defaultPath)) {
    return { sourceId: parsed.sourceId, installPath: defaultPath };
  }

  const namespacedPath = `github/${parsed.owner}--${parsed.repository}`;
  if (await installPathAvailable(rootDir, records, namespacedPath)) {
    return { sourceId: parsed.sourceId, installPath: namespacedPath };
  }
  throw collisionError(
    `Source destination collision: ${namespacedPath}. The repository owner namespace is already in use.`
  );
}

async function resolveGitAddStatus(rootDir, plan) {
  const records = await readSourceRecords(rootDir);
  const sameIdentity = records.find((record) => record.sourceId === plan.sourceId);
  if (!sameIdentity) return 'ready';
  if (
    sameIdentity.type !== 'git' ||
    sameIdentity.installPath !== plan.installPath ||
    canonicalGitRepositoryLocation(sameIdentity.origin.remote) !==
      canonicalGitRepositoryLocation(plan.origin.remote) ||
    sameIdentity.origin.ref !== plan.origin.ref ||
    sameIdentity.origin.commit !== plan.origin.commit ||
    JSON.stringify(sameIdentity.focus) !== JSON.stringify(plan.focus) ||
    JSON.stringify(sameIdentity.skills) !== JSON.stringify(plan.skills)
  ) {
    throw collisionError(
      `Source identity already exists with different content: ${plan.sourceId}. Use source update.`
    );
  }

  const destination = path.join(rootDir, ...sameIdentity.installPath.split('/'));
  if (!(await sourcePathExists(destination))) {
    throw collisionError(`Registered source content is missing: ${plan.sourceId}`);
  }
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    execFile('git', ['-C', destination, 'rev-parse', 'HEAD']),
    execFile('git', ['-C', destination, 'status', '--porcelain'])
  ]);
  if (commitOutput.trim() !== plan.origin.commit || statusOutput.trim()) {
    throw collisionError(`Registered Git source content has changed: ${plan.sourceId}`);
  }
  return 'already-installed';
}

async function publishPreparedDirectory(preparedRoot, destination) {
  const namedPreparedRoot = path.join(
    path.dirname(preparedRoot),
    path.basename(destination)
  );
  await rename(preparedRoot, namedPreparedRoot);
  try {
    await execFile('mv', ['-n', '--', namedPreparedRoot, path.dirname(destination)]);
  } catch (error) {
    throw sourceSafetyError(`Could not publish Git source: ${error.message}`);
  }
  if (await sourcePathExists(namedPreparedRoot)) {
    throw collisionError(`Source destination was occupied while applying: ${destination}`);
  }
}

async function assertGitAddDestinationAvailable(rootDir, plan) {
  if (await resolveGitAddStatus(rootDir, plan) !== 'ready') {
    throw collisionError(`Source was installed while applying: ${plan.sourceId}`);
  }
  const records = await readSourceRecords(rootDir);
  if (!(await installPathAvailable(rootDir, records, plan.installPath))) {
    throw collisionError(`Source destination was occupied while applying: ${plan.installPath}`);
  }
}

async function installPathAvailable(rootDir, records, installPath) {
  return !records.some((record) => record.installPath === installPath) &&
    !await sourcePathExists(path.join(rootDir, ...installPath.split('/')));
}

function buildGitSourceRecord(plan) {
  return {
    schemaVersion: 1,
    sourceId: plan.sourceId,
    bucket: 'github',
    type: 'git',
    installPath: plan.installPath,
    origin: plan.origin,
    ...(plan.focus ? { focus: plan.focus } : {}),
    skills: plan.skills
  };
}

function assertGitAddPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    plan.input?.type !== 'git' ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid Git add-source plan is required');
  }
}

function assertSamePlannedSource(planned, current) {
  const selectFacts = (value) => JSON.stringify({
    sourceId: value.sourceId,
    installPath: value.installPath,
    input: value.input,
    origin: value.origin,
    focus: value.focus,
    skills: value.skills,
    warnings: value.warnings
  });
  if (selectFacts(planned) !== selectFacts(current)) {
    throw new SourceAcquisitionError(
      'stale-plan',
      'Git source changed since the add plan'
    );
  }
}

function assertPreparedSourceMatchesPlan(prepared, plan) {
  const current = {
    ...plan,
    origin: {
      ...plan.origin,
      ref: prepared.ref,
      commit: prepared.commit
    },
    ...(prepared.focus ? { focus: prepared.focus } : {}),
    skills: prioritizeFocusedSkills(prepared.skills, plan.focus),
    warnings: prepared.warnings
  };
  assertSamePlannedSource(plan, current);
}

function buildAddResult(plan, status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    origin: plan.origin,
    ...(plan.focus ? { focus: plan.focus } : {}),
    skills: plan.skills,
    warnings: plan.warnings
  };
}

function collisionError(message) {
  return new SourceAcquisitionError('source-collision', message, 3);
}

function sourceSafetyError(message) {
  return new SourceAcquisitionError('source-safety', message);
}

async function removeEmptyDirectory(directory) {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function requireSafeDirectory(rootDir, ...segments) {
  try {
    return await ensureSourceDirectory(rootDir, ...segments);
  } catch (error) {
    throw sourceSafetyError(error.message);
  }
}
