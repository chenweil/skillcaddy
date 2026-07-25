import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySourceMigration,
  inspectSource,
  planSourceMigration
} from '../lib/sourceManager.js';
import { makeTempDir } from './testHelpers.js';

const execFile = promisify(execFileCallback);

test('plans Git and legacy Local source adoption without changing sources or project links', async () => {
  const root = await makeTempDir('source-migration-plan-');
  const project = await makeTempDir('source-migration-project-');
  const gitPath = path.join(root, 'github', 'noncanonical-checkout');
  const localPath = path.join(root, 'personal', 'manual-notes');
  const gitSkill = path.join(gitPath, 'skills', 'review');
  const projectSkills = path.join(project, '.agents', 'skills');

  await createGitSource(gitPath, {
    remote: 'https://token:secret@github.com/example/review-skills.git?token=hidden#fragment',
    skillPath: 'skills/review'
  });
  await mkdir(localPath, { recursive: true });
  await writeFile(path.join(localPath, 'SKILL.md'), '# Manual notes\n');
  await mkdir(projectSkills, { recursive: true });
  await symlink(gitSkill, path.join(projectSkills, 'review'), 'dir');

  const rootBefore = await snapshotTree(root);
  const projectBefore = await snapshotTree(project);
  const { stdout: commitOutput } = await execFile('git', ['-C', gitPath, 'rev-parse', 'HEAD']);
  const commit = commitOutput.trim();

  const plan = await planSourceMigration({ rootDir: root, projectPath: project });

  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.records.length, 2);
  assert.deepEqual(plan.records[0], {
    schemaVersion: 1,
    sourceId: 'github/example/review-skills',
    bucket: 'github',
    type: 'git',
    installPath: 'github/noncanonical-checkout',
    origin: {
      kind: 'git',
      remote: 'https://github.com/example/review-skills.git',
      ref: 'main',
      commit
    },
    skills: ['skills/review']
  });
  assert.deepEqual(plan.records[1], {
    schemaVersion: 1,
    sourceId: 'personal/manual-notes',
    bucket: 'personal',
    type: 'legacy-local',
    installPath: 'personal/manual-notes',
    origin: { kind: 'unknown' },
    integrity: {
      algorithm: 'sha256',
      value: plan.records[1].integrity.value
    },
    skills: ['.']
  });
  assert.match(plan.records[1].integrity.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(await snapshotTree(root), rootBefore);
  assert.deepEqual(await snapshotTree(project), projectBefore);
});

test('applies only source-registry records and repeated application is idempotent', async () => {
  const root = await makeTempDir('source-migration-apply-');
  const project = await makeTempDir('source-migration-apply-project-');
  const sourcePath = path.join(root, 'personal', 'notes-on-disk');
  const projectSkills = path.join(project, '.agents', 'skills');

  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Notes\n');
  await mkdir(projectSkills, { recursive: true });
  await symlink(sourcePath, path.join(projectSkills, 'notes'), 'dir');

  const plan = await planSourceMigration({ rootDir: root, projectPath: project });
  const sourcesBefore = await snapshotTree(path.join(root, 'personal'));
  const projectBefore = await snapshotTree(project);

  const applied = await applySourceMigration({ rootDir: root, projectPath: project }, plan);

  assert.deepEqual(applied, {
    dryRun: false,
    written: ['personal/notes-on-disk'],
    unchanged: [],
    unresolved: []
  });
  assert.deepEqual(
    await inspectSource({ rootDir: root }, 'personal/notes-on-disk'),
    plan.records[0]
  );
  assert.deepEqual(await snapshotTree(path.join(root, 'personal')), sourcesBefore);
  assert.deepEqual(await snapshotTree(project), projectBefore);

  const repeated = await applySourceMigration({ rootDir: root, projectPath: project }, plan);
  assert.deepEqual(repeated, {
    dryRun: false,
    written: [],
    unchanged: ['personal/notes-on-disk'],
    unresolved: []
  });
  assert.deepEqual(await snapshotTree(path.join(root, 'personal')), sourcesBefore);
  assert.deepEqual(await snapshotTree(project), projectBefore);
});

