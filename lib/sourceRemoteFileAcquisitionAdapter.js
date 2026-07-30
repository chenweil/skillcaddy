import {
  defineSourceAcquisitionAdapter
} from './sourceAcquisitionAdapter.js';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  assertDirectorySourceMatchesRecord,
  sameJson
} from './sourceAcquisitionPolicy.js';
import { parseRemoteSkillFileRequest } from './sourceHttp.js';
import {
  inspectRemoteSkillFile,
  stageRemoteSkillFile
} from './sourceRemoteFileWorkspace.js';
import { validateSourceId } from './sourceRegistry.js';

export function createRemoteFileAcquisitionAdapter(context, request) {
  const parsed = parseRemoteSkillFileRequest(request);

  return defineSourceAcquisitionAdapter({
    stalePlanMessage: 'Remote SKILL.md changed since the add plan',
    inspect: async () => buildRemoteFileCandidate(
      parsed,
      await inspectRemoteSkillFile(
        context,
        parsed,
        'skillcaddy-remote-file-plan-'
      )
    ),
    prepare: async (workspaceRoot) => buildRemoteFileCandidate(
      parsed,
      await stageRemoteSkillFile(context, parsed, workspaceRoot)
    ),
    resolveIdentity() {
      return remoteFileIdentity(parsed.name);
    },
    buildRecord(plan) {
      return {
        schemaVersion: 1,
        sourceId: plan.sourceId,
        bucket: 'official',
        type: 'remote-file',
        installPath: plan.installPath,
        origin: plan.origin,
        integrity: plan.integrity,
        skills: plan.skills
      };
    },
    matchesIdentity(record, plan) {
      return record.type === 'remote-file' &&
        record.installPath === plan.installPath &&
        record.origin.display === plan.origin.display;
    },
    matchesContent(record, plan) {
      return record.integrity?.value === plan.integrity.value &&
        sameJson(record.skills, plan.skills);
    },
    assertInstalled: assertDirectorySourceMatchesRecord
  });
}

function remoteFileIdentity(name) {
  if (name.includes('/')) throw remoteFileIdentityError();
  const sourceId = `official/${name}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw remoteFileIdentityError();
  }
  return { sourceId, installPath: sourceId };
}

function remoteFileIdentityError() {
  return new SourceAcquisitionError(
    'unresolved-identity',
    'Remote file name must be a single safe identity segment',
    3
  );
}

function buildRemoteFileCandidate(parsed, candidate) {
  return {
    input: {
      type: 'remote-file',
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
