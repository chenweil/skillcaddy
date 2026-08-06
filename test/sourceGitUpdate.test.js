import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  applyRepairSource,
  applyUpdateSource,
  inspectSource,
  planAddSource,
  planBreakingRepairSource,
  planBreakingUpdateSource,
  planRepairSource,
  planUpdateSource,
  updateGitSources
} from '../lib/sourceManager.js';
import { publishStagedSourceRecord } from '../lib/sourceRegistry.js';
import { runSourceCli } from '../scripts/source.js';
import { makeTempDir } from './testHelpers.js';

const execFile = promisify(execFileCallback);

test('fast-forwards a registered Git source and reports a subsequent no-op', async () => {
  const fixture = await createGitFixture('fast-forward');
  const root = await makeTempDir('source-git-update-root-');
  const project = await makeTempDir('source-git-update-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    await symlinkEnabledSkill(root, project, fixture.repository, 'review');
    const nextCommit = await commitAndPush(fixture, {
      'README.md': 'updated\n',
      'skills/review/SKILL.md': skillDocument('Review updated code')
    });

    const plan = await planUpdateSource(
      { rootDir: root, projectPath: project },
      { sourceId: fixture.sourceId }
    );
    assert.equal(plan.status, 'ready');
    assert.equal(plan.currentCommit, fixture.initialCommit);
    assert.equal(plan.incomingCommit, nextCommit);
    assert.deepEqual(plan.changes, {
      unchanged: ['skills/review'],
      added: [],
      removedOrRelocated: []
    });

    const result = await applyUpdateSource({ rootDir: root, projectPath: project }, plan);
    assert.equal(result.status, 'updated');
    assert.equal(result.commit, nextCommit);

    const currentPlan = await planUpdateSource(
      { rootDir: root, projectPath: project },
      { sourceId: fixture.sourceId }
    );
    assert.deepEqual(
      currentPlan,
      expectedGitPlan(fixture, 'current', nextCommit, nextCommit)
    );
    assert.deepEqual(
      await applyUpdateSource(
        { rootDir: root, projectPath: project },
        currentPlan
      ),
      expectedGitResult(fixture, 'current', nextCommit)
    );
  });

  assert.equal(
    await readFile(path.join(root, 'github', fixture.repository, 'README.md'), 'utf8'),
    'updated\n'
  );
  assert.equal(
    (await inspectSource({ rootDir: root }, fixture.sourceId)).origin.commit,
    fixture.nextCommit
  );
  assert.equal(
    await readFile(path.join(project, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8'),
    skillDocument('Review updated code')
  );
});

test('adopts a manually fast-forwarded clean Git source into the registry', async () => {
  const fixture = await createGitFixture('repair');
  const root = await makeTempDir('source-git-repair-root-');
  const project = await makeTempDir('source-git-repair-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const checkout = path.join(root, 'github', fixture.repository);
    const nextCommit = await commitAndPush(fixture, {
      'README.md': 'manually pulled\n'
    });
    await execFile('git', ['-C', checkout, 'pull', '--ff-only']);

    const plan = await planRepairSource(
      { rootDir: root, projectPath: project },
      { sourceId: fixture.sourceId }
    );
    assert.equal(plan.status, 'ready');
    assert.equal(plan.registeredCommit, fixture.initialCommit);
    assert.equal(plan.currentCommit, nextCommit);
    assert.deepEqual(plan.changes, {
      unchanged: ['skills/review'],
      added: [],
      removedOrRelocated: []
    });

    const output = captureOutput();
    assert.equal(
      await runSourceCli({
        argv: ['repair', fixture.sourceId, '--yes', '--project', project],
        rootDir: root,
        ...output.streams
      }),
      0
    );
    assert.match(output.stdout(), /Repair plan: ready/);
    assert.match(output.stdout(), /Outcome: repaired/);
    assert.match(output.stdout(), new RegExp(`commit: ${nextCommit}`));
    assert.equal(
      (await inspectSource({ rootDir: root }, fixture.sourceId)).origin.commit,
      nextCommit
    );
    assert.equal(await readHead(checkout), nextCommit);
  });
});

