import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRecord } from '../lib/sourceRegistry.js';
import { checksumDirectoryNormalized } from '../lib/sourceTree.js';
import { formatSyncReport, resolveSyncRepository, syncLibrary } from '../lib/librarySync.js';

const execFile = promisify(execFileCallback);

async function temp(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function git(args, cwd) {
  return execFile('git', ['-C', cwd, ...args]);
}

async function makeLibrary(base, name, content = '# Notes\n') {
  const root = path.join(base, name);
  await mkdir(root, { recursive: true });
  const source = path.join(root, 'personal', 'notes');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), content);
  await createSourceRecord(root, {
    schemaVersion: 1,
    sourceId: 'personal/notes',
    bucket: 'personal',
    type: 'local',
    installPath: 'personal/notes',
    origin: { kind: 'local', name: 'notes' },
    integrity: { algorithm: 'sha256', value: await checksumDirectoryNormalized(source) },
    skills: ['.']
  });
  return root;
}

async function makeRemote(base) {
  const remote = path.join(base, 'remote.git');
  await execFile('git', ['init', '--bare', remote]);
  return `file://${remote}`;
}

test('resolves shorthand and arbitrary Git remotes without leaking credentials', () => {
  assert.equal(resolveSyncRepository('owner/library', 'ignored'), 'https://github.com/owner/library.git');
  assert.equal(resolveSyncRepository('https://example.test/library.git', 'ignored'), 'https://example.test/library.git');
  assert.equal(resolveSyncRepository('git@example.test:team/library.git', 'ignored'), 'git@example.test:team/library.git');
});

test('pushes and pulls a source through a local bare Git remote', async () => {
  const base = await temp('library-sync-roundtrip-');
  const remote = await makeRemote(base);
  const producer = await makeLibrary(base, 'producer');
  const pushed = await syncLibrary({ rootDir: producer }, 'push', { repo: remote });
  assert.equal(pushed.changes[0].status, 'local-only');
  assert.equal(pushed.snapshots.length, 1);

  const receiver = path.join(base, 'receiver');
  await mkdir(receiver);
  const pulled = await syncLibrary({ rootDir: receiver }, 'pull', { repo: remote });
  assert.equal(pulled.applied[0].type, 'applied');
  assert.equal(await readFile(path.join(receiver, 'personal', 'notes', 'SKILL.md'), 'utf8'), '# Notes\n');
  assert.deepEqual(await readdir(path.join(receiver, '.skillcaddy', 'sources', 'personal')), ['notes.json']);
});

test('status reports checksum conflicts without changing either library', async () => {
  const base = await temp('library-sync-conflict-');
  const remote = await makeRemote(base);
  const producer = await makeLibrary(base, 'producer', '# Producer\n');
  await syncLibrary({ rootDir: producer }, 'push', { repo: remote });
  const other = await makeLibrary(base, 'other', '# Other\n');
  const result = await syncLibrary({ rootDir: other }, 'status', { repo: remote });
  assert.equal(result.changes[0].status, 'conflict');
  assert.match(formatSyncReport(result), /\[conflict\] personal\/notes/);
  assert.equal(await readFile(path.join(other, 'personal', 'notes', 'SKILL.md'), 'utf8'), '# Other\n');
});

test('unavailable default authentication returns a stable nonzero category', async () => {
  const root = await temp('library-sync-auth-');
  await assert.rejects(
    () => syncLibrary({ rootDir: root }, 'status', {
      run: async () => { throw new Error('no gh'); }
    }),
    error => error.category === 'authentication-required' && error.exitCode === 3
  );
});
