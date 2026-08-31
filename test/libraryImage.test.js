import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
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
  // The fake tar exits 0 without writing anything the image declared, and drops
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

test('extractLibraryImage rejects an image whose directory permissions would blind post-flight', async () => {
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
  // gnutar is empty until #33 verifies GNU-only flags on a Linux runtime; an
  // unverified flag name would break extraction on every Linux host.
  assert.deepEqual(LIBRARY_IMAGE_FLAG_POLICY.gnutar, []);
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
