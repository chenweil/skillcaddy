import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
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
    await assertExistingPathInsideRoot(
      rootDir,
      path.resolve(rootDir, validated.installPath),
      'installPath resolves outside the central-library root'
    );
    records.push(validated);
  }

  return records.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export async function writeSourceRecord(rootDir, record) {
  const validated = validateSourceRecord(rootDir, record);
  await assertExistingPathInsideRoot(
    rootDir,
    path.resolve(rootDir, validated.installPath),
    'installPath resolves outside the central-library root'
  );

  const registryRoot = path.join(path.resolve(rootDir), '.skillcaddy', 'sources');
  const targetPath = path.join(registryRoot, ...validated.sourceId.split('/')) + '.json';
  await assertExistingPathInsideRoot(
    rootDir,
    targetPath,
    'Source registry path resolves outside the central-library root'
  );
  await mkdir(path.dirname(targetPath), { recursive: true });

  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return validated;
}

async function assertExistingPathInsideRoot(rootDir, targetPath, errorMessage) {
  const resolvedRoot = await realpath(path.resolve(rootDir));
  let existingAncestor = targetPath;

  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }

  const resolvedAncestor = await realpath(existingAncestor);
  const relative = path.relative(resolvedRoot, resolvedAncestor);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(errorMessage);
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
