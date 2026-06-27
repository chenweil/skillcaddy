import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  disableSkill,
  enableSkill,
  ensureSourceFolders,
  getState
} from '../lib/skillStore.js';
import {
  readClaudeSkill,
  syncClaudeSkills,
  unlinkClaudeSkill,
  unlinkClaudeSkills
} from '../lib/claudeStore.js';

test('scans source folders and enables a skill with a symlink', async () => {
  const root = await makeTempDir('skills-root-');
  const project = await makeTempDir('skills-project-');
  const skill = path.join(root, 'personal', 'review');

  await ensureSourceFolders(root);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\ndescription: Review code changes\n---\n# Review\n');

  const state = await getState(root, project);
  assert.equal(state.skills.length, 1);
  assert.equal(state.skills[0].description, 'Review code changes');

  const result = await enableSkill(root, {
    projectPath: project,
    skillPath: skill,
    alias: 'review'
  });

  assert.equal(result.unchanged, false);

  const nextState = await getState(root, project);
  assert.equal(nextState.enabled.length, 1);
  assert.equal(nextState.enabled[0].alias, 'review');
  assert.equal(nextState.enabled[0].targetPath, skill);
});

test('scans direct skills and nested repository skills', async () => {
  const root = await makeTempDir('skills-root-');
  const project = await makeTempDir('skills-project-');
  const personalSkill = path.join(root, 'personal', 'writing');
  const repoSkill = path.join(root, 'github', 'toolbox', 'skills', 'review');
  const categorizedRepoSkill = path.join(root, 'github', 'toolbox', 'skills', 'engineering', 'tdd');
  const singleSkillRepo = path.join(root, 'github', 'single-skill-repo', 'skills');

  await ensureSourceFolders(root);
  await mkdir(personalSkill, { recursive: true });
  await mkdir(repoSkill, { recursive: true });
  await mkdir(categorizedRepoSkill, { recursive: true });
  await mkdir(singleSkillRepo, { recursive: true });
  await writeFile(path.join(personalSkill, 'SKILL.md'), '---\ndescription: Personal writing\n---\n');
  await writeFile(path.join(repoSkill, 'SKILL.md'), '---\ndescription: Repo review\n---\n');
  await writeFile(path.join(categorizedRepoSkill, 'SKILL.md'), '---\ndescription: Test first\n---\n');
  await writeFile(path.join(singleSkillRepo, 'SKILL.md'), '---\ndescription: Single skill repo\n---\n');

  const state = await getState(root, project);
  const ids = state.skills.map((skill) => skill.id).sort();

  assert.deepEqual(ids, [
    'github/single-skill-repo/skills',
    'github/toolbox/skills/review',
    'github/toolbox/skills/engineering/tdd',
    'personal/writing'
  ].sort());
  assert.equal(state.skills.find((skill) => skill.id === 'github/single-skill-repo/skills').name, 'single-skill-repo');
  assert.equal(state.skills.find((skill) => skill.id === 'github/toolbox/skills/review').name, 'review');
  assert.equal(state.skills.find((skill) => skill.id === 'github/toolbox/skills/review').collection, 'toolbox');
  assert.equal(state.skills.find((skill) => skill.id === 'personal/writing').collection, 'writing');
});

test('disable only removes symlinks and keeps original files', async () => {
  const root = await makeTempDir('skills-root-');
  const project = await makeTempDir('skills-project-');
  const skill = path.join(root, 'github', 'security-audit');
  const skillFile = path.join(skill, 'SKILL.md');

  await ensureSourceFolders(root);
  await mkdir(skill, { recursive: true });
  await writeFile(skillFile, '# Security audit\n');
  await enableSkill(root, { projectPath: project, skillPath: skill, alias: 'security-audit' });

  const result = await disableSkill({ projectPath: project, alias: 'security-audit' });
  assert.equal(result.removed, true);
  assert.equal(await readFile(skillFile, 'utf8'), '# Security audit\n');

  const nextState = await getState(root, project);
  assert.equal(nextState.enabled.length, 0);
});

test('syncs Claude skills entry to the agents skills directory', async () => {
  const project = await makeTempDir('skills-project-');
  const skill = path.join(project, 'personal', 'claude-review');

  await ensureSourceFolders(project);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Claude review\n');
  await enableSkill(project, { projectPath: project, skillPath: skill, alias: 'claude-review' });
  const result = await syncClaudeSkills(project);
  assert.equal(result.targetPath, '../.agents/skills');
  const state = await getState(project, project);
  assert.equal(state.claude.exists, true);
  assert.equal(state.claude.skills[0].alias, 'claude-review');
  assert.equal((await readClaudeSkill({ projectPath: project, alias: 'claude-review' })).content, '# Claude review\n');

  const again = await syncClaudeSkills(project);
  assert.equal(again.unchanged, true);
  assert.equal((await unlinkClaudeSkill({ projectPath: project, alias: 'claude-review' })).removed, true);

  const removed = await unlinkClaudeSkills(project);
  assert.equal(removed.removed, true);
  assert.equal((await getState(project, project)).claude.exists, false);
});

async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}
