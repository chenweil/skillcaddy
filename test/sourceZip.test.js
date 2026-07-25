import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAddSource, inspectSource, planAddSource } from '../lib/sourceManager.js';
import { scanSkills } from '../lib/skillStore.js';
import { makeTempDir } from './testHelpers.js';
import { buildZip } from './zipFixtures.js';

test('recognizes ZIP content by signature and imports a wrapped multi-skill archive', async () => {
  const root = await makeTempDir('source-zip-root-');
  const downloads = await makeTempDir('source-zip-input-');
  const archive = path.join(downloads, 'publisher-package.bin');
  await writeFile(archive, buildZip([
    {
      name: 'bundle/skills/alpha/SKILL.md',
      content: '---\ndescription: Alpha\npublisher-field: value\n---\n# Alpha\n'
    },
    { name: 'bundle/skills/beta/SKILL.md', content: '# Beta\n' },
    { name: 'bundle/skills/beta/data.txt', content: 'payload', method: 'store' },
    { name: 'bundle/skills/beta/empty.txt', content: '', method: 'store' },
    { name: '__MACOSX/._bundle', content: 'junk' },
    { name: 'bundle/.DS_Store', content: 'junk' },
    { name: 'bundle/skills/beta/._data.txt', content: 'junk' }
  ]));

  const plan = await planAddSource({ rootDir: root }, { input: archive });
  assert.equal(plan.input.type, 'local-zip');
  assert.equal(plan.sourceId, 'personal/publisher-package.bin');
  assert.deepEqual(plan.skills, ['skills/alpha', 'skills/beta']);
  assert.deepEqual(plan.warnings.map((warning) => warning.category), [
    'unknown-frontmatter-field',
    'missing-frontmatter',
    'missing-description'
  ]);

  await applyAddSource({ rootDir: root }, plan);
  assert.equal(
    await readFile(path.join(root, 'personal', 'publisher-package.bin', 'skills', 'beta', 'data.txt'), 'utf8'),
    'payload'
  );
  await assert.rejects(
    () => access(path.join(root, 'personal', 'publisher-package.bin', '.DS_Store')),
    /ENOENT/
  );
  assert.deepEqual(
    (await scanSkills(root)).map((skill) => skill.id),
    [
      'personal/publisher-package.bin/skills/alpha',
      'personal/publisher-package.bin/skills/beta'
    ]
  );
  assert.deepEqual(
    (await inspectSource({ rootDir: root }, 'personal/publisher-package.bin')).skills,
    ['skills/alpha', 'skills/beta']
  );
});

test('rejects a .zip filename whose content has no ZIP signature', async () => {
  const root = await makeTempDir('source-zip-signature-root-');
  const archive = path.join(await makeTempDir('source-zip-signature-input-'), 'fake.zip');
  await writeFile(archive, 'not a zip');

  await assert.rejects(
    () => planAddSource({ rootDir: root }, { input: archive }),
    /ZIP signature/
  );
  assert.deepEqual(await libraryEntries(root), []);
});

test('rejects unsafe ZIP paths, links, and special files without changing state', async (t) => {
  const cases = [
    { name: 'traversal', entry: { name: '../escape/SKILL.md', content: '# Escape\n' }, error: /traversal/i },
    { name: 'absolute', entry: { name: '/escape/SKILL.md', content: '# Escape\n' }, error: /absolute/i },
    { name: 'drive', entry: { name: 'C:/escape/SKILL.md', content: '# Escape\n' }, error: /drive-letter/i },
    {
      name: 'drive-relative',
      entry: { name: 'C:escape/SKILL.md', content: '# Escape\n' },
      error: /drive-letter/i
    },
    { name: 'backslash', entry: { name: '..\\escape\\SKILL.md', content: '# Escape\n' }, error: /backslash/i },
    {
      name: 'nul',
      entry: { name: Buffer.from('bad\0name/SKILL.md'), content: '# Escape\n' },
      error: /NUL/i
    },
    {
      name: 'symlink',
      entry: { name: 'skill/link', content: 'target', mode: 0o120777 },
      error: /symlink/i
    },
    {
      name: 'special',
      entry: { name: 'skill/fifo', content: '', mode: 0o010644 },
      error: /special file/i
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await makeTempDir(`source-zip-${fixture.name}-root-`);
      const archive = path.join(await makeTempDir(`source-zip-${fixture.name}-input-`), 'unsafe.zip');
      await writeFile(archive, buildZip([fixture.entry]));
      await assert.rejects(
        () => planAddSource({ rootDir: root }, { input: archive }),
        fixture.error
      );
      assert.deepEqual(await libraryEntries(root), []);
    });
  }
});

test('enforces ZIP entry, written-file, expanded-content, and depth limits', async (t) => {
  const cases = [
    {
      name: 'entries',
      entries: [
        { name: 'skill/SKILL.md', content: '# One\n' },
        { name: 'skill/extra.txt', content: 'two' }
      ],
      limits: { maxEntries: 1 },
      error: /entry count/i
    },
    {
      name: 'file',
      entries: [{ name: 'skill/SKILL.md', content: '123456', uncompressedSize: 1 }],
      limits: { maxFileBytes: 5 },
      error: /individual file/i
    },
    {
      name: 'expanded',
      entries: [
        { name: 'skills/a/SKILL.md', content: '1234' },
        { name: 'skills/b/SKILL.md', content: '5678' }
      ],
      limits: { maxExpandedBytes: 7 },
      error: /expanded content/i
    },
    {
      name: 'depth',
      entries: [{ name: 'a/b/c/SKILL.md', content: '# Deep\n' }],
      limits: { maxDepth: 2 },
      error: /directory depth/i
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await makeTempDir(`source-zip-limit-${fixture.name}-root-`);
      const archive = path.join(await makeTempDir(`source-zip-limit-${fixture.name}-input-`), 'limited.zip');
      await writeFile(archive, buildZip(fixture.entries));
      await assert.rejects(
        () => planAddSource({ rootDir: root, archiveLimits: fixture.limits }, { input: archive }),
        fixture.error
      );
      assert.deepEqual(await libraryEntries(root), []);
    });
  }
});

test('ZIP safety failures leave an existing library and registry byte-for-byte unchanged', async () => {
  const root = await makeTempDir('source-zip-atomic-root-');
  const existing = path.join(root, 'personal', 'existing');
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'SKILL.md'), '# Existing\n');
  const archive = path.join(await makeTempDir('source-zip-atomic-input-'), 'bad.zip');
  await writeFile(archive, buildZip([
    { name: 'valid/SKILL.md', content: '# Valid\n' },
    { name: '../escape', content: 'bad' }
  ]));
  const before = await snapshotFiles(root);

  await assert.rejects(() => planAddSource({ rootDir: root }, { input: archive }), /traversal/i);
  assert.deepEqual(await snapshotFiles(root), before);
});

async function libraryEntries(root) {
  try {
    return (await readdir(root)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function snapshotFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) await walk(entryPath);
      else files.push([relative, await readFile(entryPath, 'hex')]);
    }
  }
  await walk(root);
  return files.sort();
}
