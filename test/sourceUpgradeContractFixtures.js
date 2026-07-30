import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { makeTempDir } from './testHelpers.js';
import {
  addSource,
  createLocalInput,
  skillDocument
} from './sourceUpgradeFixtureSupport.js';
import { createGitContract } from './sourceUpgradeGitContractFixture.js';
import { buildZip } from './zipFixtures.js';

export const sourceUpgradeContractCases = [
  {
    name: 'Local input',
    create: createLocalContract
  },
  {
    name: 'Remote Archive',
    create: createArchiveContract
  },
  {
    name: 'Remote file',
    create: createRemoteFileContract
  },
  {
    name: 'Git',
    create: createGitContract
  }
];

export const directoryReplayCases = [
  {
    name: 'Local input',
    create: createLocalReplayContract
  },
  {
    name: 'Remote Archive',
    create: createArchiveReplayContract
  },
  {
    name: 'Remote file',
    create: createRemoteFileContract
  }
];

async function createLocalContract() {
  const root = await makeTempDir('source-upgrade-contract-local-root-');
  const original = await createLocalInput('source-upgrade-contract-local-v1-', {
    'skills/review': skillDocument('Review version one', 'Review'),
    'skills/old': skillDocument('Old skill', 'Old')
  });
  const replacement = await createLocalInput('source-upgrade-contract-local-v2-', {
    'skills/review': skillDocument('Review version two', 'Review'),
    'skills/new': skillDocument('New skill', 'New')
  });
  await addSource(
    root,
    { input: original, name: 'contract-local' }
  );
  const input = {
    type: 'local-directory',
    name: path.basename(replacement)
  };
  const changes = replacementChanges();

  return {
    context: { rootDir: root },
    request: {
      sourceId: 'personal/contract-local',
      input: replacement
    },
    expectedPlan: {
      operation: 'update-source',
      status: 'ready',
      sourceId: 'personal/contract-local',
      installPath: 'personal/contract-local',
      input,
      integrity: normalizedIntegrity(),
      skills: ['skills/new', 'skills/review'],
      warnings: [],
      changes,
      affectedProjectLinks: []
    },
    expectedResult: {
      status: 'updated',
      sourceId: 'personal/contract-local',
      installPath: 'personal/contract-local',
      input,
      integrity: normalizedIntegrity(),
      skills: ['skills/new', 'skills/review'],
      warnings: [],
      changes
    },
    installedSkill: path.join(
      root,
      'personal',
      'contract-local',
      'skills',
      'review',
      'SKILL.md'
    ),
    installedContent: skillDocument('Review version two', 'Review'),
    copiedPlanError:
      'The update-source plan must be applied by the process that created it',
    changeCandidate: () => writeFile(
      path.join(replacement, 'skills', 'review', 'SKILL.md'),
      skillDocument('Review version three', 'Review')
    ),
    staleError: {
      category: 'stale-plan',
      exitCode: 1,
      message: 'Local source or replacement content changed since the update plan'
    }
  };
}

async function createArchiveContract(t) {
  const original = buildZip([
    {
      name: 'skills/review/SKILL.md',
      content: skillDocument('Review version one', 'Review')
    },
    {
      name: 'skills/old/SKILL.md',
      content: skillDocument('Old skill', 'Old')
    }
  ]);
  let replacement = buildZip([
    {
      name: 'skills/review/SKILL.md',
      content: skillDocument('Review version two', 'Review')
    },
    {
      name: 'skills/new/SKILL.md',
      content: skillDocument('New skill', 'New')
    }
  ]);
  const server = await startHttpFixture(t, (request, response) => {
    response.end(request.url === '/original.zip' ? original : replacement);
  });
  const root = await makeTempDir('source-upgrade-contract-archive-root-');
  const originalUrl = `http://127.0.0.1:${server.port}/original.zip`;
  const replacementUrl = `http://127.0.0.1:${server.port}/replacement.zip`;
  await addSource(
    root,
    { input: originalUrl, name: 'contract-archive' }
  );
  const input = {
    type: 'remote-zip',
    display: replacementUrl
  };
  const origin = {
    kind: 'http',
    display: replacementUrl
  };
  const changes = replacementChanges();

  return {
    context: { rootDir: root },
    request: {
      sourceId: 'official/contract-archive',
      input: replacementUrl
    },
    expectedPlan: {
      operation: 'update-source',
      status: 'ready',
      sourceId: 'official/contract-archive',
      installPath: 'official/contract-archive',
      input,
      origin,
      integrity: normalizedIntegrity(),
      skills: ['skills/new', 'skills/review'],
      warnings: [],
      changes,
      affectedProjectLinks: []
    },
    expectedResult: {
      status: 'updated',
      sourceId: 'official/contract-archive',
      installPath: 'official/contract-archive',
      input,
      origin,
      integrity: normalizedIntegrity(),
      skills: ['skills/new', 'skills/review'],
      warnings: [],
      changes
    },
    installedSkill: path.join(
      root,
      'official',
      'contract-archive',
      'skills',
      'review',
      'SKILL.md'
    ),
    installedContent: skillDocument('Review version two', 'Review'),
    copiedPlanError:
      'The update-source plan must be applied by the process that created it',
    changeCandidate: () => {
      replacement = buildZip([
        {
          name: 'skills/review/SKILL.md',
          content: skillDocument('Review version three', 'Review')
        },
        {
          name: 'skills/new/SKILL.md',
          content: skillDocument('New skill', 'New')
        }
      ]);
    },
    staleError: {
      category: 'stale-plan',
      exitCode: 1,
      message: 'Remote Archive changed since the update plan'
    }
  };
}

