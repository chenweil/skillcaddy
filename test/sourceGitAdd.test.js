import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  inspectSource,
  planAddSource
} from '../lib/sourceManager.js';
import { scanSkills } from '../lib/skillStore.js';
import {
  SOURCE_INSTALLING_MARKER,
  SOURCE_INSTALLING_MARKER_CONTENT
} from '../lib/sourcePolicy.js';
import { runSourceCli } from '../scripts/source.js';
import { makeTempDir } from './testHelpers.js';

const execFile = promisify(execFileCallback);

test('acquires a complete HTTPS Git repository without enabling its skills', async () => {
  const fixture = await createGitFixture('acme', 'team-skills');
  const root = await makeTempDir('source-git-add-root-');
  const project = await makeTempDir('source-git-add-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    const plan = await planAddSource(
      { rootDir: root, projectPath: project },
      { input: 'https://token:secret@fixtures.invalid/acme/team-skills.git?token=hidden#fragment' }
    );

    assert.deepEqual(
      {
        status: plan.status,
        sourceId: plan.sourceId,
        installPath: plan.installPath,
        input: plan.input,
        origin: plan.origin,
        skills: plan.skills
      },
      {
        status: 'ready',
        sourceId: 'github/acme/team-skills',
        installPath: 'github/team-skills',
        input: {
          type: 'git',
          remote: 'https://fixtures.invalid/acme/team-skills.git'
        },
        origin: {
          kind: 'git',
          remote: 'https://fixtures.invalid/acme/team-skills.git',
          ref: 'main',
          commit: fixture.mainCommit
        },
        skills: ['skills/review']
      }
    );

    const result = await applyAddSource(
      { rootDir: root, projectPath: project },
      plan
    );
    assert.equal(result.status, 'added');
  });

  assert.equal(
    await readFile(path.join(root, 'github', 'team-skills', 'README.md'), 'utf8'),
    'complete repository\n'
  );
  await access(path.join(root, 'github', 'team-skills', '.git', 'HEAD'));
  assert.deepEqual(
    (await scanSkills(root)).map((skill) => skill.id),
    ['github/team-skills/skills/review']
  );
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );

  const record = await inspectSource({ rootDir: root }, 'github/acme/team-skills');
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('hidden'), false);
  assert.deepEqual(record.origin, {
    kind: 'git',
    remote: 'https://fixtures.invalid/acme/team-skills.git',
    ref: 'main',
    commit: fixture.mainCommit
  });
});

test('normalizes a GitHub tree URL and retains its branch and subdirectory focus', async () => {
  const fixture = await createGitFixture('example', 'skills');
  const root = await makeTempDir('source-github-tree-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    const plan = await planAddSource(
      { rootDir: root },
      { input: 'https://github.com/example/skills/tree/feature/monitoring/skills/monitoring' }
    );

    assert.equal(plan.input.remote, 'https://github.com/example/skills.git');
    assert.deepEqual(plan.focus, {
      ref: 'feature/monitoring',
      path: 'skills/monitoring'
    });
    assert.equal(plan.origin.ref, 'feature/monitoring');
    assert.equal(plan.origin.commit, fixture.monitoringCommit);
    assert.deepEqual(plan.skills, ['skills/monitoring', 'skills/review']);

    await applyAddSource({ rootDir: root }, plan);
    await assert.rejects(
      () => planAddSource(
        { rootDir: root },
        { input: 'https://github.com/example/skills/tree/monitoring' }
      ),
      (error) => error.category === 'source-collision'
    );
  });

  const record = await inspectSource({ rootDir: root }, 'github/example/skills');
  assert.deepEqual(record.focus, {
    ref: 'feature/monitoring',
    path: 'skills/monitoring'
  });
  assert.equal(
    await readFile(path.join(root, 'github', 'skills', 'branch.txt'), 'utf8'),
    'monitoring branch\n'
  );
});

