import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isExistingDirectory, normalizeProjectPath } from '../lib/projectPath.js';

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'project-path-'));
}

test('isExistingDirectory is true only for a real directory', async () => {
  const root = await makeRoot();
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'x');

  assert.equal(await isExistingDirectory(root), true);
  assert.equal(await isExistingDirectory(nested), true);
  assert.equal(await isExistingDirectory(file), false);
  assert.equal(await isExistingDirectory(path.join(root, 'missing')), false);
});

test('isExistingDirectory tolerates empty and non-string input', async () => {
  assert.equal(await isExistingDirectory(''), false);
  assert.equal(await isExistingDirectory(null), false);
  assert.equal(await isExistingDirectory(undefined), false);
  assert.equal(await isExistingDirectory(42), false);
});

test('a moved project path still normalizes, it just no longer exists', async () => {
  const root = await makeRoot();
  const oldPath = path.join(root, 'skillcaddy');
  const newPath = path.join(root, 'project', 'skillcaddy');
  await mkdir(newPath, { recursive: true });

  // 搬家前的位置：解析正常，但磁盘上已经没有了。
  assert.equal(normalizeProjectPath(oldPath), oldPath);
  assert.equal(await isExistingDirectory(oldPath), false);
  assert.equal(await isExistingDirectory(newPath), true);
});