test('blocks Git registry repair when manual pull would remove a current-project link', async () => {
  const fixture = await createGitFixture('repair-breaking');
  const root = await makeTempDir('source-git-repair-breaking-root-');
  const project = await makeTempDir('source-git-repair-breaking-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    await symlinkEnabledSkill(root, project, fixture.repository, 'review');
    const checkout = path.join(root, 'github', fixture.repository);
    await removeSkillAndPush(fixture, 'review', 'replacement');
    await execFile('git', ['-C', checkout, 'pull', '--ff-only']);

    await assert.rejects(
      () => planRepairSource(
        { rootDir: root, projectPath: project },
        { sourceId: fixture.sourceId }
      ),
      (error) => error.category === 'breaking-replacement' &&
        error.affectedProjectLinks[0].alias === 'review'
    );

    const plan = await planBreakingRepairSource(
      { rootDir: root, projectPath: project },
      { sourceId: fixture.sourceId }
    );
    assert.deepEqual(plan.affectedProjectLinks, [
      { alias: 'review', skillPath: 'skills/review' }
    ]);
    const result = await applyRepairSource(
      { rootDir: root, projectPath: project },
      plan
    );
    assert.equal(result.status, 'repaired');
    assert.equal(
      (await inspectSource({ rootDir: root }, fixture.sourceId)).origin.commit,
      fixture.nextCommit
    );
  });
});

test('reports a dirty registered Git source without changing or stashing it', async () => {
  const fixture = await createGitFixture('dirty');
  const root = await makeTempDir('source-git-dirty-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const checkout = path.join(root, 'github', fixture.repository);
    await writeFile(path.join(checkout, 'local.txt'), 'keep me\n');
    await commitAndPush(fixture, { 'README.md': 'remote update\n' });

    const plan = await planUpdateSource(
      { rootDir: root },
      { sourceId: fixture.sourceId }
    );
    assert.deepEqual(
      plan,
      expectedGitPlan(
        fixture,
        'dirty',
        fixture.initialCommit,
        fixture.initialCommit
      )
    );
    assert.deepEqual(
      await applyUpdateSource({ rootDir: root }, plan),
      expectedGitResult(fixture, 'dirty', fixture.initialCommit)
    );
    assert.equal(await readFile(path.join(checkout, 'local.txt'), 'utf8'), 'keep me\n');
    assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'initial\n');
  });
});

test('re-prepares a current Git source before returning its no-op result', async () => {
  const fixture = await createGitFixture('current-reprepare');
  const root = await makeTempDir('source-git-current-reprepare-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const checkout = path.join(root, 'github', fixture.repository);
    const counterPath = path.join(fixture.fixtureRoot, 'upload-count');
    const wrapperPath = path.join(fixture.fixtureRoot, 'upload-pack-wrapper');
    const readmePath = path.join(checkout, 'README.md');
    await writeFile(wrapperPath, [
      '#!/bin/sh',
      `counter_file=${shellQuote(counterPath)}`,
      'count="$(cat "$counter_file" 2>/dev/null || printf 0)"',
      'count=$((count + 1))',
      'printf \'%s\\n\' "$count" > "$counter_file"',
      'git-upload-pack "$@"',
      'upload_status=$?',
      'if [ "$count" -eq 2 ]; then',
      `  printf 'concurrent edit\\n' > ${shellQuote(readmePath)}`,
      'fi',
      'exit "$upload_status"',
      ''
    ].join('\n'));
    await chmod(wrapperPath, 0o755);
    await execFile('git', [
      '-C',
      checkout,
      'config',
      'remote.origin.uploadpack',
      wrapperPath
    ]);

    const plan = await planUpdateSource(
      { rootDir: root },
      { sourceId: fixture.sourceId }
    );
    assert.equal(plan.status, 'current');

    await assert.rejects(
      () => applyUpdateSource({ rootDir: root }, plan),
      (error) => error.category === 'stale-plan' &&
        error.message === 'Git source changed since the update plan'
    );
    assert.equal(await readFile(readmePath, 'utf8'), 'concurrent edit\n');
  });
});

