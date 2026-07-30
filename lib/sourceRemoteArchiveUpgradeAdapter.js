import { parseRemoteArchiveInput } from './sourceHttp.js';
import {
  inspectRemoteArchive,
  stageRemoteArchive
} from './sourceArchiveWorkspace.js';

export function createRemoteArchiveUpgradeAdapter(context, request) {
  const parsed = parseRemoteArchiveInput(request?.input);

  return {
    async inspect() {
      const candidate = await inspectRemoteArchive(
        context,
        parsed,
        'skillcaddy-archive-update-plan-'
      );
      return projectRemoteArchiveCandidate(parsed, candidate);
    },
    async prepare(stagingRoot) {
      const candidate = await stageRemoteArchive(
        context,
        parsed,
        stagingRoot
      );
      return projectRemoteArchiveCandidate(parsed, candidate);
    }
  };
}

function projectRemoteArchiveCandidate(parsed, candidate) {
  return {
    ...candidate,
    input: {
      type: 'remote-zip',
      display: parsed.display
    },
    origin: {
      kind: parsed.protocol,
      display: parsed.display
    }
  };
}