test('reports ambiguous remotes, duplicate identities, nested repositories, and unsafe paths', async () => {
  const root = await makeTempDir('source-migration-conflicts-');
  const outside = await makeTempDir('source-migration-outside-');
  const ambiguousPath = path.join(root, 'github', 'ambiguous');
  const duplicateOnePath = path.join(root, 'github', 'duplicate-one');
  const duplicateTwoPath = path.join(root, 'github', 'duplicate-two');
  const gitLinkPath = path.join(root, 'github', 'git-link');
  const nestedPath = path.join(root, 'github', 'nested');
  const outsideGitPath = path.join(outside, 'git-source');

  await createGitSource(ambiguousPath, {
    remote: 'https://github.com/example/ambiguous.git',
    skillPath: 'skills/ambiguous'
  });
  await execFile('git', [
    'remote',
    'set-url',
    '--add',
    'origin',
    'https://github.com/other/ambiguous.git'
  ], { cwd: ambiguousPath });

  for (const sourcePath of [duplicateOnePath, duplicateTwoPath]) {
    await createGitSource(sourcePath, {
      remote: 'https://github.com/example/duplicate.git',
      skillPath: 'skills/duplicate'
    });
  }

  await createGitSource(nestedPath, {
    remote: 'https://github.com/example/nested.git',
    skillPath: 'skills/nested'
  });
  await mkdir(path.join(nestedPath, 'vendor', '.git'), { recursive: true });
  await createGitSource(outsideGitPath, {
    remote: 'https://github.com/example/outside.git',
    skillPath: 'skills/outside'
  });
  await mkdir(gitLinkPath, { recursive: true });
  await writeFile(path.join(gitLinkPath, 'SKILL.md'), '# Git link\n');
  await symlink(path.join(outsideGitPath, '.git'), path.join(gitLinkPath, '.git'), 'dir');
  await mkdir(path.join(root, 'personal'), { recursive: true });
  await mkdir(path.join(root, 'personal', '.hidden'), { recursive: true });
  await writeFile(path.join(root, 'personal', '.hidden', 'SKILL.md'), '# Hidden\n');
  await mkdir(path.join(root, 'personal', 'bad name'), { recursive: true });
  await writeFile(path.join(root, 'personal', 'bad name', 'SKILL.md'), '# Invalid identity\n');
  await symlink(outside, path.join(root, 'personal', 'escaped'), 'dir');

  const plan = await planSourceMigration({ rootDir: root });

  assert.deepEqual(
    plan.records.map(({ sourceId, installPath, type, skills }) => ({
      sourceId,
      installPath,
      type,
      skills
    })),
    [{
      sourceId: 'personal/.hidden',
      installPath: 'personal/.hidden',
      type: 'legacy-local',
      skills: ['.']
    }]
  );
  assert.deepEqual(
    plan.unresolved.map(({ installPath, reason }) => ({ installPath, reason })),
    [
      { installPath: 'github/ambiguous', reason: 'ambiguous-remote' },
      { installPath: 'github/duplicate-one', reason: 'duplicate-identity' },
      { installPath: 'github/duplicate-two', reason: 'duplicate-identity' },
      { installPath: 'github/git-link', reason: 'unsafe-path' },
      { installPath: 'github/nested', reason: 'nested-repository' },
      { installPath: 'personal/bad name', reason: 'invalid-identity' },
      { installPath: 'personal/escaped', reason: 'unsafe-path' }
    ]
  );
});

async function createGitSource(directory, { remote, skillPath }) {
  await mkdir(path.join(directory, skillPath), { recursive: true });
  await writeFile(path.join(directory, skillPath, 'SKILL.md'), '# Review\n');
  await execFile('git', ['init', '-b', 'main'], { cwd: directory });
  await execFile('git', ['config', 'user.name', 'Skillcaddy Test'], { cwd: directory });
  await execFile('git', ['config', 'user.email', 'skillcaddy@example.com'], { cwd: directory });
  await execFile('git', ['add', '.'], { cwd: directory });
  await execFile('git', ['commit', '-m', 'fixture'], { cwd: directory });
  await execFile('git', ['remote', 'add', 'origin', remote], { cwd: directory });
}

async function snapshotTree(root) {
  const entries = [];

  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = path.join(directory, child.name);
      const relativePath = path.relative(root, childPath);
      if (child.isSymbolicLink()) {
        entries.push([relativePath, 'symlink', await readlink(childPath)]);
      } else if (child.isDirectory()) {
        entries.push([relativePath, 'directory']);
        await walk(childPath);
      } else {
        entries.push([relativePath, 'file', await readFile(childPath, 'hex')]);
      }
    }
  }

  await walk(root);
  return entries;
}