test('rejects a non-fast-forward Git source without changing the worktree', async () => {
  const fixture = await createGitFixture('diverged');
  const root = await makeTempDir('source-git-diverged-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const checkout = path.join(root, 'github', fixture.repository);
    await commitInCheckout(checkout, { 'local-only.md': 'local commit\n' }, 'local commit');
    await commitAndPush(fixture, { 'remote-only.md': 'remote commit\n' });

    await assert.rejects(
      () => planUpdateSource({ rootDir: root }, { sourceId: fixture.sourceId }),
      (error) => {
        assert.equal(error.name, 'SourceAcquisitionError');
        assert.equal(error.category, 'non-fast-forward');
        assert.equal(error.exitCode, 1);
        assert.equal(
          error.message,
          `Git source cannot advance by fast-forward: ${fixture.sourceId}`
        );
        return true;
      }
    );
    assert.equal(await readFile(path.join(checkout, 'local-only.md'), 'utf8'), 'local commit\n');
  });
});

test('fetches and advances the explicit ref recorded for a Git source', async () => {
  const fixture = await createGitFixture('explicit-ref', undefined, 'release/v1');
  const root = await makeTempDir('source-git-explicit-ref-root-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const nextCommit = await commitAndPush(fixture, { 'README.md': 'release update\n' });
    const plan = await planUpdateSource(
      { rootDir: root },
      { sourceId: fixture.sourceId }
    );

    assert.equal(plan.incomingCommit, nextCommit);
    assert.equal(
      (await inspectSource({ rootDir: root }, fixture.sourceId)).origin.ref,
      'release/v1'
    );
    assert.equal((await applyUpdateSource({ rootDir: root }, plan)).status, 'updated');
  });
});

test('blocks a breaking Git update for a known project link until authorized', async () => {
  const fixture = await createGitFixture('breaking');
  const root = await makeTempDir('source-git-breaking-root-');
  const project = await makeTempDir('source-git-breaking-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    await symlinkEnabledSkill(root, project, fixture.repository, 'review');
    await removeSkillAndPush(fixture, 'review', 'replacement');

    await assert.rejects(
      () => planUpdateSource(
        { rootDir: root, projectPath: project },
        { sourceId: fixture.sourceId }
      ),
      (error) => error.category === 'breaking-replacement'
    );

    const plan = await planBreakingUpdateSource(
      { rootDir: root, projectPath: project },
      { sourceId: fixture.sourceId }
    );
    assert.deepEqual(plan.changes.removedOrRelocated, ['skills/review']);
    assert.deepEqual(plan.affectedProjectLinks, [
      { alias: 'review', skillPath: 'skills/review' }
    ]);
    assert.equal(
      (await applyUpdateSource({ rootDir: root, projectPath: project }, plan)).status,
      'updated'
    );
  });
});

test('rejects stale registry skill paths before a Git update can break a link', async () => {
  const fixture = await createGitFixture('stale-skills');
  const root = await makeTempDir('source-git-stale-skills-root-');
  const project = await makeTempDir('source-git-stale-skills-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    await symlinkEnabledSkill(root, project, fixture.repository, 'review');
    const record = await inspectSource({ rootDir: root }, fixture.sourceId);
    const recordPath = path.join(
      root,
      '.skillcaddy',
      'sources',
      'github',
      'fixtures',
      `${fixture.repository}.json`
    );
    await writeFile(recordPath, `${JSON.stringify({ ...record, skills: [] }, null, 2)}\n`);
    await removeSkillAndPush(fixture, 'review', 'replacement');

    await assert.rejects(
      () => planUpdateSource(
        { rootDir: root, projectPath: project },
        { sourceId: fixture.sourceId }
      ),
      (error) => error.category === 'source-collision' &&
        /skills do not match/.test(error.message)
    );
    assert.equal(
      await readFile(
        path.join(root, 'github', fixture.repository, 'skills', 'review', 'SKILL.md'),
        'utf8'
      ),
      skillDocument('Review code')
    );
  });
});

