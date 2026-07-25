import {
  access,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename as fsRename,
  rm as fsRm,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  applyUpdateSource,
  inspectSource,
  planAddSource,
  planUpdateSource
} from '../lib/sourceManager.js';
import { makeTempDir } from './testHelpers.js';
import { buildZip } from './zipFixtures.js';

test('plans a local source replacement by classifying skill path changes', async () => {
  const fixture = await createInstalledSource({
    skills: {
      'skills/unchanged': '# Unchanged v1\n',
      'skills/removed': '# Removed\n'
    }
  });
  const replacement = await createSourceInput('source-update-replacement-', {
    'skills/unchanged': '# Unchanged v2\n',
    'skills/added': '# Added\n'
  });

  const plan = await planUpdateSource(
    { rootDir: fixture.root },
    { sourceId: fixture.sourceId, input: replacement }
  );

  assert.deepEqual(
    {
      operation: plan.operation,
      status: plan.status,
      sourceId: plan.sourceId,
      installPath: plan.installPath,
      input: plan.input,
      changes: plan.changes
    },
    {
      operation: 'update-source',
      status: 'ready',
      sourceId: fixture.sourceId,
      installPath: fixture.installPath,
      input: { type: 'local-directory', name: path.basename(replacement) },
      changes: {
        unchanged: ['skills/unchanged'],
        added: ['skills/added'],
        removedOrRelocated: ['skills/removed']
      }
    }
  );
});

test('blocks a replacement that removes a known current-project skill unless authorized', async () => {
  const fixture = await createInstalledSource({
    skills: {
      'skills/kept': '# Kept\n',
      'skills/removed': '# Removed\n'
    }
  });
  const replacement = await createSourceInput('source-update-breaking-', {
    'skills/kept': '# Kept v2\n'
  });
  const project = await makeTempDir('source-update-project-');
  const projectSkills = path.join(project, '.agents', 'skills');
  await mkdir(projectSkills, { recursive: true });
  await symlink(
    path.join(fixture.root, fixture.installPath, 'skills', 'removed'),
    path.join(projectSkills, 'removed'),
    'dir'
  );

  await assert.rejects(
    () => planUpdateSource(
      { rootDir: fixture.root, projectPath: project },
      { sourceId: fixture.sourceId, input: replacement }
    ),
    (error) => {
      assert.equal(error.category, 'breaking-replacement');
      assert.equal(error.exitCode, 4);
      assert.match(error.message, /--allow-breaking/);
      return true;
    }
  );

  const plan = await planUpdateSource(
    { rootDir: fixture.root, projectPath: project },
    {
      sourceId: fixture.sourceId,
      input: replacement,
      allowBreaking: true
    }
  );
  assert.deepEqual(plan.affectedProjectLinks, [{
    alias: 'removed',
    skillPath: 'skills/removed'
  }]);
});

test('replaces a local source at its stable install path and removes transaction artifacts', async () => {
  const fixture = await createInstalledSource({
    skills: {
      'skills/kept': '# Kept v1\n',
      'skills/old': '# Old\n'
    }
  });
  const replacement = await createSourceInput('source-update-success-', {
    'skills/kept': '# Kept v2\n',
    'skills/new': '# New\n'
  });
  const project = await makeTempDir('source-update-stable-project-');
  const projectSkills = path.join(project, '.agents', 'skills');
  const keptLink = path.join(projectSkills, 'kept');
  await mkdir(projectSkills, { recursive: true });
  await symlink(
    path.join(fixture.root, fixture.installPath, 'skills', 'kept'),
    keptLink,
    'dir'
  );

  const plan = await planUpdateSource(
    { rootDir: fixture.root, projectPath: project },
    { sourceId: fixture.sourceId, input: replacement }
  );
  const result = await applyUpdateSource(
    { rootDir: fixture.root, projectPath: project },
    plan
  );

  assert.equal(result.status, 'updated');
  assert.equal(result.installPath, fixture.installPath);
  assert.equal(
    await readFile(path.join(fixture.root, fixture.installPath, 'skills', 'kept', 'SKILL.md'), 'utf8'),
    '# Kept v2\n'
  );
  await assert.rejects(
    () => access(path.join(fixture.root, fixture.installPath, 'skills', 'old')),
    /ENOENT/
  );
  assert.equal(await readFile(path.join(keptLink, 'SKILL.md'), 'utf8'), '# Kept v2\n');
  assert.deepEqual(
    (await inspectSource({ rootDir: fixture.root }, fixture.sourceId)).skills,
    ['skills/kept', 'skills/new']
  );
  assert.deepEqual(await transactionEntries(fixture.root), []);
});

