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
import { buildTar } from './tarFixtures.js';
import { buildFakeTar } from './fakeTar.js';

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

test('inspectLibraryImage lists the entry paths and types the embedded tar advertises', async () => {
  const fixtureDir = await makeTempDir('library-image-list-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: 'skills/beta/SKILL.md', content: '# Beta\n' },
      { name: 'README.md', content: '# Root\n' }
    ])
  );

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
});

test('extractLibraryImage writes a clean baseline to staging and reports entries', async () => {
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
  assert.deepEqual(await (await import('node:fs/promises')).readdir(stagingRoot), []);
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
  assert.deepEqual(await (await import('node:fs/promises')).readdir(stagingRoot), []);
});

test('extractLibraryImage cleans up staging on every rejected extraction attempt', async () => {
  const fixtureDir = await makeTempDir('library-image-multi-attempt-');
  const { writeFile, readdir } = await import('node:fs/promises');
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
    assert.deepEqual(await readdir(stagingRoot), [], `attempt ${attempt}: staging should be empty`);
  }
});

test('extractLibraryImage rejects tarballs whose entries include symlinks (symlink-first escape)', async () => {
  const fixtureDir = await makeTempDir('library-image-symlink-first-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const stagingRoot = await makeTempDir('library-image-symlink-first-staging-');
  const { writeFile, readdir } = await import('node:fs/promises');
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

  await assert.rejects(
    () => extractLibraryImage(imagePath, stagingRoot),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /symlink/i);
      return true;
    }
  );
  assert.deepEqual(await readdir(stagingRoot), []);
});

test('extractLibraryImage rejects tarballs whose entries include hardlinks (hardlink escape)', async () => {
  const fixtureDir = await makeTempDir('library-image-hardlink-escape-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const stagingRoot = await makeTempDir('library-image-hardlink-escape-staging-');
  const { writeFile, readdir } = await import('node:fs/promises');
  // Adversary prepends a benign regular file (so the link target exists inside the
  // archive) and then declares a hardlink whose linkname escapes the staging root.
  await writeFile(
    imagePath,
    buildTar([
      { name: 'skills/alpha/SKILL.md', content: '# Alpha\n' },
      { name: 'evil', typeflag: '1', linkname: '/etc/passwd' }
    ])
  );

  await assert.rejects(
    () => extractLibraryImage(imagePath, stagingRoot),
    (error) => {
      assert.ok(error instanceof SourceAcquisitionError);
      assert.equal(error.category, 'source-safety');
      assert.match(error.message, /hardlink/i);
      return true;
    }
  );
  assert.deepEqual(await readdir(stagingRoot), []);
});

test('extractLibraryImage rejects tarballs whose entries include FIFO / char / block devices', async () => {
  const cases = [
    { name: 'fifo', typeflag: '6', label: /fifo/i },
    { name: 'character-device', typeflag: '3', label: /character/i },
    { name: 'block-device', typeflag: '4', label: /block/i }
  ];

  for (const fixture of cases) {
    await test(fixture.name, async () => {
      const fixtureDir = await makeTempDir(`library-image-${fixture.name}-`);
      const imagePath = path.join(fixtureDir, 'image.tar');
      const stagingRoot = await makeTempDir(`library-image-${fixture.name}-staging-`);
      const { writeFile, readdir } = await import('node:fs/promises');
      await writeFile(
        imagePath,
        buildTar([
          { name: 'README.md', content: '# Root\n' },
          { name: fixture.name, typeflag: fixture.typeflag }
        ])
      );

      await assert.rejects(
        () => extractLibraryImage(imagePath, stagingRoot),
        (error) => {
          assert.ok(error instanceof SourceAcquisitionError);
          assert.equal(error.category, 'source-safety');
          assert.match(error.message, fixture.label);
          return true;
        }
      );
      assert.deepEqual(await readdir(stagingRoot), []);
    });
  }
});

test('inspectLibraryImage surfaces type info that pre-flight uses to reject denied types', async () => {
  const fixtureDir = await makeTempDir('library-image-inspect-types-');
  const imagePath = path.join(fixtureDir, 'image.tar');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'legit.md', content: 'legit' },
      { name: 'evil-link', typeflag: '2', linkname: '/etc/escape' }
    ])
  );

  const result = await inspectLibraryImage(imagePath);
  const types = new Set(result.entries.map((entry) => entry.type));
  assert.ok(types.has('file'), 'expected a file entry');
  assert.ok(types.has('symlink'), 'expected a symlink entry to be reported as such');
});

