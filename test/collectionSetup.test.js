import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSourceFolders, getState } from '../lib/skillStore.js';

test('reports missing, partial, and ready setup state from project artifacts', async () => {
  const root = await makeTempDir('setup-root-');
  const project = await makeTempDir('setup-project-');
  const setupSkill = await createSkill(root, 'github/toolbox/skills/engineering', 'setup-toolbox');
  const tddSkill = await createSkill(root, 'github/toolbox/skills/engineering', 'tdd');
  await writeSetupContract(root, 'github', 'toolbox', {
    schemaVersion: 1,
    setup: {
      requirement: 'required',
      scope: 'project',
      mode: 'interactive',
      skillId: 'github/toolbox/skills/engineering/setup-toolbox',
      appliesTo: ['github/toolbox/skills/engineering/*'],
      requiredArtifacts: ['docs/agents/issue-tracker.md', 'docs/agents/domain.md']
    }
  });
  await linkSkill(project, 'tdd', tddSkill);

  let state = await getState(root, project);
  assert.equal(state.setups.length, 1);
  assert.equal(state.setups[0].status, 'missing');
  assert.equal(state.setups[0].setupSkillEnabled, false);
  assert.deepEqual(state.setups[0].affectedEnabledSkillIds, ['github/toolbox/skills/engineering/tdd']);
  assert.equal(state.advice.find((item) => item.type === 'collection-setup-required').setupSkillId, 'github/toolbox/skills/engineering/setup-toolbox');

  await mkdir(path.join(project, 'docs', 'agents'), { recursive: true });
  await writeFile(path.join(project, 'docs', 'agents', 'issue-tracker.md'), '# Tracker\n');
  state = await getState(root, project);
  assert.equal(state.setups[0].status, 'partial');
  assert.deepEqual(state.setups[0].missingArtifacts, ['docs/agents/domain.md']);

  await writeFile(path.join(project, 'docs', 'agents', 'domain.md'), '# Domain\n');
  await linkSkill(project, 'setup-toolbox', setupSkill);
  state = await getState(root, project);
  assert.equal(state.setups[0].status, 'ready');
  assert.equal(state.setups[0].setupSkillEnabled, true);
  assert.equal(state.advice.some((item) => item.type === 'collection-setup-required'), false);
});

test('does not warn until an affected skill is enabled', async () => {
  const root = await makeTempDir('setup-root-');
  const project = await makeTempDir('setup-project-');
  await createSkill(root, 'github/toolbox/skills/engineering', 'setup-toolbox');
  await createSkill(root, 'github/toolbox/skills/engineering', 'tdd');
  await writeSetupContract(root, 'github', 'toolbox', {
    schemaVersion: 1,
    setup: {
      requirement: 'recommended',
      scope: 'project',
      mode: 'interactive',
      skillId: 'github/toolbox/skills/engineering/setup-toolbox',
      appliesTo: ['github/toolbox/skills/engineering/*'],
      requiredArtifacts: ['docs/agents/domain.md']
    }
  });

  const state = await getState(root, project);
  assert.equal(state.setups[0].status, 'missing');
  assert.deepEqual(state.setups[0].affectedEnabledSkillIds, []);
  assert.equal(state.advice.some((item) => item.type.startsWith('collection-setup-')), false);
});

test('rejects unsafe setup artifact paths as invalid advice', async () => {
  const root = await makeTempDir('setup-root-');
  const project = await makeTempDir('setup-project-');
  await createSkill(root, 'github/toolbox/skills/engineering', 'setup-toolbox');
  await writeSetupContract(root, 'github', 'toolbox', {
    schemaVersion: 1,
    setup: {
      requirement: 'required',
      scope: 'project',
      mode: 'interactive',
      skillId: 'github/toolbox/skills/engineering/setup-toolbox',
      appliesTo: ['github/toolbox/skills/engineering/*'],
      requiredArtifacts: ['../outside.md']
    }
  });

  const state = await getState(root, project);
  assert.equal(state.setups[0].status, 'invalid');
  assert.match(state.setups[0].error, /项目内相对路径/);
  assert.equal(state.advice[0].type, 'collection-setup-invalid');
});

async function createSkill(root, sourcePath, name) {
  await ensureSourceFolders(root);
  const skill = path.join(root, sourcePath, name);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), `---\ndescription: ${name}\n---\n`);
  return skill;
}

async function writeSetupContract(root, source, collection, contract) {
  const file = path.join(root, 'collection-metadata', source, `${collection}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`);
}

async function linkSkill(project, alias, skillPath) {
  const dir = path.join(project, '.agents', 'skills');
  await mkdir(dir, { recursive: true });
  await symlink(skillPath, path.join(dir, alias), 'dir');
}

async function makeTempDir(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
}
