import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath
} from 'node:fs/promises';
import path from 'node:path';
import { SourceMigrationIssue } from './sourceMigrationIssue.js';
import { SOURCE_FOLDERS } from './sourcePolicy.js';

export async function findSourceEntries(rootDir) {
  const entries = [];
  for (const bucket of SOURCE_FOLDERS) {
    const bucketPath = path.join(rootDir, bucket);
    for (const entry of await readSourceDirectory(bucketPath)) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        entries.push({
          bucket,
          installPath: `${bucket}/${entry.name}`,
          sourcePath: path.join(bucketPath, entry.name),
          unsafe: entry.isSymbolicLink()
        });
      }
    }
  }
  return entries;
}

export async function validateSourceTree(rootDir, sourcePath) {
  const [resolvedRoot, resolvedSource] = await Promise.all([
    realpath(path.resolve(rootDir)),
    realpath(sourcePath)
  ]);
  if (!isInsideOrEqual(resolvedRoot, resolvedSource)) {
    throw new SourceMigrationIssue('unsafe-path', 'Source path resolves outside the central-library root');
  }

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.name === '.git') {
        if (entry.isSymbolicLink()) {
          throw new SourceMigrationIssue('unsafe-path', `Git metadata is a symbolic link: ${relativePath}`);
        }
        if (relativeDirectory) {
          throw new SourceMigrationIssue('nested-repository', `Nested Git repository: ${relativePath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
      } else if (entry.isSymbolicLink()) {
        await validateSymlink(resolvedSource, entryPath, relativePath);
      } else if (!entry.isFile()) {
        const stat = await lstat(entryPath);
        throw new SourceMigrationIssue('unsafe-path', `Unsupported entry mode ${stat.mode}: ${relativePath}`);
      }
    }
  }

  await walk(sourcePath);
}

export async function checksumDirectory(directory) {
  const hash = createHash('sha256');

  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(directory, entryPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await walk(entryPath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await readFile(entryPath));
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(entryPath)}\0`);
      } else {
        throw new Error(`Unsupported source entry: ${relativePath}`);
      }
    }
  }

  await walk(directory);
  return hash.digest('hex');
}

export async function readSourceDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function sourcePathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureSourceDirectory(rootDir, ...segments) {
  let current = await realpath(path.resolve(rootDir));
  const resolvedRoot = current;

  for (const segment of segments) {
    if (!segment || segment.includes('/') || segment.includes('\\')) {
      throw new Error('Invalid managed source directory segment');
    }
    const next = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(next);
      stat = await lstat(next);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Managed source directory is not a safe directory: ${segment}`);
    }
    current = await realpath(next);
    if (!isInsideOrEqual(resolvedRoot, current)) {
      throw new Error(`Managed source directory resolves outside the central-library root: ${segment}`);
    }
  }
  return current;
}

async function validateSymlink(resolvedSource, entryPath, relativePath) {
  const target = await readlink(entryPath);
  if (path.isAbsolute(target)) {
    throw new SourceMigrationIssue('unsafe-path', `Absolute symlink: ${relativePath}`);
  }

  let resolvedTarget;
  try {
    resolvedTarget = await realpath(entryPath);
  } catch {
    throw new SourceMigrationIssue('unsafe-path', `Broken symlink: ${relativePath}`);
  }
  if (!isInsideOrEqual(resolvedSource, resolvedTarget)) {
    throw new SourceMigrationIssue('unsafe-path', `Escaping symlink: ${relativePath}`);
  }
}

function isInsideOrEqual(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