test('flag policy exposes common, bsdtar, and gnutar subsets and is fully frozen', () => {
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.common));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.bsdtar));
  assert.ok(Object.isFrozen(LIBRARY_IMAGE_FLAG_POLICY.gnutar));
  assert.ok(Array.isArray(LIBRARY_IMAGE_FLAG_POLICY.common));
  assert.ok(LIBRARY_IMAGE_FLAG_POLICY.common.length > 0, 'common must carry at least one portable flag');
  assert.ok(Array.isArray(LIBRARY_IMAGE_FLAG_POLICY.bsdtar));
  assert.ok(LIBRARY_IMAGE_FLAG_POLICY.bsdtar.length > 0, 'bsdtar subset must list at least one macOS-only flag');
  assert.ok(Array.isArray(LIBRARY_IMAGE_FLAG_POLICY.gnutar));
  // gnutar starts empty: GNU tar is verified against the empty policy on the
  // host runtime until #33's research identifies a GNU-specific safety flag.
  assert.ok(LIBRARY_IMAGE_FLAG_POLICY.gnutar.length === 0,
    'gnutar subset starts empty; populate only when research validates GNU-tar-specific flags');
  assert.ok(LIBRARY_IMAGE_FLAG_POLICY.bsdtar.includes('--no-mac-metadata'),
    '--no-mac-metadata is bsdtar-only; it must live under bsdtar so GNU tar never receives it');
  assert.ok(!LIBRARY_IMAGE_FLAG_POLICY.common.includes('--no-mac-metadata'),
    'bsdtar-only flag must never appear in common');
});

test('LIBRARY_IMAGE_REQUIRED_TAR_FLAGS aliases the portable common subset', () => {
  assert.equal(
    LIBRARY_IMAGE_REQUIRED_TAR_FLAGS,
    LIBRARY_IMAGE_FLAG_POLICY.common,
    'the alias keeps the constant stable for first-time readers and avoids platform drift'
  );
  assert.ok(
    LIBRARY_IMAGE_REQUIRED_TAR_FLAGS.length > 0,
    'release-gate contract: tar flag allowlist is no longer empty'
  );
  // Common flags must be cross-platform neutral so the literal can be trusted on either BSD or GNU.
  for (const flag of LIBRARY_IMAGE_REQUIRED_TAR_FLAGS) {
    assert.ok(flag.startsWith('--'), `flag must be long-form: ${flag}`);
  }
});

test('composeExtractArgs surfaces flags before the mode flag and the operands', () => {
  const invocation = {
    binary: '/usr/bin/tar',
    flags: ['--no-acls', '--no-xattrs', '--no-same-permissions'],
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
    '--no-same-permissions',
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
  process.env.FAKE_TAR_ARGV_LOG = argvLogPath;
  process.env.FAKE_TAR_VERSION = 'bsdtar 3.5.3 - libarchive 3.7.4\n';
  try {
    const invocation = await resolveTarInvocation(fakeTar);
    assert.equal(invocation.implementation, 'bsdtar');
    assert.match(invocation.version, /bsdtar/);
    assert.ok(invocation.flags.includes('--no-acls'));
    assert.ok(invocation.flags.includes('--no-mac-metadata'),
      'bsdtar-only macOS skip flags must be wired through resolveTarInvocation');
  } finally {
    delete process.env.FAKE_TAR_ARGV_LOG;
    delete process.env.FAKE_TAR_VERSION;
  }
});

test('resolveTarInvocation detects GNU tar and refuses to leak bsdtar-only flags', async () => {
  const workingDir = await makeTempDir('library-image-resolve-gnutard-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'tar (GNU tar) 1.35\n'
  });
  process.env.FAKE_TAR_ARGV_LOG = argvLogPath;
  process.env.FAKE_TAR_VERSION = 'tar (GNU tar) 1.35\n';
  try {
    const invocation = await resolveTarInvocation(fakeTar);
    assert.equal(invocation.implementation, 'gnutard');
    assert.match(invocation.version, /GNU tar/);
    assert.ok(invocation.flags.includes('--no-acls'));
    assert.ok(
      !invocation.flags.includes('--no-mac-metadata'),
      'macOS-only flag must never reach GNU tar — it would error out'
    );
    assert.ok(
      !invocation.flags.includes('--no-fflags'),
      'BSD-only flag must never reach GNU tar — it would error out'
    );
  } finally {
    delete process.env.FAKE_TAR_ARGV_LOG;
    delete process.env.FAKE_TAR_VERSION;
  }
});

