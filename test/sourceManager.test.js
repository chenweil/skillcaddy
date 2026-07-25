import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource, listSources } from '../lib/sourceManager.js';
import { scanSkills } from '../lib/skillStore.js';
import { makeTempDir } from './testHelpers.js';

test('lists registered and unmanaged source entries without changing skill discovery', async () => {
  const root = await makeTempDir('source-list-');
  const registeredPath = path.join(root, 'github', 'existing-checkout');
  const unmanagedPath = path.join(root, 'personal', 'manual-source');

  await writeSkill(registeredPath, 'review');
  await writeSkill(unmanagedPath, 'notes');
  await writeSourceRecord(root, gitSourceRecord());

  const filesBefore = await snapshotFiles(root);
  const skillsBefore = await scanSkills(root);

  const result = await listSources({ rootDir: root });

  assert.deepEqual(result.sources, [
    {
      inventoryId: 'github/example/review-skills',
      status: 'registered',
      sourceId: 'github/example/review-skills',
      installPath: 'github/existing-checkout',
      exists: true
    },
    {
      inventoryId: 'unmanaged:personal/manual-source',
      status: 'unmanaged',
      sourceId: null,
      installPath: 'personal/manual-source',
      exists: true
    }
  ]);
  assert.deepEqual(await scanSkills(root), skillsBefore);
  assert.deepEqual(await snapshotFiles(root), filesBefore);
});

test('inspects sanitized registered source provenance and source-owned facts', async () => {
  const root = await makeTempDir('source-inspect-');
  const project = await makeTempDir('source-inspect-project-');
  const record = gitSourceRecord({
    origin: {
      kind: 'git',
      remote: 'https://token:secret@example.com/org/review-skills.git?token=hidden#fragment',
      ref: 'main',
      commit: '0123456789abcdef0123456789abcdef01234567'
    },
    integrity: {
      algorithm: 'sha256',
      value: 'a'.repeat(64)
    }
  });

  await writeSkill(path.join(root, record.installPath), 'review');
  await writeSourceRecord(root, record);
  await writeSkill(path.join(project, '.agents', 'skills', 'linked-review'), 'nested');
  const rootFilesBefore = await snapshotFiles(root);
  const projectFilesBefore = await snapshotFiles(project);

  const result = await inspectSource({ rootDir: root, projectPath: project }, record.sourceId);

  assert.deepEqual(result, {
    schemaVersion: 1,
    sourceId: 'github/example/review-skills',
    bucket: 'github',
    type: 'git',
    installPath: 'github/existing-checkout',
    origin: {
      kind: 'git',
      remote: 'https://example.com/org/review-skills.git',
      ref: 'main',
      commit: '0123456789abcdef0123456789abcdef01234567'
    },
    integrity: {
      algorithm: 'sha256',
      value: 'a'.repeat(64)
    },
    skills: ['skills/review']
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.deepEqual(await snapshotFiles(root), rootFilesBefore);
  assert.deepEqual(await snapshotFiles(project), projectFilesBefore);
});

test('sanitizes SCP-style Git provenance and rejects unsafe refs', async () => {
  const root = await makeTempDir('source-git-origin-');
  await writeSourceRecord(root, gitSourceRecord({
    origin: {
      kind: 'git',
      remote: 'token@example.com:org/review-skills.git?token=hidden#fragment',
      ref: 'main'
    }
  }));

  const result = await inspectSource({ rootDir: root }, 'github/example/review-skills');
  assert.equal(result.origin.remote, 'example.com:org/review-skills.git');

  const unsafeRoot = await makeTempDir('source-git-ref-');
  await writeSourceRecord(unsafeRoot, gitSourceRecord({
    origin: {
      kind: 'git',
      remote: 'git@example.com:org/review-skills.git',
      ref: 'main?token=hidden'
    }
  }));
  await assert.rejects(
    () => inspectSource({ rootDir: unsafeRoot }, 'github/example/review-skills'),
    /Invalid origin.ref/
  );

  const invalidRemoteRoot = await makeTempDir('source-git-remote-');
  await writeSourceRecord(invalidRemoteRoot, gitSourceRecord({
    origin: {
      kind: 'git',
      remote: '/tmp/local-repository',
      ref: 'main'
    }
  }));
  await assert.rejects(
    () => inspectSource({ rootDir: invalidRemoteRoot }, 'github/example/review-skills'),
    /Invalid Git source origin/
  );
});

test('accepts sanitized HTTP Archive provenance', async () => {
  const root = await makeTempDir('source-http-archive-');
  const record = {
    schemaVersion: 1,
    sourceId: 'official/example-skills',
    bucket: 'official',
    type: 'archive',
    installPath: 'official/example-skills',
    origin: {
      kind: 'http',
      display: 'http://downloads.example.com/example.zip?signature=hidden#fragment'
    },
    integrity: {
      algorithm: 'sha256',
      value: 'c'.repeat(64)
    },
    skills: ['review']
  };
  await writeSourceRecord(root, record);

  const result = await inspectSource({ rootDir: root }, record.sourceId);
  assert.equal(result.origin.display, 'http://downloads.example.com/example.zip');
});

test('rejects unsupported registry schemas, invalid identities, and escaping install paths', async (t) => {
  const cases = [
    {
      name: 'unsupported schema',
      record: gitSourceRecord({ schemaVersion: 2 }),
      error: /Unsupported source record schemaVersion: 2/
    },
    {
      name: 'invalid identity',
      record: gitSourceRecord({ sourceId: 'github/../outside' }),
      error: /Invalid sourceId/
    },
    {
      name: 'escaping install path',
      record: gitSourceRecord({ installPath: '../outside' }),
      error: /installPath must stay inside the central-library root/
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await makeTempDir('source-invalid-');
      await writeSourceRecordAt(root, 'github/example/review-skills', fixture.record);

      await assert.rejects(() => listSources({ rootDir: root }), fixture.error);
    });
  }
});

test('rejects an existing install path that resolves outside the central-library root', async () => {
  const root = await makeTempDir('source-symlink-root-');
  const outside = await makeTempDir('source-symlink-outside-');
  const installPath = path.join(root, 'personal', 'escaped-source');

  await mkdir(path.dirname(installPath), { recursive: true });
  await symlink(outside, installPath, 'dir');
  await writeSourceRecord(root, {
    schemaVersion: 1,
    sourceId: 'personal/escaped-source',
    bucket: 'personal',
    type: 'legacy-local',
    installPath: 'personal/escaped-source',
    origin: { kind: 'unknown' },
    skills: ['review']
  });

  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'personal/escaped-source'),
    /installPath resolves outside the central-library root/
  );
});

