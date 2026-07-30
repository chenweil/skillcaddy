import { parseRemoteSkillFileInput } from './sourceHttp.js';
import {
  inspectRemoteSkillFile,
  stageRemoteSkillFile
} from './sourceRemoteFileWorkspace.js';

export function createRemoteFileUpgradeAdapter(context, request, record) {
  const parsed = parseRemoteSkillFileInput(
    request?.input ?? record.origin.display
  );

  return {
    async inspect() {
      const candidate = await inspectRemoteSkillFile(
        context,
        parsed,
        'skillcaddy-remote-file-update-plan-'
      );
      return projectRemoteFileCandidate(parsed, candidate);
    },
    async prepare(stagingRoot) {
      const candidate = await stageRemoteSkillFile(
        context,
        parsed,
        stagingRoot
      );
      return projectRemoteFileCandidate(parsed, candidate);
    }
  };
}

function projectRemoteFileCandidate(parsed, candidate) {
  return {
    ...candidate,
    input: {
      type: 'remote-file',
      display: parsed.display
    },
    origin: {
      kind: parsed.protocol,
      display: parsed.display
    }
  };
}
