import path from 'node:path';
import {
  inspectLocalInput,
  stageLocalInput
} from './sourceLocal.js';

export function createLocalUpgradeAdapter({ archiveLimits }, request) {
  const inputPath = requireUpdateInput(request);

  return {
    inspect: async () => projectCandidate(
      await inspectLocalInput(inputPath, { archiveLimits })
    ),
    prepare: async (workspaceRoot) => projectCandidate(
      await stageLocalInput(inputPath, workspaceRoot, { archiveLimits })
    )
  };
}

function requireUpdateInput(request) {
  if (typeof request?.input !== 'string' || !request.input.trim()) {
    throw new Error('Source update requires request.input');
  }
  return path.resolve(request.input);
}

function projectCandidate(prepared) {
  return {
    ...(prepared.contentRoot ? { contentRoot: prepared.contentRoot } : {}),
    input: {
      type: prepared.type,
      name: prepared.basename
    },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings
  };
}
