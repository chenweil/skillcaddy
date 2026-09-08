import { mkdir, readlink, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import {
  DEFAULT_LIBRARY_IMAGE_LIMITS,
  LIBRARY_IMAGE_DENIED_ENTRY_TYPES,
  LIBRARY_IMAGE_ENTRY_TYPES,
  LIBRARY_IMAGE_FLAG_POLICY,
  LIBRARY_IMAGE_REQUIRED_TAR_FLAGS,
  composeExtractArgs,
  extractLibraryImage,
  inspectLibraryImage,
  resolveTarInvocation
} from '../lib/libraryImage.js';
import { SourceAcquisitionError } from '../lib/sourceAcquisitionError.js';
import { makeTempDir } from './testHelpers.js';
import { buildTar, gnuLongNameBlocks, paxRecordBlocks, rawHeaderBlock } from './tarFixtures.js';
import { buildFakeTar } from './fakeTar.js';
import * as imageWorkflow from '../lib/libraryImage.js';
import { readSourceRecords, writeSourceRecord } from '../lib/sourceRegistry.js';
import { checksumDirectory, checksumDirectoryNormalized } from '../lib/sourceTree.js';
import { updateSkillMetadata, readSkillMetadata } from '../lib/skillMetadata.js';
import { runSourceCli } from '../scripts/source.js';
import { addImageSource, git, libraryFixture } from './libraryImageFixtures.js';
import { imageAttacks } from './fixtures/library-image/attacks.js';

const execImageCommand = promisify(execFile);

async function writeImage(prefix, entries, options) {
  const dir = await makeTempDir(prefix);
  const imagePath = path.join(dir, 'image.tar');
  await writeFile(imagePath, buildTar(entries, options));
  return imagePath;
}

// staging 传一个尚不存在的路径，是生产调用方的正常用法：
// extractLibraryImage 自己创建它，失败时也只回收自己创建的那一层。
function stagingPathIn(dir, name = 'staging') {
  return path.join(dir, name);
}

async function rejectsSafety(fn, matcher) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof SourceAcquisitionError, `expected SourceAcquisitionError, got ${error}`);
    assert.equal(error.category, 'source-safety');
    if (matcher) assert.match(error.message, matcher);
    return true;
  });
}

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

test('declares the entry-type vocabulary as an allowlist plus a naming denylist', () => {
  assert.ok(LIBRARY_IMAGE_ENTRY_TYPES instanceof Set);
  assert.ok(LIBRARY_IMAGE_DENIED_ENTRY_TYPES instanceof Set);
  assert.deepEqual([...LIBRARY_IMAGE_ENTRY_TYPES].sort(), ['directory', 'file']);
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

test('inspectLibraryImage lists the entry paths and types the embedded tar advertises', async () => {
  const imagePath = await writeImage('library-image-list-', [
    { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
    { name: 'skills/beta/SKILL.md', content: '# Beta\n' },
    { name: 'README.md', content: '# Root\n' }
  ]);

  const result = await inspectLibraryImage(imagePath);
  assert.deepEqual(
    result.entries
      .map((entry) => ({ path: entry.path, type: entry.type }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    [
      { path: 'README.md', type: 'file' },
      { path: 'skills/alpha/SKILL.md', type: 'file' },
      { path: 'skills/beta/SKILL.md', type: 'file' }
    ]
  );
  assert.equal(result.totalBytes, 8 + 7 + 7);
});

test('extractLibraryImage writes a clean baseline to staging and reports entries', async () => {
  const fixtureDir = await makeTempDir('library-image-baseline-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: 'skills/beta/SKILL.md', content: '# Beta\n' },
      { name: 'skills/beta/data.txt', content: 'payload' },
      { name: 'README.md', content: '# Root\n' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

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
});

test('extractLibraryImage rejects images whose entry uses an absolute path', async () => {
  const fixtureDir = await makeTempDir('library-image-absolute-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: '/etc/passwd', content: 'leaked' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingRoot),
    /outside staging.*passwd/s
  );
  await assert.rejects(() => readdir(stagingRoot), (error) => error.code === 'ENOENT');
});

test('extractLibraryImage rejects images whose entry escapes staging via .. traversal', async () => {
  const fixtureDir = await makeTempDir('library-image-traversal-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: '../../escape/SKILL.md', content: '# Out\n' }
    ])
  );

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /outside staging/
  );
});

test('extractLibraryImage rejects traversal hidden in the USTAR prefix field', async () => {
  // The prefix field (offset 345) is prepended to the name field by real tar.
  // A pre-flight that only reads the name field would validate `passwd` while
  // tar writes `../../escaped/passwd`.
  const fixtureDir = await makeTempDir('library-image-prefix-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([{ name: 'passwd', prefix: '../../escaped', content: 'pwned' }])
  );

  const inspected = await inspectLibraryImage(imagePath);
  assert.deepEqual(
    inspected.entries.map((entry) => entry.path),
    ['../../escaped/passwd'],
    'inspect must report the prefix-joined path that tar will actually use'
  );
  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /outside staging/
  );
});

test('extractLibraryImage rejects traversal declared through a PAX path override', async () => {
  const fixtureDir = await makeTempDir('library-image-pax-escape-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      ...paxRecordBlocks({ path: '../../escaped/pwn.txt' }),
      { name: 'benign.txt', content: 'x' }
    ])
  );

  const inspected = await inspectLibraryImage(imagePath);
  assert.deepEqual(
    inspected.entries.map((entry) => entry.path),
    ['../../escaped/pwn.txt'],
    'the PAX override, not the ustar name field, is the path tar honours'
  );
  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /outside staging/
  );
});

test('inspectLibraryImage reads base-256 encoded sizes without desynchronizing the header stream', async () => {
  // A parser that only understands octal reads this size as 0 and then resumes
  // mid-payload, so every later header it reports is fiction.
  const imagePath = await writeImage('library-image-base256-', [
    { name: 'big.bin', content: Buffer.alloc(1024, 0x41), base256Size: true },
    { name: 'after.txt', content: 'ok' }
  ]);

  const result = await inspectLibraryImage(imagePath);
  assert.deepEqual(result.entries, [
    { path: 'big.bin', type: 'file', size: 1024 },
    { path: 'after.txt', type: 'file', size: 2 }
  ]);
});

test('inspectLibraryImage sees the symlink in a base-256 desync fixture that hides it from an octal-only parser', async () => {
  // Layout: a base-256 sized entry, a decoy header inside its payload claiming
  // an octal size that swallows the real trailing header, then the real symlink.
  const fixtureDir = await makeTempDir('library-image-desync-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    Buffer.concat([
      rawHeaderBlock('a.bin', 1024, { base256Size: true }),
      rawHeaderBlock('decoy.txt', 1024),
      Buffer.alloc(512, 0x2e),
      rawHeaderBlock('esc', 0, { typeflag: '2', linkname: '/tmp/outside' }),
      Buffer.alloc(1024)
    ])
  );

  const entries = (await inspectLibraryImage(imagePath)).entries;
  assert.deepEqual(entries.map((entry) => `${entry.path}:${entry.type}`), [
    'a.bin:file',
    'esc:symlink'
  ]);
  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /declares symlink entry in pre-flight/
  );
});

test('inspectLibraryImage rejects a header whose checksum does not verify', async () => {
  const imagePath = await writeImage('library-image-checksum-', [
    { name: 'a.txt', content: 'x', badChecksum: true }
  ]);
  await rejectsSafety(() => inspectLibraryImage(imagePath), /checksum mismatch/);
});