test('acquires SSH Git URLs and resolves destination collisions with the owner namespace', async () => {
  const first = await createGitFixture('first-owner', 'shared');
  const second = await createGitFixture('second-owner', 'shared', first.remoteRoot);
  const root = await makeTempDir('source-git-collision-root-');

  await withGitUrlRewrite(first.remoteRoot, async () => {
    const firstPlan = await planAddSource(
      { rootDir: root },
      { input: 'https://fixtures.invalid/first-owner/shared.git' }
    );
    await applyAddSource({ rootDir: root }, firstPlan);

    const repeated = await planAddSource(
      { rootDir: root },
      { input: 'ssh://git@fixtures.invalid/first-owner/shared' }
    );
    assert.equal(repeated.status, 'already-installed');
    assert.equal(
      (await applyAddSource({ rootDir: root }, repeated)).status,
      'already-installed'
    );

    const secondPlan = await planAddSource(
      { rootDir: root },
      { input: 'ssh://git@fixtures.invalid/second-owner/shared.git' }
    );
    assert.equal(secondPlan.sourceId, 'github/second-owner/shared');
    assert.equal(secondPlan.installPath, 'github/second-owner--shared');
    assert.equal(secondPlan.input.remote, 'ssh://fixtures.invalid/second-owner/shared.git');
    await applyAddSource({ rootDir: root }, secondPlan);
  });

  assert.equal(
    await readFile(path.join(root, 'github', 'shared', 'owner.txt'), 'utf8'),
    'first-owner\n'
  );
  assert.equal(
    await readFile(path.join(root, 'github', 'second-owner--shared', 'owner.txt'), 'utf8'),
    'second-owner\n'
  );
});

test('declining a Git add plan leaves the library unchanged', async () => {
  const fixture = await createGitFixture('preview-owner', 'preview-skills');
  const root = await makeTempDir('source-git-preview-root-');
  const output = captureOutput();

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    assert.equal(
      await runSourceCli({
        argv: ['add', 'https://fixtures.invalid/preview-owner/preview-skills.git'],
        rootDir: root,
        confirm: async () => false,
        ...output.streams
      }),
      0
    );
  });

  assert.match(output.stdout(), /Outcome: cancelled/);
  assert.deepEqual(await readdir(root), []);
});

test('state scanning hides a Git source until publication is complete', async () => {
  const root = await makeTempDir('source-git-publication-root-');
  const source = path.join(root, 'github', 'publishing');
  await mkdir(path.join(source, 'skills', 'review'), { recursive: true });
  await writeFile(
    path.join(source, 'skills', 'review', 'SKILL.md'),
    '---\ndescription: Review code\n---\n'
  );
  const marker = path.join(source, SOURCE_INSTALLING_MARKER);
  await writeFile(marker, SOURCE_INSTALLING_MARKER_CONTENT);

  assert.deepEqual(await scanSkills(root), []);
  await rm(marker);
  assert.deepEqual(
    (await scanSkills(root)).map((skill) => skill.id),
    ['github/publishing/skills/review']
  );
});

test('refuses changed Git content under an existing source identity', async () => {
  const fixture = await createGitFixture('changing-owner', 'changing-skills');
  const root = await makeTempDir('source-git-changed-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    const request = {
      input: 'https://fixtures.invalid/changing-owner/changing-skills.git'
    };
    const plan = await planAddSource({ rootDir: root }, request);
    await applyAddSource({ rootDir: root }, plan);
    await advanceMainBranch(fixture);

    await assert.rejects(
      () => planAddSource({ rootDir: root }, request),
      (error) => error.category === 'source-collision' &&
        /Use source update/.test(error.message)
    );
  });

  assert.equal(
    await readFile(path.join(root, 'github', 'changing-skills', 'README.md'), 'utf8'),
    'complete repository\n'
  );
});

test('source CLI displays sanitized Git facts and applies with --yes', async () => {
  const fixture = await createGitFixture('cli-owner', 'cli-skills');
  const root = await makeTempDir('source-git-cli-root-');
  const output = captureOutput();

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    assert.equal(
      await runSourceCli({
        argv: [
          'add',
          'https://user:password@fixtures.invalid/cli-owner/cli-skills.git?token=hidden',
          '--yes'
        ],
        rootDir: root,
        ...output.streams
      }),
      0
    );
  });

  assert.match(output.stdout(), /input: git https:\/\/fixtures\.invalid\/cli-owner\/cli-skills\.git/);
  assert.match(output.stdout(), /origin: git https:\/\/fixtures\.invalid\/cli-owner\/cli-skills\.git main @ [a-f0-9]{40}/);
  assert.match(output.stdout(), /Outcome: added/);
  assert.equal(output.stdout().includes('password'), false);
  assert.equal(output.stdout().includes('hidden'), false);
});