test('incoming validation and registry publication failures preserve Git and registry state', async (t) => {
  await t.test('incoming validation failure', async () => {
    const fixture = await createGitFixture('invalid-incoming');
    const root = await makeTempDir('source-git-invalid-incoming-root-');

    await withGitUrlRewrite(fixture.remoteRoot, async () => {
      await addFixtureSource(root, fixture);
      const before = await inspectSource({ rootDir: root }, fixture.sourceId);
      await execFile('git', ['-C', fixture.worktree, 'rm', '-r', 'skills/review']);
      await commit(fixture.worktree, 'remove every skill');
      await execFile('git', [
        '-C',
        fixture.worktree,
        'push',
        fixture.remote,
        fixture.branch
      ]);

      await assert.rejects(
        () => planUpdateSource({ rootDir: root }, { sourceId: fixture.sourceId }),
        (error) => {
          assert.equal(error.name, 'SourceAcquisitionError');
          assert.equal(error.category, 'source-validation');
          assert.equal(error.exitCode, 1);
          assert.equal(error.message, 'No scanner-visible SKILL.md was found');
          return true;
        }
      );
      assert.equal(
        await readHead(path.join(root, 'github', fixture.repository)),
        fixture.initialCommit
      );
      assert.deepEqual(await inspectSource({ rootDir: root }, fixture.sourceId), before);
    });
  });

  await t.test('registry publication failure', async () => {
    const fixture = await createGitFixture('registry-failure');
    const root = await makeTempDir('source-git-registry-failure-root-');

    await withGitUrlRewrite(fixture.remoteRoot, async () => {
      await addFixtureSource(root, fixture);
      const before = await inspectSource({ rootDir: root }, fixture.sourceId);
      await commitAndPush(fixture, { 'README.md': 'must roll back\n' });
      const plan = await planUpdateSource(
        { rootDir: root },
        { sourceId: fixture.sourceId }
      );

      await assert.rejects(
        () => applyUpdateSource({
          rootDir: root,
          publishRecord: async () => {
            throw new Error('injected registry publication failure');
          }
        }, plan),
        {
          name: 'Error',
          message: 'injected registry publication failure'
        }
      );
      assert.equal(
        await readHead(path.join(root, 'github', fixture.repository)),
        fixture.initialCommit
      );
      assert.equal(
        await readFile(path.join(root, 'github', fixture.repository, 'README.md'), 'utf8'),
        'initial\n'
      );
      assert.deepEqual(await inspectSource({ rootDir: root }, fixture.sourceId), before);
    });
  });

  await t.test('concurrent tracked edit after registry publication', async () => {
    const fixture = await createGitFixture('concurrent-edit');
    const root = await makeTempDir('source-git-concurrent-edit-root-');

    await withGitUrlRewrite(fixture.remoteRoot, async () => {
      await addFixtureSource(root, fixture);
      const checkout = path.join(root, 'github', fixture.repository);
      const before = await inspectSource({ rootDir: root }, fixture.sourceId);
      await commitAndPush(fixture, { 'README.md': 'remote update\n' });
      const plan = await planUpdateSource(
        { rootDir: root },
        { sourceId: fixture.sourceId }
      );

      await assert.rejects(
        () => applyUpdateSource({
          rootDir: root,
          publishRecord: async (stagedRecord) => {
            await publishStagedSourceRecord(stagedRecord);
            await writeFile(path.join(checkout, 'README.md'), 'concurrent local edit\n');
          }
        }, plan),
        (error) => {
          assert.equal(error.name, 'SourceAcquisitionError');
          assert.equal(error.category, 'git-update');
          assert.equal(error.exitCode, 1);
          assert.equal(
            error.message,
            `Could not fast-forward Git source: ${fixture.sourceId}`
          );
          return true;
        }
      );
      assert.equal(await readHead(checkout), fixture.initialCommit);
      assert.equal(
        await readFile(path.join(checkout, 'README.md'), 'utf8'),
        'concurrent local edit\n'
      );
      assert.deepEqual(await inspectSource({ rootDir: root }, fixture.sourceId), before);
    });
  });
});