test('inspectLibraryImage rejects entries hidden after the end-of-archive marker', async () => {
  // Real tar stops at the first zero block, so anything after it is invisible to
  // extraction but would be equally invisible to a pre-flight that also stops.
  const fixtureDir = await makeTempDir('library-image-trailer-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'visible.txt', content: 'ok' },
      Buffer.alloc(512),
      rawHeaderBlock('sneaky', 0, { typeflag: '2', linkname: '/etc/passwd' })
    ])
  );

  await rejectsSafety(
    () => inspectLibraryImage(imagePath),
    /non-zero data after the end-of-archive marker/
  );
});

test('inspectLibraryImage accepts the zero padding real tar appends after the marker', async () => {
  const imagePath = await writeImage(
    'library-image-padding-',
    [{ name: 'a.txt', content: 'x' }],
    { trailer: Buffer.alloc(512 * 20) }
  );
  const result = await inspectLibraryImage(imagePath);
  assert.deepEqual(result.entries.map((entry) => entry.path), ['a.txt']);
});

test('inspectLibraryImage rejects compressed containers instead of misreading them', async () => {
  const cases = [
    { label: 'gzip', bytes: [0x1f, 0x8b, 0x08, 0x00], expected: /gzip container/ },
    { label: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], expected: /xz container/ },
    { label: 'zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd], expected: /zstd container/ },
    { label: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], expected: /zip container/ }
  ];
  for (const fixture of cases) {
    const dir = await makeTempDir(`library-image-${fixture.label}-`);
    const imagePath = path.join(dir, `image.${fixture.label}`);
    await writeFile(
      imagePath,
      Buffer.concat([Buffer.from(fixture.bytes), Buffer.alloc(2048, 0x41)])
    );
    await rejectsSafety(() => inspectLibraryImage(imagePath), fixture.expected);
  }
});

test('inspectLibraryImage resolves GNU long-name blocks to the path tar will write', async () => {
  const longPath = `skills/${'x'.repeat(120)}/SKILL.md`;
  const imagePath = await writeImage('library-image-gnu-long-', [
    ...gnuLongNameBlocks(longPath),
    { name: 'truncated-placeholder', content: 'y' }
  ]);

  const result = await inspectLibraryImage(imagePath);
  assert.deepEqual(result.entries.map((entry) => entry.path), [longPath]);
});

test('extractLibraryImage accepts a pax_global_header archive as produced by git and GitHub', async () => {
  // `git archive` and codeload tarballs both lead with a 'g' global header. An
  // implementation that maps it to an entry type rejects every real-world image.
  const fixtureDir = await makeTempDir('library-image-pax-global-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      ...paxRecordBlocks({ comment: 'abc123' }, { global: true, name: 'pax_global_header' }),
      { name: 'repo-main/', typeflag: '5' },
      { name: 'repo-main/skills/alpha/SKILL.md', content: '# Alpha\n' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

  const inspected = await inspectLibraryImage(imagePath);
  assert.deepEqual(
    inspected.entries.map((entry) => `${entry.path}:${entry.type}`),
    ['repo-main/:directory', 'repo-main/skills/alpha/SKILL.md:file'],
    'metadata blocks must be consumed by the parser, not surfaced as entries'
  );

  const written = await extractLibraryImage(imagePath, stagingRoot);
  assert.deepEqual(
    written.map((entry) => path.relative(stagingRoot, entry.absPath)).sort(),
    ['repo-main', 'repo-main/skills', 'repo-main/skills/alpha', 'repo-main/skills/alpha/SKILL.md']
  );
});

test('extractLibraryImage tolerates duplicate entries, which tar resolves as overwrite', async () => {
  const fixtureDir = await makeTempDir('library-image-duplicate-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'dup.txt', content: 'one' },
      { name: 'dup.txt', content: 'two' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

  const written = await extractLibraryImage(imagePath, stagingRoot);
  assert.deepEqual(written.map((entry) => path.relative(stagingRoot, entry.absPath)), ['dup.txt']);
  assert.equal(await readFile(path.join(stagingRoot, 'dup.txt'), 'utf8'), 'two');
});

test('extractLibraryImage ignores macOS packaging junk when reconciling written entries', async () => {
  const fixtureDir = await makeTempDir('library-image-mac-junk-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/._SKILL.md', content: 'AppleDouble' },
      { name: 'skills/.DS_Store', content: 'finder' },
      { name: 'skills/SKILL.md', content: '# Alpha\n' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

  const written = await extractLibraryImage(imagePath, stagingRoot);
  const relative = written.map((entry) => path.relative(stagingRoot, entry.absPath));
  assert.ok(relative.includes('skills/SKILL.md'), 'the real skill file must be staged');
});

test('extractLibraryImage rejects tarballs whose entries include symlinks (symlink-first escape)', async () => {
  const fixtureDir = await makeTempDir('library-image-symlink-first-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  // Image advertises: file, symlink `escape` -> `etc/escape`, then file `escape/leak.txt`.
  // Without the symlink-type rejection tar would create the symlink first, then write
  // `escape/leak.txt` to the resolved target — far outside staging.
  await writeFile(
    imagePath,
    buildTar([
      { name: 'README.md', content: '# Root\n' },
      { name: 'escape', typeflag: '2', linkname: 'etc/escape' },
      { name: 'escape/leak.txt', content: 'leaked' }
    ])
  );

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /symlink/i
  );
});

test('extractLibraryImage rejects tarballs whose entries include hardlinks (hardlink escape)', async () => {
  const fixtureDir = await makeTempDir('library-image-hardlink-escape-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: 'evil', typeflag: '1', linkname: '/etc/passwd' }
    ])
  );

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
    /hardlink/i
  );
});

test('extractLibraryImage rejects tarballs declaring FIFO / char / block / contiguous entries', async () => {
  const cases = [
    { name: 'fifo', typeflag: '6', label: /fifo/i },
    { name: 'character-device', typeflag: '3', label: /character/i },
    { name: 'block-device', typeflag: '4', label: /block/i },
    { name: 'contiguous-file', typeflag: '7', label: /contiguous/i },
    { name: 'socket-entry', typeflag: 'S', label: /socket/i }
  ];

  for (const fixture of cases) {
    const fixtureDir = await makeTempDir(`library-image-${fixture.name}-`);
    const imagePath = path.join(fixtureDir, 'image.tar');
    await writeFile(
      imagePath,
      buildTar([
        { name: 'README.md', content: '# Root\n' },
        { name: fixture.name, typeflag: fixture.typeflag }
      ])
    );

    await rejectsSafety(
      () => extractLibraryImage(imagePath, stagingPathIn(fixtureDir)),
      fixture.label
    );
  }
});

test('inspectLibraryImage surfaces type info that pre-flight uses to reject denied types', async () => {
  const imagePath = await writeImage('library-image-inspect-types-', [
    { name: 'legit.md', content: 'legit' },
    { name: 'evil-link', typeflag: '2', linkname: '/etc/escape' }
  ]);

  const result = await inspectLibraryImage(imagePath);
  const types = new Set(result.entries.map((entry) => entry.type));
  assert.ok(types.has('file'), 'expected a file entry');
  assert.ok(types.has('symlink'), 'expected a symlink entry to be reported as such');
});

test('every declared limit has an enforcement point', async () => {
  const manyEntries = Array.from({ length: 12 }, (unused, index) => ({
    name: `f${index}.txt`,
    content: 'x'
  }));
  const manyPath = await writeImage('library-image-limit-entries-', manyEntries);
  await rejectsSafety(
    () => inspectLibraryImage(manyPath, { imageLimits: { maxEntries: 5 } }),
    /entry count exceeds limit 5/
  );
  await rejectsSafety(
    () => inspectLibraryImage(manyPath, { imageLimits: { maxExpandedBytes: 5 } }),
    /expanded size exceeds limit 5/
  );

  const oversizedPath = await writeImage('library-image-limit-file-', [
    { name: 'b.bin', content: '', sizeOverride: 4096 }
  ]);
  await rejectsSafety(
    () => inspectLibraryImage(oversizedPath, { imageLimits: { maxFileBytes: 1024 } }),
    /exceeds max file size 1024/
  );

  const deepDir = await makeTempDir('library-image-limit-depth-');
  const deepPath = path.join(deepDir, 'image.tar');
  await writeFile(deepPath, buildTar([{ name: `${'a/'.repeat(6)}f.txt`, content: 'x' }]));
  await rejectsSafety(
    () => extractLibraryImage(deepPath, stagingPathIn(deepDir), { imageLimits: { maxDepth: 3 } }),
    /directory depth exceeds limit 3/
  );
});

test('resolveLimits rejects a nonsensical limit override instead of silently accepting it', async () => {
  const imagePath = await writeImage('library-image-limit-invalid-', [
    { name: 'a.txt', content: 'x' }
  ]);
  await rejectsSafety(
    () => inspectLibraryImage(imagePath, { imageLimits: { maxEntries: 0 } }),
    /invalid library image limit maxEntries/
  );
});

test('extractLibraryImage refuses a non-empty staging root instead of deleting its contents', async () => {
  // Regression guard: recursive mkdir cannot tell "I created this" from "the
  // caller passed the wrong path", so an unconditional rm on the failure path
  // destroys caller data.
  const fixtureDir = await makeTempDir('library-image-staging-guard-');
  const preciousRoot = path.join(fixtureDir, 'precious');
  await mkdir(preciousRoot, { recursive: true });
  await writeFile(path.join(preciousRoot, 'important.txt'), 'user data');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'x.txt', content: 'x' }]));

  await rejectsSafety(
    () => extractLibraryImage(imagePath, preciousRoot),
    /staging root must be empty/
  );
  assert.equal(
    await readFile(path.join(preciousRoot, 'important.txt'), 'utf8'),
    'user data',
    'pre-existing caller data must survive a rejected extraction'
  );
});

