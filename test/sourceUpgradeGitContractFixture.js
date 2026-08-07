import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { makeTempDir } from './testHelpers.js';
import {
  addSource,
  skillDocument
} from './sourceUpgradeFixtureSupport.js';

const execFile = promisify(execFileCallback);

export async function createGitContract(t) {
  const fixtureRoot = await makeTempDir('source-upgrade-contract-git-fixture-');
  const remoteRoot = path.join(fixtureRoot, 'remotes');
  const remote = path.join(remoteRoot, 'contracts', 'source-upgrade.git');
  const worktree = path.join(fixtureRoot, 'worktree');
  await mkdir(path.join(worktree, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'version one\n');
  await writeFile(
    path.join(worktree, 'skills', 'review', 'SKILL.md'),
    skillDocument('Git version one', 'Review')
  );
  await execFile('git', ['init', '--initial-branch=main', worktree]);
  await execFile('git', ['-C', worktree, 'add', '.']);
  await commit(worktree, 'initial');
  const initialCommit = await readHead(worktree);
  await mkdir(path.dirname(remote), { recursive: true });
  await execFile('git', ['clone', '--bare', worktree, remote]);
  await execFile('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await installGitUrlRewrite(t, remoteRoot);

  const root = await makeTempDir('source-upgrade-contract-git-root-');
  const remoteUrl = 'https://fixtures.invalid/contracts/source-upgrade.git';
  await addSource(root, { input: remoteUrl });
  await writeFile(path.join(worktree, 'README.md'), 'version two\n');
  await writeFile(
    path.join(worktree, 'skills', 'review', 'SKILL.md'),
    skillDocument('Git version two', 'Review')
  );
  await execFile('git', ['-C', worktree, 'add', '.']);
  await commit(worktree, 'update');
  const incomingCommit = await readHead(worktree);
  await execFile('git', ['-C', worktree, 'push', remote, 'main']);
  const changes = unchangedReviewSkill();

  return {
    context: { rootDir: root },
    request: { sourceId: 'github/contracts/source-upgrade' },
    expectedPlan: {
      operation: 'update-source',
      status: 'ready',
      sourceId: 'github/contracts/source-upgrade',
      installPath: 'github/source-upgrade',
      input: {
        type: 'git',
        remote: remoteUrl
      },
      currentCommit: initialCommit,
      incomingCommit,
      skills: ['skills/review'],
      warnings: [],
      skillChanges: {
        added: [],
        edited: ['skills/review'],
        deleted: []
      },
      changes,
      affectedProjectLinks: []
    },
    expectedResult: {
      status: 'updated',
      sourceId: 'github/contracts/source-upgrade',
      installPath: 'github/source-upgrade',
      commit: incomingCommit,
      skills: ['skills/review'],
      warnings: [],
      skillChanges: {
        added: [],
        edited: ['skills/review'],
        deleted: []
      },
      changes
    },
    installedSkill: path.join(
      root,
      'github',
      'source-upgrade',
      'skills',
      'review',
      'SKILL.md'
    ),
    installedContent: skillDocument('Git version two', 'Review'),
    copiedPlanError:
      'The Git update-source plan must be applied by the process that created it',
    changeCandidate: async () => {
      await writeFile(path.join(worktree, 'README.md'), 'version three\n');
      await writeFile(
        path.join(worktree, 'skills', 'review', 'SKILL.md'),
        skillDocument('Git version three', 'Review')
      );
      await execFile('git', ['-C', worktree, 'add', '.']);
      await commit(worktree, 'update again');
      await execFile('git', ['-C', worktree, 'push', remote, 'main']);
    },
    staleError: {
      category: 'stale-plan',
      exitCode: 1,
      message: 'Git source changed since the update plan'
    }
  };
}

function unchangedReviewSkill() {
  return {
    unchanged: ['skills/review'],
    added: [],
    removedOrRelocated: []
  };
}

async function installGitUrlRewrite(t, remoteRoot) {
  const configRoot = await makeTempDir('source-upgrade-contract-git-config-');
  const configPath = path.join(configRoot, 'gitconfig');
  await writeFile(
    configPath,
    [
      `[url "${pathToFileURL(`${remoteRoot}${path.sep}`).href}"]`,
      '\tinsteadOf = https://fixtures.invalid/',
      ''
    ].join('\n')
  );
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem;
  });
}

async function commit(directory, message) {
  await execFile('git', [
    '-C',
    directory,
    '-c',
    'user.name=Skillcaddy Tests',
    '-c',
    'user.email=tests@skillcaddy.invalid',
    'commit',
    '-m',
    message
  ]);
}

async function readHead(directory) {
  const result = await execFile('git', ['-C', directory, 'rev-parse', 'HEAD']);
  return result.stdout.trim();
}
