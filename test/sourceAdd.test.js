import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  inspectSource,
  planAddSource
} from '../lib/sourceManager.js';
import { scanSkills } from '../lib/skillStore.js';
import { makeTempDir } from './testHelpers.js';

test('adds a copied local directory, registers it, and leaves project links unchanged', async () => {
  const root = await makeTempDir('source-add-root-');
  const downloads = await makeTempDir('source-add-input-');
  const project = await makeTempDir('source-add-project-');
  const input = path.join(downloads, 'team-skills');
  const review = path.join(input, 'skills', 'review');
  const notes = path.join(input, 'skills', 'notes');

  await mkdir(review, { recursive: true });
  await mkdir(notes, { recursive: true });
  await writeFile(path.join(review, 'SKILL.md'), '---\ndescription: Review code\n---\n# Review\n');
  await writeFile(path.join(notes, 'SKILL.md'), '# Notes\n');
  await writeFile(path.join(review, 'guide.md'), 'guide\n');
  await symlink('guide.md', path.join(review, 'guide-link'));
  const projectBefore = await snapshotTree(project);

  const plan = await planAddSource({ rootDir: root, projectPath: project }, { input });

  assert.deepEqual(
    {
      status: plan.status,
      sourceId: plan.sourceId,
      installPath: plan.installPath,
      input: plan.input,
      skills: plan.skills
    },
    {
      status: 'ready',
      sourceId: 'personal/team-skills',
      installPath: 'personal/team-skills',
      input: { type: 'local-directory', name: 'team-skills' },
      skills: ['skills/notes', 'skills/review']
    }
  );
  assert.deepEqual(plan.warnings.map((warning) => warning.category), [
    'missing-frontmatter',
    'missing-description'
  ]);

  const result = await applyAddSource({ rootDir: root, projectPath: project }, plan);
  assert.equal(result.status, 'added');
  assert.equal(await readlink(path.join(root, 'personal', 'team-skills', 'skills', 'review', 'guide-link')), 'guide.md');
  assert.deepEqual(await snapshotTree(project), projectBefore);

  const record = await inspectSource({ rootDir: root }, 'personal/team-skills');
  assert.deepEqual(record.origin, { kind: 'local', name: 'team-skills' });
  assert.match(record.integrity.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.skills, ['skills/notes', 'skills/review']);
  assert.equal(JSON.stringify(record).includes(downloads), false);

  await rm(input, { recursive: true });
  assert.equal(
    await readFile(path.join(root, 'personal', 'team-skills', 'skills', 'review', 'guide.md'), 'utf8'),
    'guide\n'
  );
  assert.deepEqual(
    (await scanSkills(root)).map((skill) => skill.id),
    ['personal/team-skills/skills/notes', 'personal/team-skills/skills/review']
  );
});

test('rejects escaping or absolute local symlinks before changing the library', async (t) => {
  for (const fixture of [
    { name: 'escaping', target: '../../outside' },
    { name: 'absolute', target: '/tmp/outside' }
  ]) {
    await t.test(fixture.name, async () => {
      const root = await makeTempDir('source-add-symlink-root-');
      const input = await makeTempDir(`source-add-symlink-${fixture.name}-`);
      await writeFile(path.join(input, 'SKILL.md'), '# Unsafe\n');
      await symlink(fixture.target, path.join(input, 'unsafe'));

      await assert.rejects(
        () => planAddSource({ rootDir: root }, { input }),
        /symlink/i
      );
      assert.deepEqual(await visibleLibraryState(root), []);
    });
  }
});

test('requires scanner-visible readable non-empty regular SKILL.md files', async (t) => {
  const cases = [
    {
      name: 'missing',
      prepare: async (input) => writeFile(path.join(input, 'README.md'), '# No skill\n')
    },
    {
      name: 'empty',
      prepare: async (input) => writeFile(path.join(input, 'SKILL.md'), '')
    },
    {
      name: 'symlink',
      prepare: async (input) => {
        await writeFile(path.join(input, 'README.md'), '# Linked\n');
        await symlink('README.md', path.join(input, 'SKILL.md'));
      }
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await makeTempDir('source-add-invalid-root-');
      const input = await makeTempDir(`source-add-${fixture.name}-`);
      await fixture.prepare(input);
      await assert.rejects(
        () => planAddSource({ rootDir: root }, { input }),
        /SKILL\.md/
      );
      assert.deepEqual(await visibleLibraryState(root), []);
    });
  }
});