test('extractLibraryImage cleans up staging on every rejected extraction attempt', async () => {
  // The rejection here happens after staging is created, so the cleanup path is
  // genuinely exercised — a fixture rejected during pre-flight would never reach it.
  const fixtureDir = await makeTempDir('library-image-multi-attempt-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'README.md', content: '# Root\n' }]));
  const fakeTar = await buildFakeTar({
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n',
    stderr: 'simulated extract failure\n',
    exitCode: 2
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stagingRoot = stagingPathIn(fixtureDir, `staging-${attempt}`);
    await rejectsSafety(
      () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar }),
      /simulated extract failure/
    );
    await assert.rejects(
      () => readdir(stagingRoot),
      (error) => error.code === 'ENOENT',
      `attempt ${attempt}: a staging root created by this call must be removed`
    );
  }
});

test('extractLibraryImage empties but preserves a staging root the caller supplied', async () => {
  const fixtureDir = await makeTempDir('library-image-caller-staging-');
  const stagingRoot = path.join(fixtureDir, 'provided');
  await mkdir(stagingRoot, { recursive: true });
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'README.md', content: '# Root\n' }]));
  const fakeTar = await buildFakeTar({
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n',
    stderr: 'simulated extract failure\n',
    exitCode: 2
  });

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar }),
    /simulated extract failure/
  );
  assert.ok((await stat(stagingRoot)).isDirectory(), 'a caller-owned directory must not be removed');
  assert.deepEqual(await readdir(stagingRoot), [], 'its contents must still be cleaned up');
});

test('extractLibraryImage rejects staged paths that pre-flight never advertised', async () => {
  // The fake tar exits 0 without writing anything the library image declared, and drops
  // an extra file instead. Both post-flight properties must fire.
  const fixtureDir = await makeTempDir('library-image-postflight-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'declared.txt', content: 'x' }]));
  const stagingRoot = stagingPathIn(fixtureDir);
  const fakeTar = await buildFakeTar({
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n'
  });

  // tar "succeeds" but writes nothing: the completeness property must fire.
  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar }),
    /did not write/
  );
});

test('extractLibraryImage rejects a library image whose directory permissions would blind post-flight', async () => {
  // A mode 0000 directory extracts fine but cannot be traversed, leaving part of
  // staging unverified. Silently skipping it would be a hole in the walk.
  const fixtureDir = await makeTempDir('library-image-locked-dir-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'locked', typeflag: '5', mode: 0o000 },
      { name: 'locked/inner.txt', content: 'x' }
    ])
  );
  const stagingRoot = stagingPathIn(fixtureDir);

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingRoot),
    /cannot traverse staged directory/
  );
  await assert.rejects(
    () => readdir(stagingRoot),
    (error) => error.code === 'ENOENT',
    'cleanup must still reclaim a staging tree containing an unreadable directory'
  );
});

test('flag policy exposes common, bsdtar, and gnutar subsets and is fully frozen', () => {
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.common));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.bsdtar));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.gnutar));
  assert.ok(LIBRARY_IMAGE_FLAG_POLICY.common.length > 0, 'common must carry portable flags');
  assert.ok(
    LIBRARY_IMAGE_FLAG_POLICY.common.includes('--no-same-owner'),
    'GNU tar restores archive uid/gid when run as root unless --no-same-owner is passed'
  );
  assert.ok(
    LIBRARY_IMAGE_FLAG_POLICY.bsdtar.includes('--no-mac-metadata'),
    '--no-mac-metadata is bsdtar-only; it must live under bsdtar so GNU tar never receives it'
  );
  assert.ok(
    !LIBRARY_IMAGE_FLAG_POLICY.common.includes('--no-mac-metadata'),
    'bsdtar-only flag must never appear in common'
  );
  assert.deepEqual(LIBRARY_IMAGE_FLAG_POLICY.gnutar, [
    '--no-selinux', '--no-overwrite-dir', '--delay-directory-restore'
  ]);
});

test('LIBRARY_IMAGE_REQUIRED_TAR_FLAGS covers the portable common subset', () => {
  assert.deepEqual(
    [...LIBRARY_IMAGE_REQUIRED_TAR_FLAGS],
    [...LIBRARY_IMAGE_FLAG_POLICY.common],
    'the constant keeps the portable contract stable for first-time readers'
  );
  assert.ok(
    LIBRARY_IMAGE_REQUIRED_TAR_FLAGS.length > 0,
    'release-gate contract: tar flag allowlist is no longer empty'
  );
  for (const flag of LIBRARY_IMAGE_REQUIRED_TAR_FLAGS) {
    assert.ok(flag.startsWith('--'), `flag must be long-form: ${flag}`);
  }
});

test('composeExtractArgs surfaces flags before the mode flag and the operands', () => {
  const invocation = {
    binary: '/usr/bin/tar',
    flags: ['--no-acls', '--no-xattrs'],
    implementation: 'bsdtar',
    version: 'bsdtar 3.5.3'
  };
  const args = composeExtractArgs({
    invocation,
    filePath: '/tmp/image.tar',
    stagingRoot: '/tmp/staging'
  });
  assert.deepEqual(args, [
    '--no-acls',
    '--no-xattrs',
    '-xf',
    '/tmp/image.tar',
    '-C',
    '/tmp/staging'
  ]);
});