test('batch Git updates re-prepare current sources through the shared lifecycle', async () => {
  const fixture = await createGitFixture('batch-current-reprepare');
  const root = await makeTempDir('source-git-batch-current-reprepare-root-');
  const project = await makeTempDir('source-git-batch-current-reprepare-project-');

  await withGitUrlRewrite(fixture.remoteRoot, async () => {
    await addFixtureSource(root, fixture);
    const checkout = path.join(root, 'github', fixture.repository);
    const counterPath = path.join(fixture.fixtureRoot, 'batch-upload-count');
    const wrapperPath = path.join(fixture.fixtureRoot, 'batch-upload-pack-wrapper');
    const readmePath = path.join(checkout, 'README.md');
    await writeFile(wrapperPath, [
      '#!/bin/sh',
      `counter_file=${shellQuote(counterPath)}`,
      'count="$(cat "$counter_file" 2>/dev/null || printf 0)"',
      'count=$((count + 1))',
      'printf \'%s\\n\' "$count" > "$counter_file"',
      'git-upload-pack "$@"',
      'upload_status=$?',
      'if [ "$count" -eq 2 ]; then',
      `  printf 'concurrent batch edit\\n' > ${shellQuote(readmePath)}`,
      'fi',
      'exit "$upload_status"',
      ''
    ].join('\n'));
    await chmod(wrapperPath, 0o755);
    await execFile('git', [
      '-C',
      checkout,
      'config',
      'remote.origin.uploadpack',
      wrapperPath
    ]);

    assert.deepEqual(
      await updateGitSources({ rootDir: root, projectPath: project }),
      {
        sources: [{
          sourceId: fixture.sourceId,
          status: 'failed',
          category: 'stale-plan',
          applied: false,
          message: 'Git source changed since the update plan'
        }]
      }
    );
    assert.equal(await readFile(readmePath, 'utf8'), 'concurrent batch edit\n');
  });
});

