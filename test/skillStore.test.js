import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
  syncClaudeSkills,
  unlinkClaudeSkill,
  unlinkClaudeSkills
} from '../lib/claudeStore.js';
import { enableProjectSkill } from '../lib/projectActions.js';

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

test('project enable syncs Claude skills best-effort', async () => {
  const root = await makeTempDir('skills-root-');
  const project = await makeTempDir('skills-project-');
  const skill = path.join(root, 'personal', 'project-sync');

  await ensureSourceFolders(root);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Project sync\n');

  const result = await enableProjectSkill(root, {
    projectPath: project,
    skillPath: skill,
    alias: 'project-sync'
  });

  assert.equal(result.claudeSync.ok, true);
  assert.equal(result.claudeSync.unchanged, false);

  const state = await getState(root, project);
  assert.equal(state.enabled[0].alias, 'project-sync');
  assert.equal(state.claude.skills[0].alias, 'project-sync');
});

test('rejects unsafe project paths before creating skill links', async () => {
  const root = await makeTempDir('skills-root-');
  const skill = path.join(root, 'personal', 'safe-path');

  await ensureSourceFolders(root);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Safe path\n');

  await assert.rejects(
    () => enableSkill(root, { projectPath: '/', skillPath: skill, alias: 'safe-path' }),
    /projectPath 不能是系统目录/
  );

  await assert.rejects(
    () => enableSkill(root, { projectPath: path.dirname(homedir()), skillPath: skill, alias: 'safe-path' }),
    /projectPath 不能是用户主目录的父目录/
  );
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

test('syncs Claude skills as a real directory with per-skill symlinks', async () => {
  const project = await makeTempDir('skills-project-');
  const skill = path.join(project, 'personal', 'claude-review');

  await ensureSourceFolders(project);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Claude review\n');
  await enableSkill(project, { projectPath: project, skillPath: skill, alias: 'claude-review' });

  const result = await syncClaudeSkills(project);
  assert.equal(result.targetPath, path.join(project, '.agents', 'skills'));
  assert.equal(result.unchanged, false);

  const claudeSkills = path.join(project, '.claude', 'skills');
  const stat = await lstat(claudeSkills);
  assert.equal(stat.isSymbolicLink(), false, '.claude/skills 应该是真实目录，不是软链接');
  assert.equal(stat.isDirectory(), true);

  const claudeEntry = await lstat(path.join(claudeSkills, 'claude-review'));
  assert.equal(claudeEntry.isSymbolicLink(), true, '.claude/skills/<alias> 应该是软链接');

  const state = await getState(project, project);
  assert.equal(state.claude.exists, true);
  assert.equal(state.claude.skills[0].alias, 'claude-review');

  const again = await syncClaudeSkills(project);
  assert.equal(again.unchanged, true);

  assert.equal((await unlinkClaudeSkill({ projectPath: project, alias: 'claude-review' })).removed, true);
  assert.equal((await getState(project, project)).claude.skills.length, 0);

  const removed = await unlinkClaudeSkills(project);
  assert.equal(removed.removed, false, '目录已空，不应算移除');
});

test('disabling an agents skill does not remove the Claude entry', async () => {
  const project = await makeTempDir('skills-project-');
  const skill = path.join(project, 'personal', 'isolated');

  await ensureSourceFolders(project);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Isolated\n');
  await enableSkill(project, { projectPath: project, skillPath: skill, alias: 'isolated' });
  await syncClaudeSkills(project);

  assert.equal((await getState(project, project)).claude.skills[0].alias, 'isolated');

  await disableSkill({ projectPath: project, alias: 'isolated' });

  const state = await getState(project, project);
  assert.equal(state.enabled.length, 0, 'agents 列表里应该已经移除');
  assert.equal(state.claude.skills.length, 1, 'Claude 列表里应该仍然存在（独立软链接）');
  assert.equal(state.claude.skills[0].alias, 'isolated');
  assert.equal(state.claude.skills[0].exists, false, '目标已不存在，标记为断链');
});

test('migrates legacy .claude/skills directory symlink to per-skill layout', async () => {
  const project = await makeTempDir('skills-project-');
  const skill = path.join(project, 'personal', 'legacy');

  await ensureSourceFolders(project);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Legacy\n');
  await enableSkill(project, { projectPath: project, skillPath: skill, alias: 'legacy' });

  // 手动模拟旧版 layout：.claude/skills -> ../.agents/skills
  const claudeParent = path.join(project, '.claude');
  await mkdir(claudeParent, { recursive: true });
  await symlink('../.agents/skills', path.join(claudeParent, 'skills'), 'dir');

  const beforeStat = await lstat(path.join(claudeParent, 'skills'));
  assert.equal(beforeStat.isSymbolicLink(), true, '前置条件：应该是目录级软链接');

  const result = await syncClaudeSkills(project);
  assert.equal(result.unchanged, false);

  const afterStat = await lstat(path.join(claudeParent, 'skills'));
  assert.equal(afterStat.isSymbolicLink(), false, '迁移后应该是真实目录');
  assert.equal(afterStat.isDirectory(), true);

  const state = await getState(project, project);
  assert.equal(state.claude.skills[0].alias, 'legacy');
  assert.equal(state.claude.skills[0].isSymlink, true);
});

test('Claude list is sorted alphabetically by alias', async () => {
  const project = await makeTempDir('skills-project-');
  const sources = ['zebra', 'alpha', 'mango', 'banana'];
  const expectedOrder = ['alpha', 'banana', 'mango', 'zebra'];

  await ensureSourceFolders(project);
  for (const alias of sources) {
    const dir = path.join(project, 'personal', alias);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `# ${alias}\n`);
    await enableSkill(project, { projectPath: project, skillPath: dir, alias });
  }
  await syncClaudeSkills(project);

  const state = await getState(project, project);
  const aliases = state.claude.skills.map((skill) => skill.alias);
  assert.deepEqual(aliases, expectedOrder);

  // agents 列也得是排序的
  const agentsAliases = state.enabled.map((skill) => skill.alias);
  assert.deepEqual(agentsAliases, expectedOrder);
});

async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}