test('resolveTarInvocation detects bsdtar and returns the combined common + bsdtar flag set', async () => {
  const workingDir = await makeTempDir('library-image-resolve-bsdtar-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n'
  });

  const invocation = await resolveTarInvocation(fakeTar);
  assert.equal(invocation.implementation, 'bsdtar');
  assert.match(invocation.version, /bsdtar/);
  assert.ok(invocation.flags.includes('--no-acls'));
  assert.ok(invocation.flags.includes('--no-same-owner'));
  assert.ok(
    invocation.flags.includes('--no-mac-metadata'),
    'bsdtar-only macOS skip flags must be wired through resolveTarInvocation'
  );
  assert.deepEqual(
    JSON.parse((await readFile(argvLogPath, 'utf8')).trim()),
    ['--version'],
    'buildFakeTar options must configure the double without relying on ambient env vars'
  );
});

test('resolveTarInvocation detects GNU tar and refuses to leak bsdtar-only flags', async () => {
  const fakeTar = await buildFakeTar({ versionOutput: 'tar (GNU tar) 1.35\n' });

  const invocation = await resolveTarInvocation(fakeTar);
  assert.equal(invocation.implementation, 'gnutar');
  assert.match(invocation.version, /GNU tar/);
  assert.ok(invocation.flags.includes('--no-acls'));
  assert.ok(invocation.flags.includes('--no-same-owner'));
  assert.ok(
    !invocation.flags.includes('--no-mac-metadata'),
    'macOS-only flag must never reach GNU tar — it would error out'
  );
  assert.ok(
    !invocation.flags.includes('--no-fflags'),
    'BSD-only flag must never reach GNU tar — it would error out'
  );
});

test('resolveTarInvocation fails closed on an unrecognized tar implementation', async () => {
  const fakeTar = await buildFakeTar({ versionOutput: 'libfake-1.0 (third party)\n' });
  await rejectsSafety(() => resolveTarInvocation(fakeTar), /unknown tar implementation/i);
});

test('resolveTarInvocation fails closed when the version probe itself fails', async () => {
  const fakeTar = await buildFakeTar({ versionOutput: '', versionExit: 3 });
  await rejectsSafety(() => resolveTarInvocation(fakeTar), /--version probe failed \(exit 3\)/);
});

test('buildFakeTar rejects unknown options so test configuration cannot be silently dropped', async () => {
  await assert.rejects(
    () => buildFakeTar({ notAnOption: true }),
    /unknown options: notAnOption/
  );
});

test('extractLibraryImage spawn propagates non-zero tar exit into source-safety', async () => {
  const workingDir = await makeTempDir('library-image-extract-exit-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n',
    stderr: 'simulated extract failure\n',
    exitCode: 2
  });
  const imagePath = path.join(workingDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'README.md', content: '# Root\n' }]));
  const stagingRoot = stagingPathIn(workingDir);

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar }),
    /simulated extract failure/
  );

  await assert.rejects(
    () => readdir(stagingRoot),
    (error) => error.code === 'ENOENT',
    'staging must be removed after a tar exit-code failure'
  );

  const argvLines = (await readFile(argvLogPath, 'utf8')).trim().split('\n');
  const lastArgv = JSON.parse(argvLines[argvLines.length - 1]);
  assert.ok(
    lastArgv.includes('--no-acls') && lastArgv.includes('--no-same-owner'),
    `argv must carry the portable flag set, got: ${JSON.stringify(lastArgv)}`
  );
  assert.ok(lastArgv.includes('-xf'));
});

test('GNU tar extraction spawn receives every hardened flag and never absolute-names', async () => {
  const workingDir = await makeTempDir('library-image-gnu-extract-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'tar (GNU tar) 1.35\n',
    stderr: 'stop after argv capture\n',
    exitCode: 2
  });
  const imagePath = path.join(workingDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'README.md', content: '# Root\n' }]));

  await rejectsSafety(
    () => extractLibraryImage(imagePath, stagingPathIn(workingDir), { tarPath: fakeTar }),
    /stop after argv capture/
  );

  const argvLines = (await readFile(argvLogPath, 'utf8')).trim().split('\n');
  const extractArgv = JSON.parse(argvLines.at(-1));
  for (const flag of [
    '--no-acls',
    '--no-xattrs',
    '--no-same-permissions',
    '--no-same-owner',
    '--no-selinux',
    '--no-overwrite-dir',
    '--delay-directory-restore'
  ]) {
    assert.ok(extractArgv.includes(flag), `missing GNU hardened flag: ${flag}`);
  }
  assert.ok(!extractArgv.includes('--absolute-names'));
  assert.ok(!extractArgv.includes('-P'));
});

test('absolute-names harness cannot turn an absolute member into an /etc write', async (t) => {
  const sentinel = `/etc/skillcaddy-library-image-${process.pid}-${Date.now()}`;
  assert.equal(await existsImagePath(sentinel), false);
  const imagePath = await writeImage('library-image-absolute-names-', [
    { name: sentinel, content: 'must not escape\n' }
  ]);
  const previousTarOptions = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = '--absolute-names';
  t.after(() => {
    if (previousTarOptions === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = previousTarOptions;
  });

  await rejectsSafety(
    () => extractLibraryImage(imagePath, `${imagePath}-out`),
    /outside staging|absolute/i
  );
  assert.equal(await existsImagePath(sentinel), false);
});

test('export preserves filesystem exit code when tar is unavailable', async () => {
  const fixture = await libraryFixture();
  const report = [];
  await assert.rejects(
    () => imageWorkflow.exportLibraryImage(
      { ...fixture, tarPath: path.join(fixture.base, 'missing-tar'), report: (message) => report.push(message) },
      fixture.imagePath
    ),
    (error) => {
      assert.equal(error.category, 'filesystem');
      assert.equal(error.exitCode, 3);
      return true;
    }
  );
  assert.ok(report.some((message) => message.startsWith('[fail] export:')));
  assert.equal(await existsImagePath(fixture.imagePath), false);
});

test('extractLibraryImage treats a hanging tar extract as a source-safety timeout', async () => {
  // hangVersion stays off so the version probe completes and the timeout being
  // measured is the extract call's, using the caller's timeoutMs rather than the
  // 30s default.
  const workingDir = await makeTempDir('library-image-extract-timeout-');
  const fakeTar = await buildFakeTar({
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n',
    hang: true
  });
  const imagePath = path.join(workingDir, 'image.tar');
  await writeFile(imagePath, buildTar([{ name: 'README.md', content: '# Root\n' }]));

  const startedAt = Date.now();
  await rejectsSafety(
    () =>
      extractLibraryImage(imagePath, stagingPathIn(workingDir), {
        tarPath: fakeTar,
        timeoutMs: 250
      }),
    /timed out after 250ms/
  );
  assert.ok(
    Date.now() - startedAt < 10_000,
    'the caller timeout must apply to the extract spawn, not fall back to the 30s default'
  );
});

test('resolveTarInvocation applies the caller timeout to the version probe', async () => {
  const fakeTar = await buildFakeTar({ hang: true, hangVersion: true });
  const startedAt = Date.now();
  await rejectsSafety(
    () => resolveTarInvocation(fakeTar, { timeoutMs: 250 }),
    /timed out after 250ms/
  );
  assert.ok(Date.now() - startedAt < 10_000, 'probe must honour the caller timeout');
});

for (const mode of [0o4755, 0o2755, 0o1777]) {
  test(`rejects privileged mode ${mode.toString(8)} before extraction`, async () => {
    const imagePath = await writeImage('library-image-mode-', [{ name: 'file', content: 'x', mode }]);
    await rejectsSafety(() => extractLibraryImage(imagePath, `${imagePath}-out`));
  });
}


test('exports a private gzip library image with manifest first and complete source records', async () => {
  const fixture = await libraryFixture();
  const result = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  assert.equal(result.path, fixture.imagePath);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  const { stdout } = await execImageCommand(process.env.LIBRARY_IMAGE_TAR_PATH || 'tar', ['-tzf', result.path]);
  assert.equal(stdout.split('\n')[0], 'library-image.json');
  assert.ok(stdout.includes('personal/alpha/SKILL.md'));
  const manifest = JSON.parse((await execImageCommand('tar', ['-xOzf', result.path, 'library-image.json'])).stdout);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.sources, [{ sourceId: fixture.record.sourceId, installPath: fixture.record.installPath }]);
  assert.deepEqual(manifest.producer, { commit: await git(fixture.rootDir, 'rev-parse', 'HEAD'), branch: 'refs/heads/main', dirty: false, pushed: true });
  assert.deepEqual(Object.keys(manifest.declarations).sort(), [
    'gitSourceMode',
    'noAbsolutePaths',
    'noContiguousEntries',
    'noEntriesAfterEnd',
    'noExternalHardlinks',
    'noPrivilegedModes',
    'noSpecialFiles',
    'noSymlinkEscape',
    'noTraversal'
  ]);
  for (const [key, value] of Object.entries(manifest.declarations)) {
    if (key !== 'gitSourceMode') assert.equal(value, true, `${key} must be declared`);
  }
  assert.deepEqual(manifest.declarations.gitSourceMode, { headRecords: [] });
  assert.equal(manifest.gitSourceMode.noIntegrityBaseline, true);
  assert.equal(await existsImagePath(path.join(fixture.rootDir, '.skillcaddy/staging')), false);
});
async function existsImagePath(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}


