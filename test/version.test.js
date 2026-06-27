import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersion } from '../lib/version.js';

test('reads name and version from package.json', async () => {
  const root = await makeTempDir('version-root-');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'skillcaddy', version: '0.1.0', private: true })
  );

  const info = await readVersion(root);

  assert.deepEqual(info, { name: 'skillcaddy', version: '0.1.0' });
});

test('throws when package.json is missing', async () => {
  const root = await makeTempDir('version-empty-');

  await assert.rejects(() => readVersion(root), /package\.json/);
});

async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}