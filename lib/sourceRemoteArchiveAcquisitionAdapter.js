import { getDomain } from 'tldts';
import {
  defineSourceAcquisitionAdapter
} from './sourceAcquisitionAdapter.js';
import { SourceAcquisitionError, sourceCollisionError } from './sourceAcquisitionError.js';
import {
  assertDirectorySourceMatchesRecord,
  sameJson
} from './sourceAcquisitionPolicy.js';
import {
  inspectRemoteArchive,
  stageRemoteArchive
} from './sourceArchiveWorkspace.js';
import { parseRemoteArchiveRequest } from './sourceHttp.js';
import { validateSourceId } from './sourceRegistry.js';
import { sourceInstallPathAvailable } from './sourceTree.js';

export function createRemoteArchiveAcquisitionAdapter(context, request) {
  const parsed = parseRemoteArchiveRequest(request);

  return defineSourceAcquisitionAdapter({
    stalePlanMessage: 'Remote Archive changed since the add plan',
    inspect: async () => buildRemoteArchiveCandidate(
      parsed,
      await inspectRemoteArchive(
        context,
        parsed,
        'skillcaddy-archive-plan-'
      )
    ),
    prepare: async (workspaceRoot) => buildRemoteArchiveCandidate(
      parsed,
      await stageRemoteArchive(context, parsed, workspaceRoot)
    ),
    resolveIdentity: (_candidate, records) =>
      resolveArchiveIdentity(context.rootDir, records, parsed),
    buildRecord(plan) {
      return {
        schemaVersion: 1,
        sourceId: plan.sourceId,
        bucket: 'official',
        type: 'archive',
        installPath: plan.installPath,
        origin: plan.origin,
        integrity: plan.integrity,
        skills: plan.skills
      };
    },
    matchesIdentity(record, plan) {
      return record.type === 'archive' &&
        record.installPath === plan.installPath;
    },
    matchesContent(record, plan) {
      return record.integrity?.value === plan.integrity.value &&
        sameJson(record.skills, plan.skills);
    },
    assertInstalled: assertDirectorySourceMatchesRecord
  });
}

async function resolveArchiveIdentity(rootDir, records, parsed) {
  if (parsed.namespace) {
    return existingOrAvailableIdentity(
      rootDir,
      records,
      archiveIdentity(parsed.namespace, parsed.name)
    );
  }

  const defaultIdentity = archiveIdentity(null, parsed.name);
  const sameDefault = records.find(
    (record) => record.sourceId === defaultIdentity.sourceId
  );
  if (
    sameDefault?.type === 'archive' &&
    archiveDomain(sameDefault.origin.display) === parsed.registrableDomain
  ) {
    return {
      sourceId: sameDefault.sourceId,
      installPath: sameDefault.installPath
    };
  }
  if (
    !sameDefault &&
    await sourceInstallPathAvailable(rootDir, records, defaultIdentity.installPath)
  ) {
    return defaultIdentity;
  }
  return existingOrAvailableIdentity(
    rootDir,
    records,
    archiveIdentity(parsed.registrableDomain, parsed.name)
  );
}

async function existingOrAvailableIdentity(rootDir, records, identity) {
  const existing = records.find((record) => record.sourceId === identity.sourceId);
  if (existing) {
    return { sourceId: existing.sourceId, installPath: existing.installPath };
  }
  if (await sourceInstallPathAvailable(rootDir, records, identity.installPath)) {
    return identity;
  }
  throw sourceCollisionError(`Source destination collision: ${identity.installPath}`);
}

function archiveIdentity(namespace, name) {
  const sourceId = namespace
    ? `official/${namespace}/${name}`
    : `official/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw new SourceAcquisitionError(
      'unresolved-identity',
      'Remote Archive name and namespace must form a safe source identity',
      3
    );
  }
  return {
    sourceId,
    installPath: `official/${namespace ? `${namespace}--` : ''}${name}`
  };
}

function buildRemoteArchiveCandidate(parsed, candidate) {
  return {
    input: {
      type: 'remote-zip',
      display: parsed.display
    },
    origin: {
      kind: parsed.protocol,
      display: parsed.display
    },
    integrity: candidate.integrity,
    skills: candidate.skills,
    warnings: candidate.warnings,
    ...(candidate.contentRoot ? { contentRoot: candidate.contentRoot } : {})
  };
}

function archiveDomain(display) {
  const hostname = new URL(display).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ||
    hostname.toLowerCase();
}