test('imports offline sources through acquisition and reruns without replacing receiver sidecars', async () => {
  const fixture = await libraryFixture();
  const exported = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  const context = { ...fixture, rootDir: receiver };
  const result = await imageWorkflow.importLibraryImage(context, fixture.imagePath, { yes: true });
  assert.deepEqual(result.sources.map(item => item.status), ['added']);
  assert.deepEqual(await readSourceRecords(receiver), [fixture.record]);
  assert.equal(await checksumDirectory(path.join(receiver, fixture.record.installPath)), fixture.record.integrity.value);
  const again = await imageWorkflow.importLibraryImage(context, fixture.imagePath, { yes: true });
  assert.deepEqual(again.sources.map(item => item.status), ['already-installed']);
  assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(receiver, '.skillcaddy/library-image-import.json'))),
    exported.manifest.producer
  );
});

test('restores a missing source directory while preserving its receiver registry record', async () => {
  const fixture = await libraryFixture();
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'missing-source-receiver');
  await mkdir(receiver);
  await mkdir(path.join(receiver, '.skillcaddy/sources/personal'), { recursive: true });
  await writeFile(
    path.join(receiver, '.skillcaddy/sources/personal/alpha.json'),
    `${JSON.stringify(fixture.record, null, 2)}\n`
  );
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.equal(result.sources[0].status, 'added');
  assert.equal(await checksumDirectory(path.join(receiver, fixture.record.installPath)), fixture.record.integrity.value);
  assert.deepEqual(await readSourceRecords(receiver), [fixture.record]);
});

test('logs a conflicting receiver sidecar when restoring its missing source directory', async () => {
  const fixture = await libraryFixture();
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'sidecar-receiver');
  await mkdir(path.join(receiver, '.skillcaddy/sources/personal'), { recursive: true });
  const receiverRecord = { ...fixture.record, skills: ['other'] };
  await writeFile(
    path.join(receiver, '.skillcaddy/sources/personal/alpha.json'),
    `${JSON.stringify(receiverRecord, null, 2)}\n`
  );
  const report = [];
  const result = await imageWorkflow.importLibraryImage(
    { ...fixture, rootDir: receiver, report: (message) => report.push(message) },
    fixture.imagePath,
    { yes: true }
  );
  assert.equal(result.sources[0].status, 'added');
  assert.ok(report.some((message) => message.includes('receiver source sidecar wins: personal/alpha')));
  assert.deepEqual(await readSourceRecords(receiver), [receiverRecord]);
});


test('roundtrips library-relative live and dead symlinks without dereferencing them', async () => {
  const fixture = await libraryFixture();
  const source = path.join(fixture.rootDir, fixture.record.installPath);
  await symlink('SKILL.md', path.join(source, 'live'));
  await symlink('missing.md', path.join(source, 'dead'));
  fixture.record.integrity.value = await checksumDirectory(source);
  await writeSourceRecord(fixture.rootDir, fixture.record);
  const report = [];
  await imageWorkflow.exportLibraryImage(
    { ...fixture, report: (message) => report.push(message) },
    fixture.imagePath
  );
  assert.ok(report.some((message) => message.includes('[warn] dead-symlink: personal/alpha/dead')));
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.equal(await readlink(path.join(receiver, fixture.record.installPath, 'dead')), 'missing.md');
  assert.equal(await checksumDirectory(path.join(receiver, fixture.record.installPath)), fixture.record.integrity.value);
});


test('plans and fills user enablements, preserving aliases and receiver metadata', async (t) => {
  const fixture = await libraryFixture();
  const oldHome = process.env.HOME; process.env.HOME = fixture.home;
  t.after(() => { process.env.HOME = oldHome; });
  await mkdir(fixture.globalDir, { recursive: true });
  const source = path.join(fixture.rootDir, fixture.record.installPath);
  await symlink(source, path.join(fixture.globalDir, 'alpha'));
  await symlink(source, path.join(fixture.globalDir, 'skillcaddy-manager'));
  await updateSkillMetadata(fixture.rootDir, { skillPath: source, note: 'producer' });
  const { manifest } = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  assert.deepEqual(manifest.enablement, [{ scope: 'global', libraryPath: fixture.record.installPath, alias: 'alpha' }]);
  await rm(path.join(fixture.globalDir, 'alpha'));
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  const context = { ...fixture, rootDir: receiver };
  const dry = await imageWorkflow.importLibraryImage(context, fixture.imagePath, { dryRun: true });
  assert.equal(dry.enablement[0].disposition, 'create');
  assert.equal(await existsImagePath(path.join(receiver, 'personal/alpha')), false);
  const result = await imageWorkflow.importLibraryImage(context, fixture.imagePath, { yes: true });
  assert.equal(result.enablement[0].disposition, 'create');
  assert.equal(await readlink(path.join(fixture.globalDir, 'alpha')), path.join(receiver, fixture.record.installPath));
  assert.equal((await readSkillMetadata(receiver, path.join(receiver, fixture.record.installPath))).note, 'producer');
  await updateSkillMetadata(receiver, { skillPath: path.join(receiver, fixture.record.installPath), note: 'receiver' });
  const again = await imageWorkflow.importLibraryImage(context, fixture.imagePath, { yes: true });
  assert.equal(again.enablement[0].disposition, 'unchanged');
  assert.equal((await readSkillMetadata(receiver, path.join(receiver, fixture.record.installPath))).note, 'receiver');
});


test('repo-local library image CLI exports, dry-runs and confirms import with strict arguments', async () => {
  const fixture = await libraryFixture();
  let stdout = ''; let stderr = '';
  const io = { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } };
  assert.equal(await runSourceCli({ ...fixture, ...io, argv: ['image', 'export', fixture.imagePath] }), 0);
  assert.equal(stdout, `${fixture.imagePath}\n`);
  assert.match(stderr, /\[pass\]/);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  assert.equal(await runSourceCli({ ...fixture, ...io, rootDir: receiver, argv: ['image', 'import', fixture.imagePath, '--dry-run'] }), 0);
  assert.match(stderr, /\[ready\] personal\/alpha/);
  assert.equal((await readSourceRecords(receiver)).length, 0);
  assert.equal(await runSourceCli({ ...fixture, ...io, rootDir: receiver, argv: ['image', 'import', fixture.imagePath], confirm: () => false }), 0);
  assert.equal((await readSourceRecords(receiver)).length, 0);
  assert.equal(await runSourceCli({ ...fixture, ...io, rootDir: receiver, argv: ['image', 'import', fixture.imagePath, '--yes'] }), 0);
  assert.match(stderr, /\[added\] personal\/alpha/);
  for (const args of [['export', fixture.imagePath, '--yes'], ['import', fixture.imagePath, '--json'], ['import', 'image.tgz'], ['export']]) {
    assert.equal(await runSourceCli({ ...fixture, ...io, argv: ['image', ...args] }), 2);
  }
  assert.equal(await runSourceCli({ ...fixture, ...io, argv: ['image', 'export', fixture.imagePath] }), 1);
  assert.equal(await runSourceCli({ ...fixture, ...io, argv: ['image', 'import', path.join(fixture.base, 'absent.tar.gz'), '--yes'] }), 3);
});

