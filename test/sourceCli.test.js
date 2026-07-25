import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceCli } from '../scripts/source.js';

test('source CLI lists inventory through the source-management boundary', async () => {
  const root = await makeTempDir('source-cli-list-');
  await mkdir(path.join(root, 'personal', 'manual-source'), { recursive: true });

  const output = captureOutput();
  const exitCode = await runSourceCli({ argv: ['list'], rootDir: root, ...output.streams });

  assert.equal(exitCode, 0);
  assert.match(output.stdout(), /\[unmanaged\] unmanaged:personal\/manual-source/);
  assert.match(output.stdout(), /install: personal\/manual-source/);
  assert.equal(output.stderr(), '');
});

test('source CLI inspects one registered source and rejects missing arguments', async () => {
  const root = await makeTempDir('source-cli-inspect-');
  const record = {
    schemaVersion: 1,
    sourceId: 'personal/local-notes',
    bucket: 'personal',
    type: 'local',
    installPath: 'personal/notes-on-disk',
    origin: { kind: 'local', name: 'notes' },
    integrity: { algorithm: 'sha256', value: 'b'.repeat(64) },
    skills: ['notes']
  };
  const recordPath = path.join(root, '.skillcaddy', 'sources', 'personal', 'local-notes.json');

  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record)}\n`);

  const inspectOutput = captureOutput();
  assert.equal(
    await runSourceCli({
      argv: ['inspect', 'personal/local-notes'],
      rootDir: root,
      ...inspectOutput.streams
    }),
    0
  );
  assert.match(inspectOutput.stdout(), /source: personal\/local-notes/);
  assert.match(inspectOutput.stdout(), /origin: local notes/);
  assert.match(inspectOutput.stdout(), /integrity: sha256 /);
  assert.match(inspectOutput.stdout(), /skills:\n  - notes/);

  const usageOutput = captureOutput();
  assert.equal(
    await runSourceCli({ argv: ['inspect'], rootDir: root, ...usageOutput.streams }),
    2
  );
  assert.match(usageOutput.stderr(), /Usage: npm run source -- inspect <source-id>/);
});

function captureOutput() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    streams: {
      stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) }
    },
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join('')
  };
}

async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}
