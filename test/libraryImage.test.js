import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIBRARY_IMAGE_LIMITS,
  LIBRARY_IMAGE_DENIED_ENTRY_TYPES,
  LIBRARY_IMAGE_ENTRY_TYPES,
  extractLibraryImage,
  inspectLibraryImage
} from '../lib/libraryImage.js';
import { SourceAcquisitionError } from '../lib/sourceAcquisitionError.js';
import { makeTempDir } from './testHelpers.js';
import { buildTar } from './tarFixtures.js';

test('exposes a frozen default limit shape that mirrors the local archive seam', () => {
  assert.ok(Object.isFrozen(DEFAULT_LIBRARY_IMAGE_LIMITS), 'limits must be frozen');
  assert.deepEqual(
    Object.keys(DEFAULT_LIBRARY_IMAGE_LIMITS).sort(),
    ['maxDepth', 'maxEntries', 'maxExpandedBytes', 'maxFileBytes']
  );
  assert.equal(DEFAULT_LIBRARY_IMAGE_LIMITS.maxEntries, 10_000);
  assert.equal(DEFAULT_LIBRARY_IMAGE_LIMITS.maxDepth, 40);
  assert.ok(DEFAULT_LIBRARY_IMAGE_LIMITS.maxExpandedBytes > 0);
  assert.ok(DEFAULT_LIBRARY_IMAGE_LIMITS.maxFileBytes > 0);
});

test('declares the entry-type vocabulary', () => {
  assert.ok(LIBRARY_IMAGE_ENTRY_TYPES instanceof Set);
  assert.ok(LIBRARY_IMAGE_DENIED_ENTRY_TYPES instanceof Set);
  assert.deepEqual(
    [...LIBRARY_IMAGE_ENTRY_TYPES].sort(),
    ['directory', 'file']
  );
  assert.deepEqual(
    [...LIBRARY_IMAGE_DENIED_ENTRY_TYPES].sort(),
    ['block', 'character', 'contiguous', 'fifo', 'hardlink', 'socket', 'symlink', 'unknown']
  );
  for (const denied of LIBRARY_IMAGE_DENIED_ENTRY_TYPES) {
    assert.ok(
      !LIBRARY_IMAGE_ENTRY_TYPES.has(denied),
      `denied type must not also be allowed: ${denied}`
    );
  }
});

test('inspectLibraryImage lists the entry paths the embedded tar advertises', async () => {
  const fixtureDir = await makeTempDir('library-image-list-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      imagePath,
      buildTar([
        { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
        { name: 'skills/beta/SKILL.md', content: '# Beta\n' },
        { name: 'README.md', content: '# Root\n' }
      ])
    )
  );

  const result = await inspectLibraryImage(imagePath);
  assert.deepEqual(
    result.entries.map((entry) => entry.path).sort(),
    ['README.md', 'skills/alpha/SKILL.md', 'skills/beta/SKILL.md']
  );
});

test('extractLibraryImage writes a clean baseline to staging and reports entries', async (t) => {
  const fixtureDir = await makeTempDir('library-image-baseline-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const stagingRoot = await makeTempDir('library-image-baseline-staging-');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: 'skills/beta/SKILL.md', content: '# Beta\n' },
      { name: 'skills/beta/data.txt', content: 'payload' },
      { name: 'README.md', content: '# Root\n' }
    ])
  );

  const written = await extractLibraryImage(imagePath, stagingRoot);
  const writtenRelative = written
    .map((entry) => ({ relative: path.relative(stagingRoot, entry.absPath), type: entry.type }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  assert.deepEqual(writtenRelative, [
    { relative: 'README.md', type: 'file' },
    { relative: 'skills', type: 'directory' },
    { relative: 'skills/alpha', type: 'directory' },
    { relative: 'skills/alpha/SKILL.md', type: 'file' },
    { relative: 'skills/beta', type: 'directory' },
    { relative: 'skills/beta/SKILL.md', type: 'file' },
    { relative: 'skills/beta/data.txt', type: 'file' }
  ]);

  // Staging should not have any of the support / safety junk that tar sometimes writes.
  const { readdir } = await import('node:fs/promises');
  const topLevel = (await readdir(stagingRoot)).sort();
  for (const name of topLevel) {
    assert.ok(
      !name.startsWith('.'),
      `tar should not have written a dotfile to staging: ${name}`
    );
  }
});

test('extractLibraryImage rejects images whose entry uses an absolute path', async () => {
  const fixtureDir = await makeTempDir('library-image-absolute-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const stagingRoot = await makeTempDir('library-image-absolute-staging-');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: '/etc/passwd', content: 'leaked' }
    ])
  );

  await assert.rejects(
    () => extractLibraryImage(imagePath, stagingRoot),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /outside staging/);
      assert.match(error.message, /passwd/);
      return true;
    }
  );

  // Staging must be empty (atomic-cleanup or pre-flight never wrote).
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(stagingRoot), []);
});

test('extractLibraryImage rejects images whose entry escapes staging via .. traversal', async () => {
  const fixtureDir = await makeTempDir('library-image-traversal-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const stagingRoot = await makeTempDir('library-image-traversal-staging-');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: '../../escape/SKILL.md', content: '# Out\n' }
    ])
  );

  await assert.rejects(
    () => extractLibraryImage(imagePath, stagingRoot),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /outside staging/);
      return true;
    }
  );

  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(stagingRoot), []);
});

test('extractLibraryImage cleans up staging on every rejected extraction attempt', async () => {
  // Run multiple rejection attempts; staging must remain empty after each.
  const fixtureDir = await makeTempDir('library-image-multi-attempt-');
  const { writeFile } = await import('node:fs/promises');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: '/etc/passwd', content: 'leaked' }
    ])
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stagingRoot = await makeTempDir(`library-image-retry-${attempt}-`);
    await assert.rejects(
      () => extractLibraryImage(imagePath, stagingRoot),
      (error) => {
        assert.equal(error.category, 'source-safety');
        return true;
      }
    );
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(stagingRoot), [], `attempt ${attempt}: staging should be empty`);
  }
});