for (const [name, change] of [
  ['installing marker', async (fixture) => writeFile(path.join(fixture.rootDir, fixture.record.installPath, '.skillcaddy-installing'), 'pending')],
  ['staging residue', async (fixture) => mkdir(path.join(fixture.rootDir, '.skillcaddy/staging/interrupted'), { recursive: true })],
  ['unregistered source', async (fixture) => mkdir(path.join(fixture.rootDir, 'personal/unregistered'))],
  ['missing source', async (fixture) => rm(path.join(fixture.rootDir, fixture.record.installPath), { recursive: true })],
  ['integrity drift', async (fixture) => writeFile(path.join(fixture.rootDir, fixture.record.installPath, 'SKILL.md'), 'drift')],
  ['dirty repository', async (fixture) => writeFile(path.join(fixture.rootDir, 'untracked'), 'dirty')],
  ['unpushed commit', async (fixture) => git(fixture.rootDir, 'commit', '--allow-empty', '-m', 'unpushed')]
]) {
  test(`export rejects ${name} without producing an archive`, async () => {
    const fixture = await libraryFixture(); await change(fixture);
    await assert.rejects(() => imageWorkflow.exportLibraryImage(fixture, fixture.imagePath), { category: 'export-blocked' });
    assert.equal(await existsImagePath(fixture.imagePath), false);
  });
}

test('staging residue reports a named failure and recovery pointer', async () => {
  const fixture = await libraryFixture();
  await mkdir(path.join(fixture.rootDir, '.skillcaddy/staging/interrupted'), { recursive: true });
  const report = [];
  await assert.rejects(
    () => imageWorkflow.exportLibraryImage(
      { ...fixture, report: (message) => report.push(message) },
      fixture.imagePath
    ),
    (error) => {
      assert.equal(error.category, 'export-blocked');
      assert.match(error.message, /^staging-residue:/);
      assert.match(error.message, /Inspect \.skillcaddy\/staging\//);
      return true;
    }
  );
  assert.ok(report.some((message) => message.startsWith('[fail] staging-residue:')));
});

test('submits independent sources in stable dependency-safe sourceId order', async () => {
  const fixture = await libraryFixture();
  await addImageSource(fixture.rootDir, 'zeta');
  await addImageSource(fixture.rootDir, 'beta');
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'ordered-receiver');
  await mkdir(receiver);
  const result = await imageWorkflow.importLibraryImage(
    { ...fixture, rootDir: receiver },
    fixture.imagePath,
    { yes: true }
  );
  assert.deepEqual(
    result.sources.map((source) => source.sourceId),
    ['personal/alpha', 'personal/beta', 'personal/zeta']
  );
});

test('partial source submit reports three lists and rerunning preserves committed bytes', async () => {
  const fixture = await libraryFixture();
  const beta = await addImageSource(fixture.rootDir, 'beta');
  await addImageSource(fixture.rootDir, 'gamma');
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await addImageSource(receiver, 'beta');
  await writeFile(path.join(receiver, beta.installPath, 'SKILL.md'), 'receiver drift');
  await assert.rejects(() => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true }), error => {
    assert.equal(error.category, 'image-source-mismatch');
    assert.match(error.message, /committed: personal\/alpha\nuncommitted: personal\/beta\nunattempted: personal\/gamma/);
    return true;
  });
  assert.equal((await readSourceRecords(receiver)).length, 2);
  assert.equal(await readFile(path.join(receiver, beta.installPath, 'SKILL.md'), 'utf8'), 'receiver drift');
  assert.equal((await readdir(path.join(receiver, '.skillcaddy/staging'))).length, 1);
  await writeFile(path.join(receiver, beta.installPath, 'SKILL.md'), await readFile(path.join(fixture.rootDir, beta.installPath, 'SKILL.md')));
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.deepEqual(result.sources.map(item => item.status), ['already-installed', 'already-installed', 'added']);
  assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
});

test('cleans a preserved transaction when its resumed phase-one staging is corrupt', async () => {
  const fixture = await libraryFixture();
  const beta = await addImageSource(fixture.rootDir, 'beta');
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await addImageSource(receiver, 'beta');
  await writeFile(path.join(receiver, beta.installPath, 'SKILL.md'), 'receiver drift');
  let error;
  await assert.rejects(
    () => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true }),
    (candidate) => { error = candidate; return true; }
  );
  const match = error.message.match(/Staging preserved: (.+)\. Re-run/);
  assert.ok(match);
  await writeFile(path.join(match[1], 'image.tar'), 'corrupt');
  await assert.rejects(
    () => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true }),
    { category: 'image-staging-verify-failed' }
  );
  assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
});

async function baselineImageEntries(fixture) {
  const { manifest } = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  return [
    { name: 'library-image.json', content: JSON.stringify(manifest) },
    { name: '.skillcaddy/sources/personal/alpha.json', content: JSON.stringify(fixture.record) },
    { name: 'personal/alpha/SKILL.md', content: await readFile(path.join(fixture.rootDir, 'personal/alpha/SKILL.md')) }
  ];
}
for (const [name, attack] of imageAttacks) {
  test(`import preflight rejects ${name} with a valid manifest and leaves no staging`, async () => {
    const fixture = await libraryFixture();
    const baseline = await baselineImageEntries(fixture);
    const image = path.join(fixture.base, 'attack.tar.gz');
    await writeFile(image, gzipSync(buildTar([...baseline, ...attack])));
    const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
    await assert.rejects(() => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }), { category: 'image-preflight-failed' });
    assert.deepEqual(await readSourceRecords(receiver), []);
    assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
  });
}

test('a byte-built baseline imports and non-Git tampering fails the checksum gate', async () => {
  const fixture = await libraryFixture(); const baseline = await baselineImageEntries(fixture);
  const image = path.join(fixture.base, 'baseline.tar.gz');
  await writeFile(image, gzipSync(buildTar(baseline)));
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true });
  baseline[2].content = 'tampered';
  await writeFile(image, gzipSync(buildTar(baseline)));
  await assert.rejects(() => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }), { category: 'source-validation' });
  assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
});

test('Git sources carry full repositories, verify HEAD, and have no integrity baseline', async () => {
  const fixture = await libraryFixture();
  const source = path.join(fixture.rootDir, 'github/example/repo'); await mkdir(source, { recursive: true });
  await git(source, 'init', '-b', 'main');
  await writeFile(path.join(source, 'SKILL.md'), '# Git source\n');
  await git(source, 'add', 'SKILL.md'); await git(source, 'commit', '-m', 'source');
  const head = await git(source, 'rev-parse', 'HEAD');
  const record = { schemaVersion: 1, sourceId: 'github/example/repo', installPath: 'github/example/repo', bucket: 'github', type: 'git', origin: { kind: 'git', remote: 'https://github.com/example/repo.git', commit: head }, skills: ['.'] };
  await writeSourceRecord(fixture.rootDir, record);
  await writeFile(path.join(source, 'local-note'), 'carry dirty nested Git bytes too');
  const { manifest } = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  assert.deepEqual(manifest.declarations.gitSourceMode.headRecords, [{ sourceId: record.sourceId, head }]);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.equal(await git(path.join(receiver, record.installPath), 'rev-parse', 'HEAD'), head);
  assert.equal((await readSourceRecords(receiver))[0].integrity, undefined);
  assert.equal(await readFile(path.join(receiver, record.installPath, 'local-note'), 'utf8'), 'carry dirty nested Git bytes too');
});

