import {
  readFile,
  rename as fsRename,
  rm as fsRm
} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  applyUpdateSource,
  inspectSource,
  planAddSource,
  planBreakingUpdateSource,
  planUpdateSource
} from '../lib/sourceManager.js';
import {
  directoryReplayCases,
  sourceUpgradeContractCases
} from './sourceUpgradeContractFixtures.js';
import {
  createInstalledLocalSource,
  createLocalInput,
  enableSkillLink,
  skillDocument
} from './sourceUpgradeFixtureSupport.js';
import { makeTempDir } from './testHelpers.js';

for (const contract of sourceUpgradeContractCases) {
  test(`${contract.name} Source upgrade preserves its public contract`, async (t) => {
    const fixture = await contract.create(t);
    const plan = await planUpdateSource(fixture.context, fixture.request);

    assert.deepEqual(normalizeIntegrity(plan), fixture.expectedPlan);
    if (fixture.requestCount) {
      assert.equal(
        fixture.requestCount(),
        fixture.expectedRequestsAfterPlan
      );
    }
    if (fixture.copiedPlanError) {
      await assert.rejects(
        () => applyUpdateSource(fixture.context, structuredClone(plan)),
        {
          name: 'Error',
          message: fixture.copiedPlanError
        }
      );
    }

    const firstResult = await applyUpdateSource(fixture.context, plan);

    assert.deepEqual(
      normalizeIntegrity(firstResult),
      fixture.expectedResult
    );
    if (fixture.requestCount) {
      assert.equal(
        fixture.requestCount(),
        fixture.expectedRequestsAfterApply
      );
    }
    assert.equal(
      await readFile(fixture.installedSkill, 'utf8'),
      fixture.installedContent
    );
  });
}

for (const contract of sourceUpgradeContractCases) {
  test(`${contract.name} Source upgrade re-plans before apply`, async (t) => {
    const fixture = await contract.create(t);
    const plan = await planUpdateSource(fixture.context, fixture.request);
    await fixture.changeCandidate();

    await assert.rejects(
      () => applyUpdateSource(fixture.context, plan),
      (error) => {
        assert.equal(error.name, 'SourceAcquisitionError');
        assert.equal(error.category, fixture.staleError.category);
        assert.equal(error.exitCode, fixture.staleError.exitCode);
        assert.equal(error.message, fixture.staleError.message);
        return true;
      }
    );
  });
}

for (const contract of directoryReplayCases) {
  test(`${contract.name} directory replacement plan is replayable`, async (t) => {
    const fixture = await contract.create(t);
    const plan = await planUpdateSource(fixture.context, fixture.request);
    const firstResult = await applyUpdateSource(fixture.context, plan);
    const secondResult = await applyUpdateSource(fixture.context, plan);

    assert.equal(firstResult.status, 'updated');
    assert.deepEqual(secondResult, firstResult);
    if (fixture.requestCount) {
      assert.equal(
        fixture.requestCount(),
        fixture.expectedRequestsAfterReplay
      );
    }
    assert.equal(
      await readFile(fixture.installedSkill, 'utf8'),
      fixture.installedContent
    );
  });
}

