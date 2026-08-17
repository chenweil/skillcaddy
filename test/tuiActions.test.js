import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  disableAlias,
  enableSkillChoice,
  findSkillByChoice,
  listEnabledAliases,
  listSkillChoices,
  loadTuiState,
  saveSkillMetadata,
  summarizeState
} from '../lib/tuiActions.js';
import { ensureSourceFolders } from '../lib/skillStore.js';

test('lists and searches skill choices with enabled state', async () => {
  const root = await makeTempDir('tui-root-');
  const project = await makeTempDir('tui-project-');
  const skill = await createSkill(root, 'personal', 'review', 'Review code changes');

  await symlink(skill, await agentsLink(project, 'review'), 'dir');

  const state = await loadTuiState(root, project);
  const choices = listSkillChoices(state, { query: 'review' });

  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, 'personal/review');
  assert.equal(choices[0].enabled, true);
  assert.deepEqual(summarizeState(state), {
    projectPath: project,
    totalSkills: 1,
    availableSkills: 1,
    enabledAgents: 1,
    enabledClaude: 0,
    advice: 0
  });
});

test('prefers the metadata note as the skill introduction', async () => {
  const root = await makeTempDir('tui-root-');
  const project = await makeTempDir('tui-project-');
  await createSkill(root, 'personal', 'review', 'Review code changes');

  let state = await loadTuiState(root, project);
  await saveSkillMetadata(root, state, 'personal/review', {
    note: '审查代码改动。',
    tags: [],
    autoEnable: true
  });

  state = await loadTuiState(root, project);
  const [choice] = listSkillChoices(state, { query: 'review' });

  assert.equal(choice.label, 'personal/review - 审查代码改动。');
});

test('enables and disables a skill by TUI choice', async () => {
  const root = await makeTempDir('tui-root-');
  const project = await makeTempDir('tui-project-');
  await createSkill(root, 'personal', 'implement', 'Implement a change');

  let state = await loadTuiState(root, project);
  const enableResult = await enableSkillChoice(root, state, 'personal/implement');
  assert.equal(enableResult.alias, 'implement');
  assert.equal(enableResult.unchanged, false);

  state = await loadTuiState(root, project);
  assert.deepEqual(listEnabledAliases(state).map((item) => item.alias), ['implement']);

  const disableResult = await disableAlias(state, 'implement');
  assert.equal(disableResult.removed, true);

  state = await loadTuiState(root, project);
  assert.deepEqual(state.enabled, []);
});

test('enables a duplicate-name skill with a custom alias', async () => {
  const root = await makeTempDir('tui-root-');
  const project = await makeTempDir('tui-project-');
  await createSkill(root, 'personal', 'review', 'Personal review');
  await createSkill(root, 'github/toolbox/skills', 'review', 'Toolbox review');

  let state = await loadTuiState(root, project);
  const result = await enableSkillChoice(root, state, 'github/toolbox/skills/review', { alias: 'toolbox-review' });
  assert.equal(result.alias, 'toolbox-review');

  state = await loadTuiState(root, project);
  assert.deepEqual(listEnabledAliases(state).map((item) => item.alias), ['toolbox-review']);
});

test('TUI actions can explicitly enable, list, and disable a global skill', async () => {
  const root = await makeTempDir('tui-global-root-');
  const project = await makeTempDir('tui-global-project-');
  const globalDir = await makeTempDir('tui-global-dir-');
  await createSkill(root, 'personal', 'shared', 'Shared skill');

  let state = await loadTuiState(root, project, { globalDir });
  const enabled = await enableSkillChoice(root, state, 'personal/shared', { scope: 'global', globalDir });
  assert.equal(enabled.scope, 'global');

  state = await loadTuiState(root, project, { globalDir });
  assert.deepEqual(listEnabledAliases(state, 'global').map((item) => item.alias), ['shared']);
  const disabled = await disableAlias(state, 'shared', { scope: 'global', rootDir: root, globalDir });
  assert.equal(disabled.removed, true);
});

test('TUI actions can explicitly enable, list, and disable a Hermes skill', async () => {
  const root = await makeTempDir('tui-hermes-root-');
  const project = await makeTempDir('tui-hermes-project-');
  const hermesDir = await makeTempDir('tui-hermes-dir-');
  await createSkill(root, 'github/toolbox/skills', 'shared', 'Shared Hermes skill');

  let state = await loadTuiState(root, project, { hermesDir });
  const enabled = await enableSkillChoice(root, state, 'github/toolbox/skills/shared', { scope: 'hermes', hermesDir });
  assert.equal(enabled.scope, 'hermes');

  state = await loadTuiState(root, project, { hermesDir });
  assert.deepEqual(listEnabledAliases(state, 'hermes').map((item) => item.alias), ['shared']);
  const disabled = await disableAlias(state, 'shared', { scope: 'hermes', rootDir: root, hermesDir });
  assert.equal(disabled.removed, true);
});

test('saves metadata through sidecar storage', async () => {
  const root = await makeTempDir('tui-root-');
  const project = await makeTempDir('tui-project-');
  await createSkill(root, 'github/toolbox/skills', 'triage', 'Triage issues');

  let state = await loadTuiState(root, project);
  const result = await saveSkillMetadata(root, state, 'github/toolbox/skills/triage', {
    note: 'Use before implementation.',
    tags: ['Workflow'],
    autoEnable: false
  });

  assert.equal(result.metadata.autoEnable, false);
  assert.equal(result.metadata.metadataPath, path.join(root, '.skillcaddy', 'metadata', 'github', 'toolbox', 'skills', 'triage', 'skillcaddy.json'));
  await assert.rejects(
    () => readFile(path.join(root, 'github', 'toolbox', 'skills', 'triage', 'skillcaddy.json'), 'utf8'),
    /ENOENT/
  );

  state = await loadTuiState(root, project);
  const skill = findSkillByChoice(state, 'github/toolbox/skills/triage');
  assert.equal(skill.note, 'Use before implementation.');
  assert.deepEqual(skill.tags, ['Workflow']);
  assert.equal(skill.autoEnable, false);
});

async function createSkill(root, sourcePath, name, description) {
  await ensureSourceFolders(root);
  const skill = path.join(root, sourcePath, name);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), `---\ndescription: ${description}\n---\n# ${name}\n`);
  return skill;
}

async function agentsLink(project, alias) {
  const dir = path.join(project, '.agents', 'skills');
  await mkdir(dir, { recursive: true });
  return path.join(dir, alias);
}

async function makeTempDir(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
}
