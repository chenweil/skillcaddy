import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCliInstall,
  checkTuiInstall,
  installCliCommand,
  installTuiCommand
} from '../lib/tuiInstall.js';

test('links the cloned repository as the global skillcaddy command', async () => {
  const root = await makeSkillcaddyRoot();
  const globalRoot = await makeTempDir('tui-global-root-');
  const targetPath = path.join(globalRoot, 'skillcaddy');
  let linkCalls = 0;

  try {
    const before = await checkTuiInstall(root, { globalRoot });
    assert.equal(before.status, 'missing');
    assert.equal((await checkCliInstall(root, { globalRoot })).status, 'missing');

    const installed = await installTuiCommand(root, {
      globalRoot,
      linkPackage: async () => {
        linkCalls += 1;
        await symlink(root, targetPath, 'dir');
      }
    });

    assert.equal(installed.ok, true);
    assert.equal(installed.status, 'installed');
    assert.equal(installed.unchanged, false);
    assert.equal(installed.targetPath, targetPath);
    assert.equal((await checkCliInstall(root, { globalRoot })).ok, true);

    const again = await installTuiCommand(root, {
      globalRoot,
      linkPackage: async () => {
        linkCalls += 1;
      }
    });
    assert.equal(again.unchanged, true);
    assert.equal((await installCliCommand(root, { globalRoot })).unchanged, true);
    assert.equal(linkCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

test('refuses to replace a global Skillcaddy package linked to another clone', async () => {
  const root = await makeSkillcaddyRoot();
  const otherRoot = await makeSkillcaddyRoot();
  const globalRoot = await makeTempDir('tui-global-root-');

  try {
    await symlink(otherRoot, path.join(globalRoot, 'skillcaddy'), 'dir');

    const result = await checkTuiInstall(root, { globalRoot });
    assert.equal(result.status, 'conflict');
    assert.equal(result.linkTarget, await realpath(otherRoot));

    await assert.rejects(
      () => installTuiCommand(root, {
        globalRoot,
        linkPackage: async () => {
          throw new Error('linkPackage must not run for conflicts');
        }
      }),
      /points elsewhere/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
});

async function makeSkillcaddyRoot() {
  const root = await makeTempDir('tui-install-root-');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'tui.js'), '#!/usr/bin/env node\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'skillcaddy',
    bin: { skillcaddy: 'scripts/tui.js' }
  }));
  return root;
}

async function makeTempDir(prefix) {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