test('resolveTarInvocation fails closed on an unrecognized tar implementation', async () => {
  const workingDir = await makeTempDir('library-image-resolve-unknown-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'libfake-1.0 (third party)\n'
  });
  process.env.FAKE_TAR_ARGV_LOG = argvLogPath;
  process.env.FAKE_TAR_VERSION = 'libfake-1.0 (third party)\n';
  try {
    await assert.rejects(
      () => resolveTarInvocation(fakeTar),
      (error) => {
        assert.ok(error instanceof SourceAcquisitionError);
        assert.equal(error.category, 'source-safety');
        assert.match(error.message, /unknown tar implementation/i);
        return true;
      }
    );
  } finally {
    delete process.env.FAKE_TAR_ARGV_LOG;
    delete process.env.FAKE_TAR_VERSION;
  }
});

test('extractLibraryImage spawn propagates non-zero tar exit into source-safety', async () => {
  const workingDir = await makeTempDir('library-image-extract-exit-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  // The fake tar advertises bsdtar so resolveTarInvocation succeeds, then exits 2.
  const fakeTar = await buildFakeTar({
    argvLogPath,
    versionOutput: 'bsdtar 3.5.3 - libarchive 3.7.4\n',
    stderr: 'simulated extract failure\n',
    exitCode: 2
  });
  const imageDir = await makeTempDir('library-image-extract-exit-image-');
  const imagePath = path.join(imageDir, 'image.tar');
  const { writeFile, readdir, readFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'README.md', content: '# Root\n' }
    ])
  );
  const stagingRoot = await makeTempDir('library-image-extract-exit-staging-');

  process.env.FAKE_TAR_ARGV_LOG = argvLogPath;
  process.env.FAKE_TAR_VERSION = 'bsdtar 3.5.3 - libarchive 3.7.4\n';
  process.env.FAKE_TAR_VERSION_EXIT = '0';
  process.env.FAKE_TAR_STDERR = 'simulated extract failure\n';
  process.env.FAKE_TAR_EXIT = '2';
  try {
    await assert.rejects(
      () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar }),
      (error) => {
        assert.ok(error instanceof SourceAcquisitionError);
        assert.equal(error.category, 'source-safety');
        assert.match(error.message, /simulated extract failure/);
        return true;
      }
    );

    // Atomic cleanup is on the source-safety path: stagingRoot is removed
    // entirely (verified by the ENOENT caught here).
    await assert.rejects(
      () => readdir(stagingRoot),
      (error) => error.code === 'ENOENT',
      'staging must be removed after a tar exit-code failure'
    );
    const argvLines = (await readFile(argvLogPath, 'utf8')).trim().split('\n');
    // Last invocation is the extract call (after the version probe).
    const lastArgv = JSON.parse(argvLines[argvLines.length - 1]);
    assert.ok(lastArgv.includes('--no-acls'),
      `argv must carry the portable flag set, got: ${JSON.stringify(lastArgv)}`);
    assert.ok(lastArgv.includes('-xf'));
  } finally {
    delete process.env.FAKE_TAR_ARGV_LOG;
    delete process.env.FAKE_TAR_VERSION;
    delete process.env.FAKE_TAR_VERSION_EXIT;
    delete process.env.FAKE_TAR_STDERR;
    delete process.env.FAKE_TAR_EXIT;
  }
});

test('extractLibraryImage treats a hanging tar as a source-safety timeout', async () => {
  const workingDir = await makeTempDir('library-image-extract-timeout-');
  const argvLogPath = path.join(workingDir, 'argv.log');
  const fakeTar = await buildFakeTar();
  const imageDir = await makeTempDir('library-image-extract-timeout-image-');
  const imagePath = path.join(imageDir, 'image.tar');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    imagePath,
    buildTar([
      { name: 'README.md', content: '# Root\n' }
    ])
  );
  const stagingRoot = await makeTempDir('library-image-extract-timeout-staging-');

  process.env.FAKE_TAR_ARGV_LOG = argvLogPath;
  process.env.FAKE_TAR_VERSION = 'bsdtar 3.5.3 - libarchive 3.7.4\n';
  process.env.FAKE_TAR_VERSION_EXIT = '0';
  process.env.FAKE_TAR_HANG = '1';
  try {
    await assert.rejects(
      () => extractLibraryImage(imagePath, stagingRoot, { tarPath: fakeTar, timeoutMs: 250 }),
      (error) => {
        assert.ok(error instanceof SourceAcquisitionError);
        assert.equal(error.category, 'source-safety');
        assert.match(error.message, /timed out/i);
        return true;
      }
    );
  } finally {
    delete process.env.FAKE_TAR_ARGV_LOG;
    delete process.env.FAKE_TAR_VERSION;
    delete process.env.FAKE_TAR_VERSION_EXIT;
    delete process.env.FAKE_TAR_HANG;
  }
});
