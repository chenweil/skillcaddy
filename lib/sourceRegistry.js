import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateSourceId, validateSourceRecord } from './sourceRecord.js';

export { validateSourceId };

export async function readSourceRecords(rootDir) {
  const registryRoot = path.join(path.resolve(rootDir), '.skillcaddy', 'sources');
  const files = await findJsonFiles(registryRoot);
  const records = [];

  for (const filePath of files) {
    const expectedSourceId = path.relative(registryRoot, filePath).slice(0, -'.json'.length).split(path.sep).join('/');
    const record = await readRecord(filePath);
    const validated = validateSourceRecord(rootDir, record, expectedSourceId);
    await assertExistingInstallPathInsideRoot(rootDir, validated.installPath);
    records.push(validated);
  }

  return records.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

async function assertExistingInstallPathInsideRoot(rootDir, installPath) {
  const resolvedRoot = await realpath(path.resolve(rootDir));
  const targetPath = path.resolve(rootDir, installPath);
  try {
    await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const resolvedTarget = await realpath(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('installPath resolves outside the central-library root');
  }
}

async function readRecord(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid source record JSON: ${filePath}`);
    throw error;
  }
}

async function findJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(entryPath);
    }
  }
  return files;
}