async function createRemoteFileContract(t) {
  let requestCount = 0;
  let content = skillDocument('Remote file version one', 'Remote file');
  const server = await startHttpFixture(t, (_request, response) => {
    requestCount += 1;
    response.end(content);
  });
  const root = await makeTempDir('source-upgrade-contract-remote-file-root-');
  const inputUrl = `http://127.0.0.1:${server.port}/SKILL.md`;
  await addSource(
    root,
    { input: inputUrl, name: 'contract-file' }
  );
  content = skillDocument('Remote file version two', 'Remote file');
  requestCount = 0;
  const input = {
    type: 'remote-file',
    display: inputUrl
  };
  const origin = {
    kind: 'http',
    display: inputUrl
  };
  const changes = unchangedRootSkill();

  return {
    context: { rootDir: root },
    request: { sourceId: 'official/contract-file' },
    expectedPlan: {
      operation: 'update-source',
      status: 'ready',
      sourceId: 'official/contract-file',
      installPath: 'official/contract-file',
      input,
      origin,
      integrity: normalizedIntegrity(),
      skills: ['.'],
      warnings: [],
      changes,
      affectedProjectLinks: []
    },
    expectedResult: {
      status: 'updated',
      sourceId: 'official/contract-file',
      installPath: 'official/contract-file',
      input,
      origin,
      integrity: normalizedIntegrity(),
      skills: ['.'],
      warnings: [],
      changes
    },
    installedSkill: path.join(
      root,
      'official',
      'contract-file',
      'SKILL.md'
    ),
    installedContent: content,
    requestCount: () => requestCount,
    expectedRequestsAfterPlan: 1,
    expectedRequestsAfterApply: 3,
    expectedRequestsAfterReplay: 5,
    copiedPlanError:
      'The update-source plan must be applied by the process that created it',
    changeCandidate: () => {
      content = skillDocument('Remote file version three', 'Remote file');
    },
    staleError: {
      category: 'stale-plan',
      exitCode: 1,
      message: 'Remote SKILL.md changed since the update plan'
    }
  };
}

async function createLocalReplayContract() {
  const root = await makeTempDir('source-upgrade-replay-local-root-');
  const original = await createLocalInput('source-upgrade-replay-local-v1-', {
    'skills/review': skillDocument('Replay version one', 'Review')
  });
  const replacement = await createLocalInput('source-upgrade-replay-local-v2-', {
    'skills/review': skillDocument('Replay version two', 'Review')
  });
  await addSource(root, { input: original, name: 'replay-local' });
  return {
    context: { rootDir: root },
    request: {
      sourceId: 'personal/replay-local',
      input: replacement
    },
    installedSkill: path.join(
      root,
      'personal',
      'replay-local',
      'skills',
      'review',
      'SKILL.md'
    ),
    installedContent: skillDocument('Replay version two', 'Review')
  };
}

async function createArchiveReplayContract(t) {
  const original = buildZip([{
    name: 'skills/review/SKILL.md',
    content: skillDocument('Replay version one', 'Review')
  }]);
  const replacement = buildZip([{
    name: 'skills/review/SKILL.md',
    content: skillDocument('Replay version two', 'Review')
  }]);
  let requestCount = 0;
  const server = await startHttpFixture(t, (request, response) => {
    requestCount += 1;
    response.end(request.url === '/original.zip' ? original : replacement);
  });
  const root = await makeTempDir('source-upgrade-replay-archive-root-');
  const originalUrl = `http://127.0.0.1:${server.port}/original.zip`;
  const replacementUrl = `http://127.0.0.1:${server.port}/replacement.zip`;
  await addSource(root, {
    input: originalUrl,
    name: 'replay-archive'
  });
  requestCount = 0;
  return {
    context: { rootDir: root },
    request: {
      sourceId: 'official/replay-archive',
      input: replacementUrl
    },
    installedSkill: path.join(
      root,
      'official',
      'replay-archive',
      'skills',
      'review',
      'SKILL.md'
    ),
    installedContent: skillDocument('Replay version two', 'Review'),
    requestCount: () => requestCount,
    expectedRequestsAfterReplay: 5
  };
}

function replacementChanges() {
  return {
    unchanged: ['skills/review'],
    added: ['skills/new'],
    removedOrRelocated: ['skills/old']
  };
}

function unchangedRootSkill() {
  return {
    unchanged: ['.'],
    added: [],
    removedOrRelocated: []
  };
}

function normalizedIntegrity() {
  return {
    algorithm: 'sha256',
    value: '<sha256>'
  };
}

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { port: server.address().port };
}