test('batch Git updates expose stable updated, current, dirty, breaking, and failed outcomes', async () => {
  const root = await makeTempDir('source-git-batch-root-');
  const project = await makeTempDir('source-git-batch-project-');
  const firstFixture = await createGitFixture('batch-updated');
  const fixtures = [
    firstFixture,
    await createGitFixture('batch-current', firstFixture.remoteRoot),
    await createGitFixture('batch-dirty', firstFixture.remoteRoot),
    await createGitFixture('batch-breaking', firstFixture.remoteRoot),
    await createGitFixture('batch-breaking-unlinked', firstFixture.remoteRoot),
    await createGitFixture('batch-failed', firstFixture.remoteRoot)
  ];

  await withGitUrlRewrite(firstFixture.remoteRoot, async () => {
    for (const fixture of fixtures) await addFixtureSource(root, fixture);
    await commitAndPush(fixtures[0], { 'README.md': 'batch updated\n' });
    await writeFile(
      path.join(root, 'github', fixtures[2].repository, 'local.txt'),
      'dirty\n'
    );
    await symlinkEnabledSkill(root, project, fixtures[3].repository, 'review');
    await removeSkillAndPush(fixtures[3], 'review', 'replacement');
    await removeSkillAndPush(fixtures[4], 'review', 'replacement');
    const failedCheckout = path.join(root, 'github', fixtures[5].repository);
    await execFile('git', ['-C', failedCheckout, 'remote', 'set-url', 'origin', 'https://fixtures.invalid/missing.git']);

    const result = await updateGitSources({ rootDir: root, projectPath: project });
    assert.deepEqual(result, {
      sources: [
        {
          sourceId: fixtures[3].sourceId,
          status: 'breaking',
          category: 'breaking-replacement',
          applied: false,
          affected: [{ alias: 'review', skillPath: 'skills/review' }]
        },
        {
          sourceId: fixtures[4].sourceId,
          status: 'breaking',
          category: 'breaking-replacement',
          applied: true
        },
        {
          sourceId: fixtures[2].sourceId,
          status: 'dirty',
          category: 'dirty-worktree',
          applied: false,
          message: 'Local Git changes found; update skipped'
        },
        {
          sourceId: fixtures[5].sourceId,
          status: 'failed',
          category: 'source-collision',
          applied: false,
          message: `Registered Git source origin does not match its source record: ${fixtures[5].sourceId}`
        },
        {
          sourceId: fixtures[1].sourceId,
          status: 'current'
        },
        {
          sourceId: fixtures[0].sourceId,
          status: 'updated'
        }
      ].sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    });
    assert.equal(JSON.stringify(result).includes(root), false);

    const output = captureOutput();
    assert.equal(
      await runSourceCli({
        argv: ['update-git', '--project', project],
        rootDir: root,
        ...output.streams
      }),
      1
    );
    assert.match(output.stdout(), /\[current\] github\/fixtures\/batch-updated/);
    assert.match(output.stdout(), /\[dirty\] github\/fixtures\/batch-dirty/);
    assert.match(
      output.stdout(),
      /\[breaking\] github\/fixtures\/batch-breaking \(blocked\)\n  would break: review\n/
    );
    assert.match(
      output.stdout(),
      /\[current\] github\/fixtures\/batch-breaking-unlinked/
    );
    assert.doesNotMatch(
      output.stdout(),
      /github\/fixtures\/batch-breaking-unlinked\n  would break/
    );
    assert.match(
      output.stdout(),
      /\[failed\] github\/fixtures\/batch-failed \(source-collision\)\n  reason: Registered Git source origin does not match its source record: github\/fixtures\/batch-failed/
    );
    assert.match(
      output.stdout(),
      /\[dirty\] github\/fixtures\/batch-dirty\n  reminder: Local Git changes found; update skipped/
    );
    assert.match(
      output.stdout(),
      /Git source summary: updated=0 current=3 dirty=1 breaking=1 failed=1/
    );
  });
});

test('batch Git updates require an explicit current project path', async () => {
  const root = await makeTempDir('source-git-batch-project-required-root-');

  await assert.rejects(
    () => updateGitSources({ rootDir: root }),
    (error) => error.message === 'Git source updates require context.projectPath'
  );
});

function expectedGitPlan(fixture, status, currentCommit, incomingCommit) {
  return {
    operation: 'update-source',
    status,
    sourceId: fixture.sourceId,
    installPath: `github/${fixture.repository}`,
    input: {
      type: 'git',
      remote: `https://fixtures.invalid/fixtures/${fixture.repository}.git`
    },
    currentCommit,
    incomingCommit,
    skills: ['skills/review'],
    warnings: [],
    changes: {
      unchanged: ['skills/review'],
      added: [],
      removedOrRelocated: []
    },
    affectedProjectLinks: []
  };
}

function expectedGitResult(fixture, status, commit) {
  return {
    status,
    sourceId: fixture.sourceId,
    installPath: `github/${fixture.repository}`,
    commit,
    skills: ['skills/review'],
    warnings: [],
    changes: {
      unchanged: ['skills/review'],
      added: [],
      removedOrRelocated: []
    }
  };
}

