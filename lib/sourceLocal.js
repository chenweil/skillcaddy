import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  readdir,
  rm,
  symlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { extractZip, hasZipSignature } from './sourceArchive.js';
import { checksumDirectory, sourcePathExists } from './sourceTree.js';
import { validateStagedSource } from './sourceValidation.js';

export async function inspectLocalInput(inputPath, options = {}) {
  const input = await classifyLocalInput(inputPath);
  if (input.type === 'local-directory') {
    await validateLocalDirectory(inputPath);
    return buildPreparedInput(input, inputPath);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'skillcaddy-zip-plan-'));
  try {
    const extractedRoot = path.join(temporaryRoot, 'content');
    await extractZip(inputPath, extractedRoot, options.archiveLimits);
    const contentRoot = await unwrapArchiveRoot(extractedRoot);
    return await buildPreparedInput(input, contentRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function stageLocalInput(inputPath, stagingRoot, options = {}) {
  const input = await classifyLocalInput(inputPath);
  const contentRoot = path.join(stagingRoot, 'content');
  if (input.type === 'local-directory') {
    await validateLocalDirectory(inputPath);
    await copyLocalDirectory(inputPath, contentRoot);
    await validateLocalDirectory(contentRoot);
    return buildPreparedInput(input, contentRoot);
  }

  await extractZip(inputPath, contentRoot, options.archiveLimits);
  return buildPreparedInput(input, await unwrapArchiveRoot(contentRoot));
}

async function buildPreparedInput(input, contentRoot) {
  const validation = await validateStagedSource(contentRoot);
  return {
    ...input,
    contentRoot,
    integrity: {
      algorithm: 'sha256',
      value: await checksumDirectory(contentRoot)
    },
    ...validation
  };
}

async function classifyLocalInput(inputPath) {
  let stat;
  try {
    stat = await lstat(inputPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new SourceAcquisitionError(
        'invalid-input',
        `Local input does not exist: ${path.basename(inputPath)}`
      );
    }
    throw error;
  }

  const basename = path.basename(path.resolve(inputPath));
  if (stat.isDirectory()) {
    return { type: 'local-directory', basename, defaultName: basename };
  }
  if (!stat.isFile()) {
    throw new SourceAcquisitionError('invalid-input', 'Local input must be a directory or ZIP file');
  }
  if (!(await hasZipSignature(inputPath))) {
    throw new SourceAcquisitionError('invalid-input', 'Local file does not have a ZIP signature');
  }
  return {
    type: 'local-zip',
    basename,
    defaultName: basename.replace(/\.zip$/i, '') || basename
  };
}

async function validateLocalDirectory(sourceRoot) {
  const resolvedRoot = await realpath(sourceRoot);

  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
      } else if (entry.isSymbolicLink()) {
        await validateLocalSymlink(resolvedRoot, entryPath, relativePath);
      } else if (!entry.isFile()) {
        throw new SourceAcquisitionError(
          'source-safety',
          `Unsupported local source entry: ${relativePath}`
        );
      }
    }
  }

  await walk(sourceRoot);
}

async function validateLocalSymlink(resolvedRoot, entryPath, relativePath) {
  const target = await readlink(entryPath);
  if (path.isAbsolute(target)) {
    throw new SourceAcquisitionError(
      'source-safety',
      `Absolute local symlink is not allowed: ${relativePath}`
    );
  }
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(entryPath);
  } catch {
    throw new SourceAcquisitionError(
      'source-safety',
      `Broken local symlink is not allowed: ${relativePath}`
    );
  }
  if (!isInsideOrEqual(resolvedRoot, resolvedTarget)) {
    throw new SourceAcquisitionError(
      'source-safety',
      `Escaping local symlink is not allowed: ${relativePath}`
    );
  }
}

async function copyLocalDirectory(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });

  async function copyDirectory(sourceDirectory, destinationDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destinationPath);
        await copyDirectory(sourcePath, destinationPath);
      } else if (entry.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), destinationPath);
      } else if (entry.isFile()) {
        await copyRegularFile(sourcePath, destinationPath);
      } else {
        throw new SourceAcquisitionError(
          'source-safety',
          `Unsupported local source entry: ${path.relative(sourceRoot, sourcePath)}`
        );
      }
    }
  }

  await copyDirectory(sourceRoot, destinationRoot);
}

async function copyRegularFile(sourcePath, destinationPath) {
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SourceAcquisitionError('source-safety', 'Local source changed during copying');
    }
    await pipeline(
      createReadStream(null, { fd: handle.fd, autoClose: false }),
      createWriteStream(destinationPath, { flags: 'wx', mode: stat.mode & 0o777 })
    );
  } finally {
    await handle.close();
  }
}

async function unwrapArchiveRoot(extractedRoot) {
  let currentRoot = extractedRoot;
  while (true) {
    const entries = await readdir(currentRoot, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) return currentRoot;
    const directSkill = path.join(currentRoot, 'SKILL.md');
    const skillsDirectory = path.join(currentRoot, 'skills');
    if (await sourcePathExists(directSkill) || await sourcePathExists(skillsDirectory)) return currentRoot;
    currentRoot = path.join(currentRoot, entries[0].name);
  }
}

function isInsideOrEqual(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
