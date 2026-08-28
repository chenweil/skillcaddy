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

test('inspectLibraryImage rejects with source-safety when the allowlist is empty', async () => {
  const imagePath = path.join(await makeTempDir('library-image-stub-'), 'image.tar');
  await assert.rejects(
    () => inspectLibraryImage(imagePath),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /tar flag policy not loaded/i);
      return true;
    }
  );
});

test('extractLibraryImage rejects with source-safety when the allowlist is empty', async () => {
  const imagePath = path.join(await makeTempDir('library-image-stub-'), 'image.tar');
  const stagingRoot = await makeTempDir('library-image-stub-staging-');
  await assert.rejects(
    () => extractLibraryImage(imagePath, stagingRoot),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /tar flag policy not loaded/i);
      return true;
    }
  );
});