async function createGitFixture(name, existingRemoteRoot, branch = 'main') {
  const fixtureRoot = existingRemoteRoot
    ? path.dirname(existingRemoteRoot)
    : await makeTempDir(`source-git-${name}-fixture-`);
  const remoteRoot = existingRemoteRoot || path.join(fixtureRoot, 'remotes');
  const repository = name;
  const sourceId = `github/fixtures/${repository}`;
  const worktree = path.join(fixtureRoot, `worktree-${name}`);
  const remote = path.join(remoteRoot, 'fixtures', `${repository}.git`);

  await mkdir(path.join(worktree, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'initial\n');
  await writeFile(
    path.join(worktree, 'skills', 'review', 'SKILL.md'),
    skillDocument('Review code')
  );
  await execFile('git', ['init', `--initial-branch=${branch}`, worktree]);
  await execFile('git', ['-C', worktree, 'add', '.']);
  await commit(worktree, 'initial');
  const initialCommit = await readHead(worktree);
  await mkdir(path.dirname(remote), { recursive: true });
  await execFile('git', ['clone', '--bare', worktree, remote]);
  await execFile('git', ['-C', remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);

  return {
    fixtureRoot,
    remoteRoot,
    remote,
    repository,
    sourceId,
    worktree,
    branch,
    initialCommit,
    nextCommit: null
  };
}

async function addFixtureSource(root, fixture) {
  const plan = await planAddSource(
    { rootDir: root },
    { input: `https://fixtures.invalid/fixtures/${fixture.repository}.git` }
  );
  await applyAddSource({ rootDir: root }, plan);
}

async function commitAndPush(fixture, files) {
  await writeFiles(fixture.worktree, files);
  await execFile('git', ['-C', fixture.worktree, 'add', '.']);
  await commit(fixture.worktree, 'update');
  fixture.nextCommit = await readHead(fixture.worktree);
  await execFile('git', [
    '-C',
    fixture.worktree,
    'push',
    fixture.remote,
    fixture.branch
  ]);
  return fixture.nextCommit;
}

async function removeSkillAndPush(fixture, removed, added) {
  await execFile('git', ['-C', fixture.worktree, 'rm', '-r', `skills/${removed}`]);
  await mkdir(path.join(fixture.worktree, 'skills', added), { recursive: true });
  await writeFile(
    path.join(fixture.worktree, 'skills', added, 'SKILL.md'),
    skillDocument('Replacement skill')
  );
  await execFile('git', ['-C', fixture.worktree, 'add', '.']);
  await commit(fixture.worktree, 'replace skill');
  fixture.nextCommit = await readHead(fixture.worktree);
  await execFile('git', [
    '-C',
    fixture.worktree,
    'push',
    fixture.remote,
    fixture.branch
  ]);
}

async function commitInCheckout(checkout, files, message) {
  await writeFiles(checkout, files);
  await execFile('git', ['-C', checkout, 'add', '.']);
  await commit(checkout, message);
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

async function writeFiles(directory, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function readHead(directory) {
  return (await execFile('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function symlinkEnabledSkill(root, project, repository, skill) {
  const links = path.join(project, '.agents', 'skills');
  await mkdir(links, { recursive: true });
  await symlink(
    path.join(root, 'github', repository, 'skills', skill),
    path.join(links, skill),
    'dir'
  );
}

async function withGitUrlRewrite(remoteRoot, callback) {
  return withGitUrlRewrites([{ remoteRoot }], callback);
}

async function withGitUrlRewrites(fixtures, callback) {
  const configRoot = await makeTempDir('source-git-update-config-');
  const configPath = path.join(configRoot, 'gitconfig');
  const sections = fixtures.flatMap(({ remoteRoot }) => [
    `[url "${new URL(`file://${remoteRoot.replaceAll(path.sep, '/')}/`)}"]`,
    '\tinsteadOf = https://fixtures.invalid/',
    ''
  ]);
  await writeFile(configPath, sections.join('\n'));

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

function skillDocument(description) {
  return `---\ndescription: ${description}\n---\n# Review\n`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