test('rejects a missing install path below a symlinked ancestor outside the root', async () => {
  const root = await makeTempDir('source-ancestor-root-');
  const outside = await makeTempDir('source-ancestor-outside-');

  await symlink(outside, path.join(root, 'personal'), 'dir');
  await writeSourceRecord(root, {
    schemaVersion: 1,
    sourceId: 'personal/missing-source',
    bucket: 'personal',
    type: 'legacy-local',
    installPath: 'personal/missing-source',
    origin: { kind: 'unknown' },
    skills: ['review']
  });

  await assert.rejects(
    () => listSources({ rootDir: root }),
    /installPath resolves outside the central-library root/
  );
});

function gitSourceRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'github/example/review-skills',
    bucket: 'github',
    type: 'git',
    installPath: 'github/existing-checkout',
    origin: {
      kind: 'git',
      remote: 'https://example.com/org/review-skills.git',
      ref: 'main',
      commit: '0123456789abcdef0123456789abcdef01234567'
    },
    skills: ['skills/review'],
    ...overrides
  };
}

async function writeSkill(sourcePath, name) {
  const skillPath = path.join(sourcePath, 'skills', name);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), `# ${name}\n`);
}

async function writeSourceRecord(root, record) {
  return writeSourceRecordAt(root, record.sourceId, record);
}

async function writeSourceRecordAt(root, sourceId, record) {
  const filePath = path.join(root, '.skillcaddy', 'sources', `${sourceId}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

async function snapshotFiles(root) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push([relativePath, await readFile(fullPath, 'utf8')]);
      }
    }
  }

  await walk(root);
  return files;
}
