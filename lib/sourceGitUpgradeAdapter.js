import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdtemp,
  rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { canonicalGitRepositoryLocation } from './sourceGitUrl.js';
import { SOURCE_INSTALLING_MARKER } from './sourcePolicy.js';
import { sanitizeGitRemote } from './sourceRecord.js';
import { sourcePathExists, validateSourceTree } from './sourceTree.js';
import { validateStagedSource } from './sourceValidation.js';
import { defineSourceUpgradeAdapter } from './sourceUpgradeAdapter.js';

const execFile = promisify(execFileCallback);
const DEFAULT_FETCH_RETRY_DELAYS_MS = Object.freeze([2000, 5000]);

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

export async function inspectGitRegistryRepair(context, record) {
  const { rootDir } = context;
  const destination = path.resolve(rootDir, record.installPath);
  if (!(await sourcePathExists(destination))) {
    throw gitUpgradeError(
      'source-collision',
      `Registered source content is missing: ${record.sourceId}`,
      3
    );
  }
  if (!record.origin.commit) {
    throw gitUpgradeError(
      'unresolved-identity',
      `Git source registry repair requires a registered commit: ${record.sourceId}`,
      3
    );
  }
  if (!record.origin.ref) {
    throw gitUpgradeError(
      'unresolved-identity',
      `Git source registry repair requires a tracked ref: ${record.sourceId}`,
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
    return {
      status: 'dirty',
      currentCommit,
      skills: record.skills,
      warnings: []
    };
  }

  await validateSourceTree(rootDir, destination);
  const validated = await validateStagedSource(destination);
  assertFocusContainsSkill(validated.skills, record.focus);

  if (currentCommit === record.origin.commit) {
    if (JSON.stringify(record.skills) !== JSON.stringify(validated.skills)) {
      throw gitUpgradeError(
        'source-collision',
        `Registered Git source skills do not match its source record: ${record.sourceId}`,
        3
      );
    }
    return {
      status: 'current',
      currentCommit,
      skills: validated.skills,
      warnings: validated.warnings
    };
  }

  await fetchGit(
    context,
    destination,
    ['fetch', '--no-tags', 'origin', `refs/heads/${record.origin.ref}`],
    record.sourceId,
    'Could not fetch Git source for registry repair'
  );
  const remoteCommit = await readGitOutput(
    destination,
    ['rev-parse', 'FETCH_HEAD'],
    record.sourceId
  );
  if (currentCommit !== remoteCommit) {
    throw gitUpgradeError(
      'source-not-synchronized',
      `Git source checkout is not at origin/${record.origin.ref}; run git pull before registry repair: ${record.sourceId}`
    );
  }
  if (!await isAncestor(destination, record.origin.commit, currentCommit, record.sourceId)) {
    throw gitUpgradeError(
      'non-fast-forward',
      `Git source registry cannot adopt a non-fast-forward checkout: ${record.sourceId}`
    );
  }

  return {
    status: 'ready',
    currentCommit,
    skills: validated.skills,
    warnings: validated.warnings
  };
}

async function inspectGitCandidate(context, record) {
  const { rootDir } = context;
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

  const fetchContext = record.origin.commit === currentCommit
    ? context
    : { ...context, gitFetchRetryDelaysMs: [] };
  try {
    await fetchGit(
      fetchContext,
      destination,
      ['fetch', '--no-tags', 'origin', `refs/heads/${record.origin.ref}`],
      record.sourceId,
      'Could not fetch Git source'
    );
  } catch (error) {
    if (record.origin.commit !== currentCommit) {
      assertRecordedCommit(record, currentCommit);
    }
    throw error;
  }
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
  const changedFiles = await readChangedFiles(
    destination,
    currentCommit,
    incomingCommit,
    record.sourceId
  );
  return buildCandidate({
    record,
    status: 'ready',
    currentCommit,
    incomingCommit,
    skills: prepared.incoming.skills,
    warnings: prepared.incoming.warnings,
    skillChanges: classifySkillChanges(
      prepared.current.skills,
      prepared.incoming.skills,
      changedFiles
    )
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
  warnings,
  skillChanges
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
    warnings,
    ...(skillChanges ? { skillChanges } : {})
  };
}

async function readChangedFiles(
  destination,
  currentCommit,
  incomingCommit,
  sourceId
) {
  const result = await execGit(
    destination,
    [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      currentCommit,
      incomingCommit,
      '--'
    ],
    sourceId,
    'Could not summarize Git source changes'
  );
  return result.stdout.split('\0').filter(Boolean);
}

function classifySkillChanges(previousSkills, nextSkills, changedFiles) {
  const previous = new Set(previousSkills);
  const next = new Set(nextSkills);
  const changedSkill = (skillPath) => changedFiles.some((filePath) =>
    skillPath === '.' || filePath === skillPath || filePath.startsWith(`${skillPath}/`)
  );

  return {
    added: nextSkills.filter((skillPath) => !previous.has(skillPath)),
    edited: nextSkills.filter((skillPath) =>
      previous.has(skillPath) && changedSkill(skillPath)
    ),
    deleted: previousSkills.filter((skillPath) => !next.has(skillPath))
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
  } catch (error) {
    throw gitUpgradeError(
      'git-update',
      formatGitFailure(action, sourceId, error)
    );
  }
}

async function fetchGit(context, directory, args, sourceId, action) {
  const retryDelays = fetchRetryDelays(context);
  let attempts = 0;
  let lastError;

  while (attempts <= retryDelays.length) {
    attempts += 1;
    try {
      return await execFile('git', ['-C', directory, ...args]);
    } catch (error) {
      lastError = error;
      if (!isTransientGitFailure(error) || attempts > retryDelays.length) break;
      await wait(retryDelays[attempts - 1]);
    }
  }

  const category = isTransientGitFailure(lastError)
    ? 'git-network'
    : 'git-update';
  throw gitUpgradeError(
    category,
    formatGitFailure(action, sourceId, lastError, attempts)
  );
}

function fetchRetryDelays(context) {
  const configured = context?.gitFetchRetryDelaysMs;
  if (configured === undefined) return DEFAULT_FETCH_RETRY_DELAYS_MS;
  if (
    !Array.isArray(configured) ||
    configured.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new TypeError('gitFetchRetryDelaysMs must contain non-negative numbers');
  }
  return configured;
}

function isTransientGitFailure(error) {
  const detail = rawGitError(error);
  return [
    /could not resolve host/i,
    /temporary failure in name resolution/i,
    /network is unreachable/i,
    /failed to connect/i,
    /connection (?:reset|timed out|refused|closed)/i,
    /operation timed out/i,
    /recv failure|send failure/i,
    /empty reply from server/i,
    /(?:tls|gnutls|ssl).*(?:error|failed|terminated|timed out)/i,
    /http\/2 stream.*(?:closed|reset|cancel)/i,
    /rpc failed/i,
    /unexpected disconnect|remote end hung up|early eof/i,
    /(?:http |requested url returned error: )(?:429|500|502|503|504)/i
  ].some((pattern) => pattern.test(detail));
}

function formatGitFailure(action, sourceId, error, attempts) {
  const detail = safeGitError(error);
  const metadata = [
    detail,
    attempts === undefined ? '' : `attempts=${attempts}`
  ].filter(Boolean).join('; ');
  return `${action}: ${sourceId}${metadata ? ` (${metadata})` : ''}`;
}

function rawGitError(error) {
  if (typeof error?.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return String(error?.message || '');
}

function safeGitError(error) {
  const lines = rawGitError(error)
    .replace(/(?:https?|ssh|git):\/\/[^\s'"]+/gi, '[sanitized Git URL]')
    .replace(/(?:[^\s@'"]+@)?[^\s:/'"]+:[^\s'"]+/g, '[sanitized Git URL]')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = lines.length <= 4
    ? lines
    : [lines[0], ...lines.slice(-3)];
  return selected.join(' | ').slice(0, 600);
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
