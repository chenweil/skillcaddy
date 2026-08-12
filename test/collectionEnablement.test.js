import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCollectionEnablement } from '../lib/collectionEnablement.js';
import { enableSkill, ensureSourceFolders, getState } from '../lib/skillStore.js';
import { updateSkillMetadata } from '../lib/skillMetadata.js';

test('classifies every collection candidate while preserving partial successes', async () => {
  const root = await makeTempDir('collection-enablement-root-');
  const project = await makeTempDir('collection-enablement-project-');
  const existing = await createSkill(root, 'existing');
  const enabled = await createSkill(root, 'enabled');
  const failed = await createSkill(root, 'failed');
  const skipped = await createSkill(root, 'skipped');

  await enableSkill(root, {
    projectPath: project,
    skillPath: existing,
    alias: 'existing'
  });
  await updateSkillMetadata(root, {
    skillPath: skipped,
    autoEnable: false
  });
  await mkdir(path.join(project, '.agents', 'skills', 'failed'), { recursive: true });

  const state = await getState(root, project);
  const result = await executeCollectionEnablement(root, {
    projectPath: project,
    skillIds: state.skills.map((skill) => skill.id)
  });

  assert.deepEqual(result.counts, {
    enabled: 1,
    unchanged: 1,
    skipped: 1,
    failed: 1
  });
  assert.deepEqual(
    result.outcomes.map(({ skillId, status }) => ({ skillId, status })),
    [
      { skillId: 'github/toolbox/skills/existing', status: 'unchanged' },
      { skillId: 'github/toolbox/skills/skipped', status: 'skipped' },
      { skillId: 'github/toolbox/skills/enabled', status: 'enabled' },
      { skillId: 'github/toolbox/skills/failed', status: 'failed' }
    ]
  );
  assert.match(result.outcomes.at(-1).error, /不是软链接/);
  assert.equal(result.refresh.ok, true);

  const nextState = await getState(root, project);
  assert.equal(
    nextState.enabled.some((skill) => skill.alias === 'enabled' && skill.targetPath === enabled),
    true
  );
});

test('refreshes pending setup guidance without executing setup instructions', async () => {
  const root = await makeTempDir('collection-setup-enablement-root-');
  const project = await makeTempDir('collection-setup-enablement-project-');
  const setup = await createSkill(root, 'setup-toolbox');
  await createSkill(root, 'tdd');
  await updateSkillMetadata(root, {
    skillPath: setup,
    autoEnable: false
  });
  await writeSetupContract(root);

  const state = await getState(root, project);
  const result = await executeCollectionEnablement(root, {
    projectPath: project,
    skillIds: ['github/toolbox/skills/tdd']
  });

  assert.deepEqual(result.counts, {
    enabled: 2,
    unchanged: 0,
    skipped: 0,
    failed: 0
  });
  assert.deepEqual(
    result.outcomes.map(({ skillId, status }) => ({ skillId, status })),
    [
      { skillId: 'github/toolbox/skills/setup-toolbox', status: 'enabled' },
      { skillId: 'github/toolbox/skills/tdd', status: 'enabled' }
    ]
  );
  assert.equal(result.refresh.ok, true);
  assert.equal(result.setups[0].status, 'missing');
  assert.equal(result.setups[0].setupSkillEnabled, true);
  assert.equal(result.reminders[0].type, 'collection-setup-required');
  await assert.rejects(() => access(path.join(project, 'docs', 'agents', 'issue-tracker.md')));
  await assert.rejects(() => access(path.join(project, 'docs', 'agents', 'domain.md')));
});

test('enables a collection globally without project setup or Claude synchronization', async () => {
  const root = await makeTempDir('collection-global-root-');
  const project = await makeTempDir('collection-global-project-');
  const globalDir = await makeTempDir('collection-global-dir-');
  const skill = await createSkill(root, 'global-tool');
  const state = await getState(root, project, { globalDir });

  const result = await executeCollectionEnablement(root, {
    scope: 'global',
    globalDir,
    skillIds: [state.skills.find((item) => item.name === 'global-tool').id]
  });

  assert.equal(result.scope, 'global');
  assert.deepEqual(result.counts, {
    enabled: 1,
    unchanged: 0,
    skipped: 0,
    failed: 0
  });
  assert.deepEqual(result.setups, []);
  assert.equal(result.outcomes[0].claudeSync, undefined);
  assert.equal((await getState(root, project, { globalDir })).global[0].targetPath, skill);
  assert.equal((await getState(root, project, { globalDir })).enabled.length, 0);
});

async function createSkill(root, name) {
  await ensureSourceFolders(root);
  const skill = path.join(root, 'github', 'toolbox', 'skills', name);
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    `---\ndescription: ${name}\n---\n# ${name}\n`,
    'utf8'
  );
  return skill;
}

async function writeSetupContract(root) {
  const contractPath = path.join(root, 'collection-metadata', 'github');
  await mkdir(contractPath, { recursive: true });
  await writeFile(
    path.join(contractPath, 'toolbox.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      setup: {
        requirement: 'required',
        scope: 'project',
        mode: 'interactive',
        skillId: 'github/toolbox/skills/setup-toolbox',
        appliesTo: ['github/toolbox/skills/tdd'],
        requiredArtifacts: [
          'docs/agents/issue-tracker.md',
          'docs/agents/domain.md'
        ]
      }
    }, null, 2)}\n`,
    'utf8'
  );
}

async function makeTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}
