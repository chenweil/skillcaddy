import path from 'node:path';
import {
  defineSourceAcquisitionAdapter
} from './sourceAcquisitionAdapter.js';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { inspectLocalInput, stageLocalInput } from './sourceLocal.js';
import {
  assertDirectorySourceMatchesRecord,
  sameJson
} from './sourceAcquisitionPolicy.js';
import { validateSourceId } from './sourceRegistry.js';

export function createLocalAcquisitionAdapter({ archiveLimits }, request) {
  const inputPath = requireLocalInput(request);
  const requestIdentity = {
    name: request.name,
    namespace: request.namespace
  };

  return defineSourceAcquisitionAdapter({
    stalePlanMessage: 'Local source content changed since the add plan',
    inspect: async () => buildLocalCandidate(
      await inspectLocalInput(inputPath, { archiveLimits })
    ),
    prepare: async (workspaceRoot) => buildLocalCandidate(
      await stageLocalInput(inputPath, workspaceRoot, { archiveLimits })
    ),
    resolveIdentity(candidate) {
      return resolveLocalIdentity(requestIdentity, candidate.defaultName);
    },
    buildRecord(plan) {
      return {
        schemaVersion: 1,
        sourceId: plan.sourceId,
        bucket: 'personal',
        type: 'local',
        installPath: plan.installPath,
        origin: {
          kind: 'local',
          name: plan.input.name
        },
        integrity: plan.integrity,
        skills: plan.skills
      };
    },
    matchesIdentity(record, plan) {
      return record.type === 'local' &&
        record.installPath === plan.installPath;
    },
    matchesContent(record, plan) {
      return record.integrity?.value === plan.integrity.value &&
        sameJson(record.skills, plan.skills);
    },
    assertInstalled: assertDirectorySourceMatchesRecord
  });
}

function requireLocalInput(request) {
  if (!request || typeof request.input !== 'string' || !request.input.trim()) {
    throw new Error('Source add requires request.input');
  }
  return path.resolve(request.input);
}

function resolveLocalIdentity(request, defaultName) {
  const name = request.name === undefined ? defaultName : request.name;
  const namespace = request.namespace;
  if (typeof name !== 'string' || !name) {
    throw identityError('Local source name must be a non-empty identity segment');
  }
  if (namespace !== undefined && (typeof namespace !== 'string' || !namespace)) {
    throw identityError('Local source namespace must be a non-empty identity segment');
  }

  const sourceId = namespace
    ? `personal/${namespace}/${name}`
    : `personal/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw identityError(
      `Invalid local source identity: ${sourceId}. Use --name and --namespace with safe identity segments.`
    );
  }
  return {
    sourceId,
    installPath: `personal/${namespace ? `${namespace}--` : ''}${name}`
  };
}

function buildLocalCandidate(prepared) {
  return {
    defaultName: prepared.defaultName,
    input: {
      type: prepared.type,
      name: prepared.basename
    },
    integrity: prepared.integrity,
    skills: prepared.skills,
    warnings: prepared.warnings,
    ...(prepared.contentRoot ? { contentRoot: prepared.contentRoot } : {})
  };
}

function identityError(message) {
  return new SourceAcquisitionError('unresolved-identity', message, 3);
}
