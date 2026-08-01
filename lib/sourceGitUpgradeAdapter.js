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
import { sourcePathExists, validateSourceTree } from './sourceTree.js';
import { validateStagedSource } from './sourceValidation.js';
import { defineSourceUpgradeAdapter } from './sourceUpgradeAdapter.js';

const execFile = promisify(execFileCallback);

export function createGitUpgradeAdapter(context, request, record) {
  if (request?.input !== undefined) {
    throw new Error('Git source update does not accept replacement input');
  }
  assertGitSourceRecord(record);

  return defineSourceUpgradeAdapter({
    stalePlanMessage: 'Git source changed since the update plan',
    kind: 'git',
    inspect: () => inspectGitCandidate(context, record),
    prepare: () => inspectGitCandidate(context, record)
  });
}

async function inspectGitCandidate({ rootDir }, record) {
  const destination = path.resolve(rootDir, record.installPath);
  if (!(await sourcePathExists(destination))) {
    throw gitUpgradeError(
      'source-collision',
      `Registered source content is missing: ${record.sourceId}`,
      3
    );
  }

  const currentCommit = await readGitOutput(
    destination,
    ['rev-parse', 'HEAD'],
    record.sourceId
  );
  await assertTrackedRef(destination, record);
  await assertRegisteredRemote(destination, record);

  const status = await readGitOutput(
    destination,
    ['status', '--porcelain'],
    record.sourceId
  );
  if (status) {
    return buildCandidate({
      record,
      status: 'dirty',
      currentCommit,
      incomingCommit: currentCommit,
      skills: record.skills,
      warnings: []
    });
  }

  await execGit(
    destination,
    ['fetch', '--no-tags', 'origin', `refs/heads/${record.origin.ref}`],
    record.sourceId,
    'Could not fetch Git source'
  );
  const incomingCommit = await readGitOutput(
    destination,
    ['rev-parse', 'FETCH_HEAD'],
    record.sourceId
  );
  if (incomingCommit === currentCommit) {
    assertRecordedCommit(record, currentCommit);
    return buildCandidate({
      record,
      status: 'current',
      currentCommit,
      incomingCommit,
      skills: record.skills,
      warnings: []
    });
  }

  if (!await isAncestor(
    destination,
    currentCommit,
    incomingCommit,
    record.sourceId
  )) {
    throw gitUpgradeError(
      'non-fast-forward',
      `Git source cannot advance by fast-forward: ${record.sourceId}`
    );
  }
  assertRecordedCommit(record, currentCommit);

  const prepared = await inspectGitTrees(
    destination,
    currentCommit,
    incomingCommit,
    record
  );
  if (JSON.stringify(prepared.current.skills) !== JSON.stringify(record.skills)) {
    throw gitUpgradeError(
      'source-collision',
      `Registered Git source skills do not match its source record: ${
        record.sourceId
      }`,
      3
    );
  }
  return buildCandidate({
    record,
    status: 'ready',
    currentCommit,
    incomingCommit,
    skills: prepared.incoming.skills,
    warnings: prepared.incoming.warnings
  });
}

async function assertTrackedRef(destination, record) {
  const branch = await readGitOutput(
    destination,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    record.sourceId
  );
  if (branch !== record.origin.ref) {
    throw gitUpgradeError(
      'source-collision',
      `Registered Git source is not on its tracked ref: ${record.sourceId}`,
      3
    );
  }
}

async function assertRegisteredRemote(destination, record) {
  const configuredRemote = sanitizeGitRemote(
    await readGitOutput(
      destination,
      ['config', '--get', 'remote.origin.url'],
      record.sourceId
    )
  );
  if (
    canonicalGitRepositoryLocation(configuredRemote) !==
    canonicalGitRepositoryLocation(record.origin.remote)
  ) {
    throw gitUpgradeError(
      'source-collision',
      `Registered Git source origin does not match its source record: ${
        record.sourceId
      }`,
      3
    );
  }
}

function assertRecordedCommit(record, currentCommit) {
  if (record.origin.commit !== currentCommit) {
    throw gitUpgradeError(
      'source-collision',
      `Registered Git source commit does not match its source record: ${
        record.sourceId
      }`,
      3
    );
  }
}

async function inspectGitTrees(
  destination,
  currentCommit,
  incomingCommit,
  record
) {
  const stagingRoot = await mkdtemp(
    path.join(tmpdir(), 'skillcaddy-git-update-')
  );
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
    throw gitUpgradeError(
      'source-validation',
      `Git source contains reserved publication marker: ${
        SOURCE_INSTALLING_MARKER
      }`
    );
  }
  await validateSourceTree(stagingRoot, contentRoot);
  const validated = await validateStagedSource(contentRoot);
  assertFocusContainsSkill(validated.skills, record.focus);
  return validated;
}

function buildCandidate({
  record,
  status,
  currentCommit,
  incomingCommit,
  skills,
  warnings
}) {
  return {
    status,
    input: {
      type: 'git',
      remote: record.origin.remote
    },
    currentCommit,
    incomingCommit,
    skills,
    warnings
  };
}

function assertGitSourceRecord(record) {
  if (record.type !== 'git') {
    throw gitUpgradeError(
      'unsupported-source',
      `Git update requires a Git source: ${record.sourceId}`
    );
  }
  if (!record.origin.ref || !record.origin.commit) {
    throw gitUpgradeError(
      'unresolved-identity',
      `Git source record requires a tracked ref and commit: ${record.sourceId}`,
      3
    );
  }
}

async function readGitOutput(directory, args, sourceId) {
  const result = await execGit(
    directory,
    args,
    sourceId,
    'Could not inspect Git source'
  );
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
    throw gitUpgradeError(
      'git-update',
      `Could not compare Git source commits: ${sourceId}`
    );
  }
}

async function execGit(directory, args, sourceId, action) {
  try {
    return await execFile('git', ['-C', directory, ...args]);
  } catch {
    throw gitUpgradeError('git-update', `${action}: ${sourceId}`);
  }
}

function assertFocusContainsSkill(skills, focus) {
  if (!focus?.path) return;
  if (!skills.some(
    (skillPath) => skillPath === focus.path ||
      skillPath.startsWith(`${focus.path}/`)
  )) {
    throw gitUpgradeError(
      'source-validation',
      `Git source focus contains no scanner-visible skill: ${focus.path}`
    );
  }
}

function gitUpgradeError(category, message, exitCode = 1) {
  return new SourceAcquisitionError(category, message, exitCode);
}
