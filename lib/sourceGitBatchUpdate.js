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
          true
        ));
      } else {
        sources.push(batchResult(record.sourceId, application.result.status));
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

function batchResult(sourceId, status, category, applied) {
  return {
    sourceId,
    status,
    ...(category ? { category } : {}),
    ...(applied === undefined ? {} : { applied })
  };
}