async function createGitFixture(owner, repository, existingRemoteRoot) {
  const fixtureRoot = existingRemoteRoot
    ? path.dirname(existingRemoteRoot)
    : await makeTempDir('source-git-fixture-');
  const remoteRoot = existingRemoteRoot || path.join(fixtureRoot, 'remotes');
  const worktree = path.join(fixtureRoot, `work-${owner}-${repository}`);
  const remote = path.join(remoteRoot, owner, `${repository}.git`);

  await mkdir(path.join(worktree, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'complete repository\n');
  await writeFile(path.join(worktree, 'owner.txt'), `${owner}\n`);
  await writeFile(
    path.join(worktree, 'skills', 'review', 'SKILL.md'),
    '---\ndescription: Review code\n---\n# Review\n'
  );
  await execFile('git', ['init', '--initial-branch=main', worktree]);
  await execFile('git', ['-C', worktree, 'add', '.']);
  await execFile('git', [
    '-C',
    worktree,
    '-c',
    'user.name=Skillcaddy Tests',
    '-c',
    'user.email=tests@skillcaddy.invalid',
    'commit',
    '-m',
    'initial'
  ]);
  const { stdout: mainCommitOutput } = await execFile('git', ['-C', worktree, 'rev-parse', 'HEAD']);

  await execFile('git', ['-C', worktree, 'checkout', '-b', 'monitoring']);
  await mkdir(path.join(worktree, 'skills', 'monitoring'), { recursive: true });
  await writeFile(path.join(worktree, 'branch.txt'), 'monitoring branch\n');
  await writeFile(
    path.join(worktree, 'skills', 'monitoring', 'SKILL.md'),
    '---\ndescription: Monitor services\n---\n# Monitoring\n'
  );
  await execFile('git', ['-C', worktree, 'add', '.']);
  await execFile('git', [
    '-C',
    worktree,
    '-c',
    'user.name=Skillcaddy Tests',
    '-c',
    'user.email=tests@skillcaddy.invalid',
    'commit',
    '-m',
    'add monitoring branch'
  ]);
  const { stdout: monitoringCommitOutput } = await execFile('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  await execFile('git', ['-C', worktree, 'branch', 'feature/monitoring']);
  await execFile('git', ['-C', worktree, 'checkout', 'main']);

  await mkdir(path.dirname(remote), { recursive: true });
  await execFile('git', ['clone', '--bare', worktree, remote]);
  await execFile('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  return {
    remoteRoot,
    remote,
    worktree,
    mainCommit: mainCommitOutput.trim(),
    monitoringCommit: monitoringCommitOutput.trim()
  };
}

async function advanceMainBranch(fixture) {
  await writeFile(path.join(fixture.worktree, 'README.md'), 'changed repository\n');
  await execFile('git', ['-C', fixture.worktree, 'add', 'README.md']);
  await execFile('git', [
    '-C',
    fixture.worktree,
    '-c',
    'user.name=Skillcaddy Tests',
    '-c',
    'user.email=tests@skillcaddy.invalid',
    'commit',
    '-m',
    'change main'
  ]);
  await execFile('git', [
    '-C',
    fixture.worktree,
    'push',
    fixture.remote,
    'main'
  ]);
}

async function withGitUrlRewrite(remoteRoot, callback) {
  const configRoot = await makeTempDir('source-git-config-');
  const configPath = path.join(configRoot, 'gitconfig');
  const fileBase = new URL(`file://${remoteRoot.replaceAll(path.sep, '/')}/`).toString();
  await writeFile(configPath, [
    `[url "${fileBase}"]`,
    '\tinsteadOf = https://fixtures.invalid/',
    '\tinsteadOf = ssh://git@fixtures.invalid/',
    '\tinsteadOf = ssh://fixtures.invalid/',
    '\tinsteadOf = https://github.com/',
    ''
  ].join('\n'));

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return await callback();
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem;
  }
}

function captureOutput() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    streams: {
      stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) }
    },
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join('')
  };
}
