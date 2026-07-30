import path from 'node:path';
import {
  commitGitSourceFastForward,
  discardGitSourceFastForward,
  prepareGitSourceFastForward,
  rollbackGitSourceFastForward
} from './sourceGitUpdateTransaction.js';
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
  assertSameSourceUpgradePlan,
  fingerprintSourceUpgradePlan
} from './sourceUpgradePolicy.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';

export async function executeSourceUpgrade(
  context,
  upgrade,
  stalePlanMessage
) {
  if (upgrade.kind === 'git') {
    return executeGitFastForward(context, upgrade, stalePlanMessage);
  }
  return executeDirectoryReplacement(context, upgrade, stalePlanMessage);
}

async function executeDirectoryReplacement(
  context,
  upgrade,
  stalePlanMessage
) {
  const destination = path.resolve(
    context.rootDir,
    upgrade.record.installPath
  );
  await assertActiveSourceMatchesRecord(destination, upgrade.record);
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'update-'
  );

  try {
    const candidate = await upgrade.adapter.prepare(workspace.root);
    assertPreparedCandidateMatchesPlan(
      candidate,
      upgrade.plan,
      stalePlanMessage
    );
    await assertActiveSourceMatchesRecord(destination, upgrade.record);
    const publication = await prepareDirectorySourceReplacement({
      rootDir: context.rootDir,
      destination,
      stagingRoot: workspace.root,
      preparedContentRoot: candidate.contentRoot,
      nextRecord: buildUpdatedSourceRecord(upgrade.record, upgrade.plan),
      fileOperations: context.fileOperations ||
        defaultSourceUpdateFileOperations
    });
    await runDirectoryReplacement(publication);
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function executeGitFastForward(context, upgrade, stalePlanMessage) {
  const candidate = await upgrade.adapter.prepare();
  assertPreparedCandidateMatchesPlan(
    candidate,
    upgrade.plan,
    stalePlanMessage
  );
  if (upgrade.plan.status !== 'ready') return;
  const publication = await prepareGitSourceFastForward({
    rootDir: context.rootDir,
    record: upgrade.record,
    nextRecord: buildUpdatedSourceRecord(upgrade.record, upgrade.plan),
    incomingCommit: upgrade.plan.incomingCommit,
    publishRecord: context.publishRecord
  });
  await runGitFastForward(publication);
}

function assertPreparedCandidateMatchesPlan(
  candidate,
  plan,
  stalePlanMessage
) {
  assertSameSourceUpgradePlan(
    fingerprintSourceUpgradePlan(plan),
    {
      ...plan,
      status: candidate.status || 'ready',
      input: candidate.input,
      ...(candidate.origin ? { origin: candidate.origin } : {}),
      ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
      ...(candidate.currentCommit ? {
        currentCommit: candidate.currentCommit,
        incomingCommit: candidate.incomingCommit
      } : {}),
      skills: candidate.skills,
      warnings: candidate.warnings
    },
    stalePlanMessage
  );
}

function buildUpdatedSourceRecord(record, plan) {
  if (record.type === 'git') {
    return {
      ...record,
      origin: {
        ...record.origin,
        commit: plan.incomingCommit
      },
      skills: plan.skills
    };
  }
  return {
    ...record,
    origin: plan.origin || (
      record.type === 'archive'
        ? record.origin
        : {
            kind: 'local',
            name: plan.input.name
          }
    ),
    integrity: plan.integrity,
    skills: plan.skills
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
      await rollbackBeforeCommit(
        publication,
        error,
        rollbackDirectorySourceReplacement
      );
    }
    throw error;
  } finally {
    await discardDirectorySourceReplacement(publication);
  }
}

async function runGitFastForward(publication) {
  let phase = 'prepared';

  try {
    phase = 'committing';
    await commitGitSourceFastForward(publication);
    phase = 'committed';
    phase = 'cleanup';
  } catch (error) {
    if (phase === 'committing') {
      await rollbackBeforeCommit(
        publication,
        error,
        rollbackGitSourceFastForward
      );
    }
    throw error;
  } finally {
    await discardGitSourceFastForward(publication);
  }
}

async function rollbackBeforeCommit(publication, originalError, rollback) {
  try {
    await rollback(publication);
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source update failed and rollback could not restore the previous source'
    );
  }
}