test('replaces a local source from a ZIP input', async () => {
  const fixture = await createInstalledSource({
    skills: { 'skills/old': '# Old\n' }
  });
  const archiveRoot = await makeTempDir('source-update-zip-');
  const archive = path.join(archiveRoot, 'replacement.zip');
  await writeFile(archive, buildZip([
    { name: 'bundle/skills/new/SKILL.md', content: '# New\n' }
  ]));

  const plan = await planUpdateSource(
    { rootDir: fixture.root },
    {
      sourceId: fixture.sourceId,
      input: archive,
      allowBreaking: true
    }
  );
  const result = await applyUpdateSource({ rootDir: fixture.root }, plan);

  assert.equal(result.input.type, 'local-zip');
  assert.equal(
    await readFile(path.join(fixture.root, fixture.installPath, 'skills', 'new', 'SKILL.md'), 'utf8'),
    '# New\n'
  );
  assert.deepEqual(
    (await inspectSource({ rootDir: fixture.root }, fixture.sourceId)).skills,
    ['skills/new']
  );
});

test('validation failure leaves the active source and registry unchanged', async () => {
  const fixture = await createInstalledSource({
    skills: { 'skills/current': '# Current\n' }
  });
  const replacement = await createSourceInput('source-update-invalid-', {
    'skills/replacement': '# Replacement\n'
  });
  const plan = await planUpdateSource(
    { rootDir: fixture.root },
    { sourceId: fixture.sourceId, input: replacement, allowBreaking: true }
  );
  const before = await snapshotTree(fixture.root);
  await fsRm(path.join(replacement, 'skills', 'replacement', 'SKILL.md'));

  await assert.rejects(
    () => applyUpdateSource({ rootDir: fixture.root }, plan),
    /SKILL\.md/
  );
  assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('publication failures restore the previous source and registry', async (t) => {
  for (const failAtRename of [2, 3, 4]) {
    await t.test(`rename ${failAtRename}`, async () => {
      const fixture = await createInstalledSource({
        skills: { 'skills/current': '# Current\n' }
      });
      const replacement = await createSourceInput('source-update-failure-', {
        'skills/replacement': '# Replacement\n'
      });
      const plan = await planUpdateSource(
        { rootDir: fixture.root },
        { sourceId: fixture.sourceId, input: replacement, allowBreaking: true }
      );
      const before = await snapshotTree(fixture.root);
      let renameCount = 0;
      const fileOperations = {
        rename: async (...args) => {
          renameCount += 1;
          if (renameCount === failAtRename) {
            throw new Error(`injected rename failure ${failAtRename}`);
          }
          return fsRename(...args);
        },
        rm: fsRm
      };

      await assert.rejects(
        () => applyUpdateSource(
          { rootDir: fixture.root, fileOperations },
          plan
        ),
        new RegExp(`injected rename failure ${failAtRename}`)
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    });
  }
});

async function createInstalledSource({ skills }) {
  const root = await makeTempDir('source-update-root-');
  const input = await createSourceInput('source-update-original-', skills);
  const plan = await planAddSource(
    { rootDir: root },
    { input, name: 'managed-source' }
  );
  await applyAddSource({ rootDir: root }, plan);
  return {
    root,
    sourceId: plan.sourceId,
    installPath: plan.installPath
  };
}

async function createSourceInput(prefix, skills) {
  const input = await makeTempDir(prefix);
  for (const [skillPath, content] of Object.entries(skills)) {
    await mkdir(path.join(input, skillPath), { recursive: true });
    await writeFile(path.join(input, skillPath, 'SKILL.md'), content);
  }
  return input;
}

async function transactionEntries(root) {
  try {
    return await readdir(path.join(root, '.skillcaddy', 'staging'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function snapshotTree(root) {
  const entries = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        entries.push([relativePath, 'directory']);
        await walk(entryPath);
      } else if (entry.isSymbolicLink()) {
        entries.push([relativePath, 'symlink', await readlink(entryPath)]);
      } else {
        entries.push([relativePath, 'file', await readFile(entryPath, 'hex')]);
      }
    }
  }

  await walk(root);
  return entries.sort((left, right) => left[0].localeCompare(right[0]));
}
