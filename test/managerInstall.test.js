import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkManagerInstall,
  getManagerInstallPaths,
  installManagerSkill
} from '../lib/managerInstall.js';

test('reports missing manager install before bootstrap', async () => {
  const root = await makeSkillcaddyRoot();
  const homeDir = await makeTempDir('manager-home-');

  try {
    const result = await checkManagerInstall(root, { homeDir });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'missing');
    assert.equal(result.targetPath, path.join(homeDir, '.agents', 'skills', 'skillcaddy-manager'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('installs manager skill as a global agents symlink', async () => {
  const root = await makeSkillcaddyRoot();
  const homeDir = await makeTempDir('manager-home-');

  try {
    const result = await installManagerSkill(root, { homeDir });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'installed');
    assert.equal(result.unchanged, false);

    const again = await installManagerSkill(root, { homeDir });
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('refuses to overwrite a conflicting manager target', async () => {
  const root = await makeSkillcaddyRoot();
  const homeDir = await makeTempDir('manager-home-');
  const paths = getManagerInstallPaths(root, { homeDir });

  try {
    await mkdir(path.dirname(paths.targetPath), { recursive: true });
    await writeFile(paths.targetPath, 'not managed by skillcaddy\n');

    const result = await checkManagerInstall(root, { homeDir });
    assert.equal(result.status, 'conflict');

    await assert.rejects(
      () => installManagerSkill(root, { homeDir }),
      /target exists but is not a symlink/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('refuses to overwrite a manager symlink pointing elsewhere', async () => {
  const root = await makeSkillcaddyRoot();
  const homeDir = await makeTempDir('manager-home-');
  const otherSkill = await makeTempDir('manager-other-skill-');
  const paths = getManagerInstallPaths(root, { homeDir });

  try {
    await mkdir(path.dirname(paths.targetPath), { recursive: true });
    await symlink(otherSkill, paths.targetPath, 'dir');

    const result = await checkManagerInstall(root, { homeDir });
    assert.equal(result.status, 'conflict');
    assert.equal(result.linkTarget, otherSkill);

    await assert.rejects(
      () => installManagerSkill(root, { homeDir }),
      /target symlink points elsewhere/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(otherSkill, { recursive: true, force: true });
  }
});

async function makeSkillcaddyRoot() {
  const root = await makeTempDir('manager-root-');
  const skill = path.join(root, 'skills', 'skillcaddy-manager');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Skillcaddy Manager\n');
  return root;
}

async function makeTempDir(prefix) {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