test('an existing Git source with the same HEAD keeps receiver working-tree changes', async () => {
  const fixture = await libraryFixture();
  const source = path.join(fixture.rootDir, 'github/example/repo'); await mkdir(source, { recursive: true });
  await git(source, 'init', '-b', 'main');
  await writeFile(path.join(source, 'SKILL.md'), '# Git source\n');
  await git(source, 'add', 'SKILL.md'); await git(source, 'commit', '-m', 'source');
  const head = await git(source, 'rev-parse', 'HEAD');
  const record = { schemaVersion: 1, sourceId: 'github/example/repo', installPath: 'github/example/repo', bucket: 'github', type: 'git', origin: { kind: 'git', remote: 'https://github.com/example/repo.git' }, skills: ['.'] };
  await writeSourceRecord(fixture.rootDir, record);
  const { imagePath } = fixture;
  await imageWorkflow.exportLibraryImage(fixture, imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, imagePath, { yes: true });
  await writeFile(path.join(receiver, record.installPath, 'receiver-only.txt'), 'keep me');
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, imagePath, { yes: true });
  assert.equal(result.sources.find((item) => item.sourceId === record.sourceId).status, 'already-installed');
  assert.equal(await git(path.join(receiver, record.installPath), 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(receiver, record.installPath, 'receiver-only.txt'), 'utf8'), 'keep me');
});

test('confirmation rechecks scope identity and refuses a changed directory before submission', async (t) => {
  const fixture = await libraryFixture(); const oldHome = process.env.HOME; process.env.HOME = fixture.home;
  t.after(() => { process.env.HOME = oldHome; });
  await mkdir(fixture.globalDir, { recursive: true });
  await symlink(path.join(fixture.rootDir, fixture.record.installPath), path.join(fixture.globalDir, 'alpha'));
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await assert.rejects(() => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { confirm: async () => {
    await rm(fixture.globalDir, { recursive: true }); await mkdir(fixture.globalDir); return true;
  } }), { category: 'stale-plan' });
  assert.deepEqual(await readSourceRecords(receiver), []);
});

test('HOME changes reject stale explicit targets per triple and retain imported sources', async (t) => {
  const fixture = await libraryFixture(); const oldHome = process.env.HOME; process.env.HOME = fixture.home;
  t.after(() => { process.env.HOME = oldHome; });
  await mkdir(fixture.globalDir, { recursive: true });
  await symlink(path.join(fixture.rootDir, fixture.record.installPath), path.join(fixture.globalDir, 'alpha'));
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  const nextHome = path.join(fixture.base, 'new-home'); await mkdir(nextHome);
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { confirm: () => {
    process.env.HOME = nextHome; return true;
  } });
  assert.equal(result.enablement[0].disposition, 'unsatisfiable');
  assert.equal((await readSourceRecords(receiver)).length, 1);
});

