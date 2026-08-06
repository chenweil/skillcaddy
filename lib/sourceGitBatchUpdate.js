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

  for (const record of records.filter((candidate) => candidate.type === 'git')) {
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
          plan.affectedProjectLinks
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
            : batchResult(record.sourceId, application.result.status)
        );
      }
    } catch (error) {
      if (error.category === 'breaking-replacement') {
        sources.push(batchResult(
          record.sourceId,
          'breaking',
          'breaking-replacement',
          false,
          allowBreaking ? [] : error.affectedProjectLinks
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

function batchResult(sourceId, status, category, applied, affected, message) {
  return {
    sourceId,
    status,
    ...(category ? { category } : {}),
    ...(applied === undefined ? {} : { applied }),
    ...(message ? { message } : {}),
    ...(Array.isArray(affected) && affected.length > 0
      ? {
          affected: affected.map((link) => ({
            alias: link.alias,
            skillPath: link.skillPath
          }))
        }
      : {})
  };
}