test('Breaking source replacement protection is limited to the current project', async () => {
  const root = await makeTempDir('source-upgrade-contract-links-root-');
  const original = await createLocalInput('source-upgrade-contract-links-v1-', {
    'skills/kept': skillDocument('Kept skill', 'Kept'),
    'skills/removed': skillDocument('Removed skill', 'Removed')
  });
  const replacement = await createLocalInput('source-upgrade-contract-links-v2-', {
    'skills/kept': skillDocument('Updated kept skill', 'Kept')
  });
  const addPlan = await planAddSource(
    { rootDir: root },
    { input: original, name: 'contract-links' }
  );
  await applyAddSource({ rootDir: root }, addPlan);
  const currentProject = await makeTempDir(
    'source-upgrade-contract-current-project-'
  );
  const otherProject = await makeTempDir(
    'source-upgrade-contract-other-project-'
  );
  await enableSkillLink({
    root,
    project: otherProject,
    installPath: addPlan.installPath,
    skillPath: 'skills/removed',
    alias: 'other-project-link'
  });
  const request = {
    sourceId: 'personal/contract-links',
    input: replacement
  };

  const unaffectedPlan = await planUpdateSource(
    { rootDir: root, projectPath: currentProject },
    request
  );
  assert.deepEqual(unaffectedPlan.affectedProjectLinks, []);

  await enableSkillLink({
    root,
    project: currentProject,
    installPath: addPlan.installPath,
    skillPath: 'skills/removed',
    alias: 'current-project-link'
  });
  await assert.rejects(
    () => planUpdateSource(
      { rootDir: root, projectPath: currentProject },
      request
    ),
    (error) => {
      assert.equal(error.name, 'SourceAcquisitionError');
      assert.equal(error.category, 'breaking-replacement');
      assert.equal(error.exitCode, 4);
      assert.equal(
        error.message,
        'Source replacement would break current-project links: ' +
          'current-project-link. Re-run with --allow-breaking to authorize it.'
      );
      return true;
    }
  );

  const authorizedPlan = await planBreakingUpdateSource(
    { rootDir: root, projectPath: currentProject },
    request
  );
  assert.deepEqual(authorizedPlan.affectedProjectLinks, [{
    alias: 'current-project-link',
    skillPath: 'skills/removed'
  }]);
  assert.equal(
    (
      await applyUpdateSource(
        { rootDir: root, projectPath: currentProject },
        authorizedPlan
      )
    ).status,
    'updated'
  );
});

test('directory replacement preserves its publication failure contract', async (t) => {
  await t.test('pre-commit failure restores active content and Source registry', async () => {
    const fixture = await createInstalledLocalSource(
      'contract-rollback',
      'Rollback version one'
    );
    const replacement = await createLocalInput(
      'source-upgrade-contract-rollback-v2-',
      {
        'skills/review': skillDocument('Rollback version two', 'Review')
      }
    );
    const plan = await planUpdateSource(
      { rootDir: fixture.root },
      { sourceId: fixture.sourceId, input: replacement }
    );
    const beforeRecord = await inspectSource(
      { rootDir: fixture.root },
      fixture.sourceId
    );
    let renameCount = 0;

    await assert.rejects(
      () => applyUpdateSource({
        rootDir: fixture.root,
        fileOperations: {
          rename: async (...args) => {
            renameCount += 1;
            if (renameCount === 2) {
              throw new Error('injected pre-commit publication failure');
            }
            return fsRename(...args);
          },
          rm: fsRm
        }
      }, plan),
      {
        name: 'Error',
        message: 'injected pre-commit publication failure'
      }
    );
    assert.equal(
      await readFile(fixture.installedSkill, 'utf8'),
      skillDocument('Rollback version one', 'Review')
    );
    assert.deepEqual(
      await inspectSource({ rootDir: fixture.root }, fixture.sourceId),
      beforeRecord
    );
  });

  await t.test('post-commit cleanup failure retains new content and Source registry', async () => {
    const fixture = await createInstalledLocalSource(
      'contract-cleanup',
      'Cleanup version one'
    );
    const replacement = await createLocalInput(
      'source-upgrade-contract-cleanup-v2-',
      {
        'skills/review': skillDocument('Cleanup version two', 'Review')
      }
    );
    const plan = await planUpdateSource(
      { rootDir: fixture.root },
      { sourceId: fixture.sourceId, input: replacement }
    );
    let removeCount = 0;

    await assert.rejects(
      () => applyUpdateSource({
        rootDir: fixture.root,
        fileOperations: {
          rename: fsRename,
          rm: async (...args) => {
            removeCount += 1;
            if (removeCount === 2) {
              throw new Error('injected post-commit cleanup failure');
            }
            return fsRm(...args);
          }
        }
      }, plan),
      {
        name: 'Error',
        message: 'injected post-commit cleanup failure'
      }
    );
    assert.equal(
      await readFile(fixture.installedSkill, 'utf8'),
      skillDocument('Cleanup version two', 'Review')
    );
    const record = await inspectSource(
      { rootDir: fixture.root },
      fixture.sourceId
    );
    assert.deepEqual(
      {
        installPath: record.installPath,
        integrity: record.integrity,
        skills: record.skills
      },
      {
        installPath: fixture.installPath,
        integrity: plan.integrity,
        skills: ['skills/review']
      }
    );
  });
});

function normalizeIntegrity(value) {
  if (!value.integrity) return value;
  return {
    ...value,
    integrity: {
      ...value.integrity,
      value: '<sha256>'
    }
  };
}