test('post-pack drift removes its temporary archive and never publishes a destination', async () => {
  const fixture = await libraryFixture();
  const wrapper = path.join(fixture.base, 'tar-wrapper.mjs');
  await writeFile(wrapper, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nimport { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst result = spawnSync('tar', args, { stdio: 'inherit' });\nif (args.includes('-czf')) {\n  appendFileSync(${JSON.stringify(path.join(fixture.rootDir, 'personal/alpha/SKILL.md'))}, 'drift');\n  mkdirSync(${JSON.stringify(path.join(fixture.rootDir, 'personal/new'))}, { recursive: true });\n  writeFileSync(${JSON.stringify(path.join(fixture.rootDir, 'personal/new/SKILL.md'))}, 'new source');\n}\nprocess.exit(result.status);\n`, { mode: 0o755 });
  await assert.rejects(() => imageWorkflow.exportLibraryImage({ ...fixture, tarPath: wrapper }, fixture.imagePath), { category: 'export-blocked' });
  assert.equal(await existsImagePath(fixture.imagePath), false);
  assert.equal(await existsImagePath(path.join(fixture.rootDir, '.skillcaddy/staging')), false);
  assert.deepEqual((await readdir(fixture.base)).filter(name => name.endsWith('.tmp')), []);
});

test('ambient TAR_OPTIONS cannot add absolute-names or execute a checkpoint action', async (t) => {
  const fixture = await libraryFixture();
  const old = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = '--absolute-names --checkpoint=1 --checkpoint-action=exec=false';
  t.after(() => { if (old === undefined) delete process.env.TAR_OPTIONS; else process.env.TAR_OPTIONS = old; });
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.equal((await readSourceRecords(receiver)).length, 1);
});

test('enablement collisions never rename and Hermes ineligibility stays closed', async (t) => {
  const fixture = await libraryFixture(); const oldHome = process.env.HOME; process.env.HOME = fixture.home;
  t.after(() => { process.env.HOME = oldHome; });
  await mkdir(fixture.globalDir, { recursive: true }); await mkdir(fixture.hermesDir, { recursive: true });
  const baseline = await baselineImageEntries(fixture);
  const manifest = JSON.parse(baseline[0].content);
  manifest.enablement = [
    { scope: 'global', alias: 'occupied-link', libraryPath: 'personal/alpha' },
    { scope: 'global', alias: 'occupied-file', libraryPath: 'personal/alpha' },
    { scope: 'global', alias: 'missing', libraryPath: 'personal/missing' },
    { scope: 'hermes', alias: 'retired', libraryPath: 'archived/retired' },
    { scope: 'global', alias: 'skillcaddy-manager', libraryPath: 'personal/alpha' }
  ];
  const retired = { ...fixture.record, sourceId: 'archived/retired', installPath: 'archived/retired', bucket: 'archived' };
  manifest.sources.unshift({ sourceId: retired.sourceId, installPath: retired.installPath });
  baseline[0].content = JSON.stringify(manifest);
  baseline.push({ name: '.skillcaddy/sources/archived/retired.json', content: JSON.stringify(retired) }, { name: 'archived/retired/SKILL.md', content: baseline[2].content });
  const image = path.join(fixture.base, 'conflicts.tar.gz'); await writeFile(image, gzipSync(buildTar(baseline)));
  await symlink(fixture.rootDir, path.join(fixture.globalDir, 'occupied-link'));
  await writeFile(path.join(fixture.globalDir, 'occupied-file'), 'keep');
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true });
  assert.deepEqual(result.enablement.map(item => item.disposition), ['conflict:other-target', 'conflict:not-a-symlink', 'unsatisfiable', 'ineligible']);
  assert.deepEqual((await readdir(fixture.globalDir)).sort(), ['occupied-file', 'occupied-link']);
  assert.equal(await readFile(path.join(fixture.globalDir, 'occupied-file'), 'utf8'), 'keep');
});

test('PAX size controls payload consumption rather than exposing a header inside file bytes', async () => {
  const fakeHeaderPayload = rawHeaderBlock('../not-an-entry', 0);
  const imagePath = await writeImage('image-pax-size-', [
    ...paxRecordBlocks({ size: '512' }),
    { name: 'data.bin', sizeOverride: 0, content: fakeHeaderPayload },
    { name: 'next', content: 'safe' }
  ]);
  const inspection = await inspectLibraryImage(imagePath);
  assert.deepEqual(inspection.entries.map(item => item.path), ['data.bin', 'next']);
  const staging = `${imagePath}-out`;
  await extractLibraryImage(imagePath, staging);
  assert.deepEqual(await readFile(path.join(staging, 'data.bin')), fakeHeaderPayload);
});

test('a staged Git HEAD mismatch rejects the library image before any source submission', async () => {
  const fixture = await libraryFixture(); const baseline = await baselineImageEntries(fixture);
  const record = { schemaVersion: 1, sourceId: 'github/example/repo', installPath: 'github/example/repo', bucket: 'github', type: 'git', origin: { kind: 'git', remote: 'https://github.com/example/repo.git' }, skills: ['.'] };
  const manifest = JSON.parse(baseline[0].content);
  manifest.sources.unshift({ sourceId: record.sourceId, installPath: record.installPath });
  manifest.declarations.gitSourceMode.headRecords = [{ sourceId: record.sourceId, head: '1'.repeat(40) }];
  baseline[0].content = JSON.stringify(manifest);
  baseline.push({ name: '.skillcaddy/sources/github/example/repo.json', content: JSON.stringify(record) },
    { name: 'github/example/repo/SKILL.md', content: '# source' },
    { name: 'github/example/repo/.git/HEAD', content: `${'2'.repeat(40)}\n` },
    { name: 'github/example/repo/.git/objects', typeflag: '5' },
    { name: 'github/example/repo/.git/refs', typeflag: '5' });
  const image = path.join(fixture.base, 'git-mismatch.tar.gz'); await writeFile(image, gzipSync(buildTar(baseline)));
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await assert.rejects(() => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }), { category: 'source-validation' });
  assert.deepEqual(await readSourceRecords(receiver), []);
  assert.equal(await existsImagePath(path.join(receiver, '.skillcaddy/staging')), false);
});

test('library image extraction accepts in-library hardlinks and rejects a planted staging symlink', async () => {
  const fixture = await libraryFixture(); const baseline = await baselineImageEntries(fixture);
  baseline.push({ name: 'personal/alpha/copy', typeflag: '1', linkname: 'personal/alpha/SKILL.md' });
  const source = path.join(fixture.rootDir, 'personal/alpha'); await writeFile(path.join(source, 'copy'), baseline[2].content);
  fixture.record.integrity.value = await checksumDirectory(source);
  baseline[1].content = JSON.stringify(fixture.record);
  const image = path.join(fixture.base, 'hardlink.tar.gz'); await writeFile(image, gzipSync(buildTar(baseline)));
  const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true });
  assert.equal(await checksumDirectory(path.join(receiver, 'personal/alpha')), fixture.record.integrity.value);
  const staging = path.join(fixture.base, 'planted'); await mkdir(staging);
  await symlink(receiver, path.join(staging, 'personal'));
  const rawTarPath = path.join(fixture.base, 'raw.tar'); await writeFile(rawTarPath, buildTar(baseline));
  await assert.rejects(() => extractLibraryImage(rawTarPath, staging, { libraryLayout: true }), { category: 'source-safety' });
  assert.equal(await readlink(path.join(staging, 'personal')), receiver);
});

test('normalizes decomposed archive path segments to NFC before checksum validation', async () => {
  const fixture = await libraryFixture();
  const nfcName = 'café.md';
  const nfdName = nfcName.normalize('NFD');
  const source = path.join(fixture.rootDir, fixture.record.installPath);
  await writeFile(path.join(source, nfcName), 'accent\n');
  fixture.record.integrity.value = await checksumDirectory(source);
  await writeSourceRecord(fixture.rootDir, fixture.record);
  const { manifest } = await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const entries = [
    { name: 'library-image.json', content: JSON.stringify(manifest) },
    { name: 'personal/alpha/SKILL.md', content: await readFile(path.join(source, 'SKILL.md')) },
    { name: '.skillcaddy/sources/personal/alpha.json', content: JSON.stringify(fixture.record) }
  ];
  entries.push({ name: `personal/alpha/${nfdName}`, content: 'accent\n' });
  const image = path.join(fixture.base, 'nfd.tar.gz');
  await writeFile(image, gzipSync(buildTar(entries)));
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true });
  assert.equal(await existsImagePath(path.join(receiver, 'personal/alpha', nfcName)), true);
  assert.equal(await checksumDirectoryNormalized(path.join(receiver, 'personal/alpha')), fixture.record.integrity.value);
});

test('normalizes decomposed registry skill paths at the acquisition seam', async () => {
  const fixture = await libraryFixture();
  const source = path.join(fixture.rootDir, fixture.record.installPath);
  const skillName = 'café';
  const skillPath = path.join(source, skillName);
  await rm(path.join(source, 'SKILL.md'));
  await mkdir(skillPath);
  await writeFile(path.join(skillPath, 'SKILL.md'), '---\ndescription: accent\n---\n# Accent\n');
  fixture.record.skills = [skillName.normalize('NFD')];
  fixture.record.integrity.value = await checksumDirectory(source);
  await writeSourceRecord(fixture.rootDir, fixture.record);
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  const result = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  assert.equal(result.sources[0].status, 'added');
  assert.equal(await existsImagePath(path.join(receiver, fixture.record.installPath, skillName)), true);
});

test('rejects a symlink that crosses from one registered source into another', async () => {
  const fixture = await libraryFixture();
  const entries = await baselineImageEntries(fixture);
  entries.push(
    { name: 'personal/alpha/cross-source', typeflag: '2', linkname: '../other' }
  );
  const image = path.join(fixture.base, 'cross-source-link.tar.gz');
  await writeFile(image, gzipSync(buildTar(entries)));
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  await assert.rejects(
    () => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }),
    { category: 'image-staging-verify-failed' }
  );
  assert.deepEqual(await readSourceRecords(receiver), []);
});

test('rejects a malformed enablement triple before committing any source', async () => {
  const fixture = await libraryFixture();
  const entries = await baselineImageEntries(fixture);
  const manifest = JSON.parse(entries[0].content);
  manifest.enablement = [{ scope: 'project', libraryPath: 'personal/alpha', alias: 'alpha' }];
  entries[0].content = JSON.stringify(manifest);
  const image = path.join(fixture.base, 'malformed-enablement.tar.gz');
  await writeFile(image, gzipSync(buildTar(entries)));
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  await assert.rejects(
    () => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }),
    { category: 'image-preflight-failed' }
  );
  assert.deepEqual(await readSourceRecords(receiver), []);
});

test('rejects an empty staged source even when its recorded checksum matches', async () => {
  const fixture = await libraryFixture();
  const emptySource = path.join(fixture.base, 'empty-source');
  await mkdir(emptySource);
  const emptyRecord = {
    ...fixture.record,
    integrity: { algorithm: 'sha256', value: await checksumDirectory(emptySource) },
    skills: ['.']
  };
  const manifest = (await baselineImageEntries(fixture))[0].content;
  const entries = [
    { name: 'library-image.json', content: manifest },
    { name: '.skillcaddy/sources/personal/alpha.json', content: JSON.stringify(emptyRecord) },
    { name: 'personal/alpha', typeflag: '5' }
  ];
  const image = path.join(fixture.base, 'empty-source.tar.gz');
  await writeFile(image, gzipSync(buildTar(entries)));
  const receiver = path.join(fixture.base, 'receiver');
  await mkdir(receiver);
  await assert.rejects(
    () => imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, image, { yes: true }),
    { category: 'source-validation' }
  );
  assert.deepEqual(await readSourceRecords(receiver), []);
});