test('treats identical adds as no-ops and requires a namespace for distinct collisions', async () => {
  const root = await makeTempDir('source-add-collision-root-');
  const parentOne = await makeTempDir('source-add-collision-one-');
  const parentTwo = await makeTempDir('source-add-collision-two-');
  const first = path.join(parentOne, 'shared');
  const second = path.join(parentTwo, 'shared');
  await writeDirectSkill(first, '# First\n');
  await writeDirectSkill(second, '# Second\n');

  const firstPlan = await planAddSource({ rootDir: root }, { input: first });
  await applyAddSource({ rootDir: root }, firstPlan);

  const repeatedPlan = await planAddSource({ rootDir: root }, { input: first });
  assert.equal(repeatedPlan.status, 'already-installed');
  assert.equal((await applyAddSource({ rootDir: root }, repeatedPlan)).status, 'already-installed');

  await assert.rejects(
    () => planAddSource({ rootDir: root }, { input: second }),
    (error) => error.category === 'source-collision'
  );
  assert.equal(await readFile(path.join(root, 'personal', 'shared', 'SKILL.md'), 'utf8'), '# First\n');

  const namespaced = await planAddSource(
    { rootDir: root },
    { input: second, namespace: 'other' }
  );
  assert.equal(namespaced.sourceId, 'personal/other/shared');
  assert.equal(namespaced.installPath, 'personal/other--shared');
  await applyAddSource({ rootDir: root }, namespaced);
  assert.equal(await readFile(path.join(root, 'personal', 'other--shared', 'SKILL.md'), 'utf8'), '# Second\n');
});

test('refuses unmanaged destination collisions and stale add plans without overwriting', async () => {
  const root = await makeTempDir('source-add-stale-root-');
  const input = await makeTempDir('source-add-stale-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Initial\n');
  const sourceName = path.basename(input);
  await mkdir(path.join(root, 'personal', sourceName), { recursive: true });
  await assert.rejects(
    () => planAddSource({ rootDir: root }, { input }),
    (error) => error.category === 'source-collision'
  );

  const cleanRoot = await makeTempDir('source-add-stale-clean-root-');
  const plan = await planAddSource({ rootDir: cleanRoot }, { input });
  await writeFile(path.join(input, 'SKILL.md'), '# Changed\n');
  await assert.rejects(
    () => applyAddSource({ rootDir: cleanRoot }, plan),
    /changed since the add plan/
  );
  assert.deepEqual(await visibleLibraryState(cleanRoot), []);
});

test('rejects a symlinked personal bucket before publishing outside the library', async () => {
  const root = await makeTempDir('source-add-bucket-root-');
  const outside = await makeTempDir('source-add-bucket-outside-');
  const input = await makeTempDir('source-add-bucket-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Safe input\n');
  await symlink(outside, path.join(root, 'personal'), 'dir');
  const plan = await planAddSource({ rootDir: root }, { input });

  await assert.rejects(
    () => applyAddSource({ rootDir: root }, plan),
    /not a safe directory/
  );
  assert.deepEqual(await readdir(outside), []);
});

test('warns when frontmatter declares an empty description', async () => {
  const root = await makeTempDir('source-add-description-root-');
  const input = await makeTempDir('source-add-description-input-');
  await writeFile(path.join(input, 'SKILL.md'), '---\ndescription:\n---\n# Empty description\n');

  const plan = await planAddSource({ rootDir: root }, { input });
  assert.deepEqual(plan.warnings.map((warning) => warning.category), ['missing-description']);
});

async function writeDirectSkill(directory, content) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), content);
}

async function visibleLibraryState(root) {
  const result = [];
  for (const directory of ['personal', '.skillcaddy']) {
    try {
      const entries = await readdir(path.join(root, directory));
      if (entries.length > 0) result.push([directory, entries.sort()]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

async function snapshotTree(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        entries.push([relative, 'directory']);
        await walk(entryPath);
      } else if (entry.isSymbolicLink()) {
        entries.push([relative, 'symlink', await readlink(entryPath)]);
      } else {
        entries.push([relative, 'file', (await lstat(entryPath)).size]);
      }
    }
  }
  await walk(root);
  return entries.sort();
}
