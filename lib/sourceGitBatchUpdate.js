import { readSourceRecords } from './sourceRegistry.js';
import {
  applySourceUpgrade,
  planSourceUpgrade
} from './sourceUpgrade.js';

export async function updateRegisteredGitSources(
  context,
  { allowBreaking = false } = {}
) {
  const records = await readSourceRecords(context.rootDir);
  const sources = [];
  const networkFailureLimit = normalizeNetworkFailureLimit(
    context.gitNetworkFailureLimit
  );
  let consecutiveNetworkFailures = 0;

  for (const record of records.filter((candidate) => candidate.type === 'git')) {
    if (consecutiveNetworkFailures >= networkFailureLimit) {
      sources.push(batchResult(
        record.sourceId,
        'failed',
        'git-network-circuit-open',
        false,
        undefined,
        `Skipped after ${networkFailureLimit} consecutive Git network failures`
      ));
      continue;
    }

    try {
      const plan = await planSourceUpgrade(context, {
        request: { sourceId: record.sourceId },
        authorization: {
          kind: allowBreaking ? 'breaking' : 'ordinary'
        }
      });
      const application = await applySourceUpgrade(context, plan);
      if (plan.changes.removedOrRelocated.length > 0) {
        sources.push(batchResult(
          record.sourceId,
          'breaking',
          'breaking-replacement',
          true,
          plan.affectedProjectLinks,
          undefined,
          buildUpdateSummary(plan),
          plan.affectedGlobalLinks,
          plan.affectedHermesLinks
        ));
      } else {
        sources.push(
          application.result.status === 'dirty'
            ? batchResult(
                record.sourceId,
                'dirty',
                'dirty-worktree',
                false,
                undefined,
                'Local Git changes found; update skipped'
              )
            : batchResult(
                record.sourceId,
                application.result.status,
                undefined,
                undefined,
                undefined,
                undefined,
                application.result.status === 'updated'
                  ? buildUpdateSummary(plan)
                  : undefined
              )
        );
      }
      consecutiveNetworkFailures = 0;
    } catch (error) {
      consecutiveNetworkFailures = error.category === 'git-network'
        ? consecutiveNetworkFailures + 1
        : 0;
      if (error.category === 'breaking-replacement') {
        sources.push(batchResult(
          record.sourceId,
          'breaking',
          'breaking-replacement',
          false,
          allowBreaking ? [] : error.affectedProjectLinks,
          undefined,
          undefined,
          allowBreaking ? [] : error.affectedGlobalLinks,
          allowBreaking ? [] : error.affectedHermesLinks
        ));
      } else {
        sources.push(batchResult(
          record.sourceId,
          'failed',
          error.category || 'failure',
          false,
          undefined,
          error.message || 'Git source update failed'
        ));
      }
    }
  }

  return { sources };
}

function normalizeNetworkFailureLimit(value) {
  if (value === undefined) return 3;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('gitNetworkFailureLimit must be a positive integer');
  }
  return value;
}

function batchResult(
  sourceId,
  status,
  category,
  applied,
  affected,
  message,
  updateSummary,
  affectedGlobalLinks,
  affectedHermesLinks
) {
  return {
    sourceId,
    status,
    ...(category ? { category } : {}),
    ...(applied === undefined ? {} : { applied }),
    ...(message ? { message } : {}),
    ...(updateSummary ? { updateSummary } : {}),
    ...(Array.isArray(affected) && affected.length > 0
      ? {
          affected: affected.map((link) => ({
            alias: link.alias,
            skillPath: link.skillPath
          }))
        }
      : {}),
    ...(Array.isArray(affectedGlobalLinks) && affectedGlobalLinks.length > 0
      ? {
          affectedGlobalLinks: affectedGlobalLinks.map((link) => ({
            alias: link.alias,
            skillPath: link.skillPath
          }))
        }
      : {}),
    ...(Array.isArray(affectedHermesLinks) && affectedHermesLinks.length > 0
      ? {
          affectedHermesLinks: affectedHermesLinks.map((link) => ({
            alias: link.alias,
            skillPath: link.skillPath
          }))
        }
      : {})
  };
}

function buildUpdateSummary(plan) {
  if (!plan.skillChanges) return undefined;
  return {
    fromCommit: plan.currentCommit,
    toCommit: plan.incomingCommit,
    skillChanges: plan.skillChanges
  };
}
