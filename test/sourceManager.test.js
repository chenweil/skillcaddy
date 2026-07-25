import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource, listSources } from '../lib/sourceManager.js';
import { scanSkills } from '../lib/skillStore.js';

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

  const result = await inspectSource({ rootDir: root }, record.sourceId);

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

async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}
