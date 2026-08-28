import { open, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { isPathInsideOrEqual } from './sourcePath.js';

// 默认限制。形状与 `DEFAULT_ARCHIVE_LIMITS`（`lib/sourceArchive.js`）一致，
// `maxDepth` 提高到 40 以容忍 tar 内更深嵌套，同时保持失败语义闭环。
export const DEFAULT_LIBRARY_IMAGE_LIMITS = Object.freeze({
  maxExpandedBytes: 500 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 40
});

// 仅允许这两类条目在 staging 内存在；其余全部视为拒绝条件。
export const LIBRARY_IMAGE_ENTRY_TYPES = new Set(['file', 'directory']);

// 系统 tar 在不同实现上对同一文件类型有不同名词；
// 任何条目被识别为以下任一类型时立即拒绝，避免 special 文件、symlink-first、hardlink escape。
export const LIBRARY_IMAGE_DENIED_ENTRY_TYPES = new Set([
  'symlink',
  'hardlink',
  'fifo',
  'block',
  'character',
  'socket',
  'contiguous',
  'unknown'
]);

// 跨平台强制 flag。Issue #33 的研究产出（macOS bsdtar + Linux GNU tar 的 flag 兼容性）
// 会向该数组追加平台特定 flag；T2/T3 在没有追加的情况下依赖 pre/post-flight 防御，
// T4 增量以独立 commit 填充。常量为空是合法中间态。
export const LIBRARY_IMAGE_REQUIRED_TAR_FLAGS = Object.freeze([]);

const TAR_INVOCATION_TIMEOUT_MS = 30_000;

const TAR_TYPEFLAG_BY_BYTE = {
  0x00: 'file', // ustar 'NUL' alternative
  0x30: 'file', // '0'
  0x31: 'hardlink', // '1'
  0x32: 'symlink', // '2'
  0x33: 'character', // '3'
  0x34: 'block', // '4'
  0x35: 'directory', // '5'
  0x36: 'fifo', // '6'
  0x37: 'contiguous', // '7'
  0x4b: 'unknown', // 'K' (PAX extended header; treated as opaque)
  0x4c: 'unknown', // 'L' (PAX long name; treated as opaque)
  0x4d: 'unknown', // 'M' (multi-volume continuation; rare)
  0x53: 'socket' // 'S'
};

function classifyTypeflag(byte) {
  return TAR_TYPEFLAG_BY_BYTE[byte] || 'unknown';
}

function classifyLstat(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block';
  if (stat.isCharacterDevice()) return 'character';
  return 'unknown';
}

function resolveLimits(overrides) {
  return { ...DEFAULT_LIBRARY_IMAGE_LIMITS, ...(overrides?.imageLimits || {}) };
}

function spawnTar(args, { timeoutMs = TAR_INVOCATION_TIMEOUT_MS, tarPath = 'tar' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new SourceAcquisitionError(
          'source-safety',
          `tar invocation timed out after ${timeoutMs}ms: tar ${args.join(' ')}`
        )
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readCString(buffer, offset, maxLen) {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.slice(offset, end).toString('utf8');
}

function readOctal(buffer, offset, length) {
  const slice = buffer.slice(offset, offset + length).toString('ascii');
  // trailing space or NUL terminates; strip and parse as base-8
  return parseInt(slice.trim().replace(/\s+$/, ''), 8) || 0;
}

async function readTarEntries(filePath, limits) {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    const entries = [];
    let offset = 0;

    while (offset + 512 <= fileSize) {
      const block = Buffer.alloc(512);
      const { bytesRead } = await handle.read(block, 0, 512, offset);
      if (bytesRead < 512) break;

      let allZero = true;
      for (const b of block) {
        if (b !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) break;

      const name = readCString(block, 0, 100);
      const size = readOctal(block, 124, 12);
      const typeflag = classifyTypeflag(block[156]);
      const linkname = readCString(block, 157, 100);

      if (entries.length >= limits.maxEntries) {
        throw new SourceAcquisitionError(
          'source-safety',
          `library image entry count exceeds limit ${limits.maxEntries}`
        );
      }

      entries.push({
        path: name,
        type: typeflag,
        size,
        linkname: typeflag === 'hardlink' || typeflag === 'symlink' ? linkname : undefined
      });

      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function assertEntryInsideStaging(entryPath, stagingRoot) {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
  const stagingAbsolute = path.resolve(stagingRoot);
  const candidate = path.resolve(stagingAbsolute, normalized);
  if (!isPathInsideOrEqual(stagingAbsolute, candidate)) {
    throw new SourceAcquisitionError(
      'source-safety',
      `library image entry path resolves outside staging: ${entryPath}`
    );
  }
}

function assertEntryTypeAllowed(entry, sourceDescription) {
  if (LIBRARY_IMAGE_DENIED_ENTRY_TYPES.has(entry.type)) {
    throw new SourceAcquisitionError(
      'source-safety',
      `library image declares ${entry.type} entry in ${sourceDescription}: ${entry.path}${
        entry.linkname ? ` -> ${entry.linkname}` : ''
      }`
    );
  }
}

async function walkStaging(stagingRoot) {
  const results = [];
  const queue = [stagingRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    const statResults = await Promise.all(
      entries.map((entry) =>
        lstat(path.join(current, entry.name)).then((stat) => ({
          absPath: path.join(current, entry.name),
          stat
        }))
      )
    );
    for (const { absPath, stat } of statResults) {
      const type = classifyLstat(stat);
      if (LIBRARY_IMAGE_DENIED_ENTRY_TYPES.has(type)) {
        throw new SourceAcquisitionError(
          'source-safety',
          `post-flight walk found ${type} at staging path: ${absPath}`
        );
      }
      results.push({ absPath, type });
      if (stat.isDirectory()) queue.push(absPath);
    }
  }
  return results;
}

function cleanupStaging(stagingRoot) {
  return rm(stagingRoot, { recursive: true, force: true });
}

/**
 * 读取 library image 的条目与类型。
 *
 * @param {string} filePath tar 路径
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string }} [overrides]
 * @returns {Promise<{ entries: Array<{ path: string, type: string, size: number, linkname?: string }>, totalBytes: number }>}
 */
export async function inspectLibraryImage(filePath, overrides = {}) {
  const limits = resolveLimits(overrides);
  const entries = await readTarEntries(filePath, limits);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  // Drop the trailing echo of `linkname` from non-link entries so callers get a tight shape.
  const projected = entries.map((entry) => {
    const { path: entryPath, type, size, linkname } = entry;
    const projectedEntry = { path: entryPath, type, size };
    if (linkname) projectedEntry.linkname = linkname;
    return projectedEntry;
  });
  return { entries: projected, totalBytes };
}

/**
 * 把 library image 解到 `stagingRoot`。
 *
 * Pre-flight 与 post-flight 都是 load-bearing 防御层：
 * - pre-flight 解析 tar headers，校验路径形状与条目类型；
 * - post-flight 在 staging 上跑 lstat walk（defense in depth）。
 * T4 之前允许 `LIBRARY_IMAGE_REQUIRED_TAR_FLAGS` 仍是空数组。
 *
 * @param {string} filePath
 * @param {string} stagingRoot
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string }} [overrides]
 * @returns {Promise<Array<{ absPath: string, type: string }>>}
 */
export async function extractLibraryImage(filePath, stagingRoot, overrides = {}) {
  const limits = resolveLimits(overrides);
  const entries = await readTarEntries(filePath, limits);

  for (const entry of entries) {
    assertEntryInsideStaging(entry.path, stagingRoot);
    assertEntryTypeAllowed(entry, 'pre-flight');
  }

  await mkdir(stagingRoot, { recursive: true });

  try {
    const extractArgs = [
      ...LIBRARY_IMAGE_REQUIRED_TAR_FLAGS,
      '-xf',
      filePath,
      '-C',
      stagingRoot
    ];
    const { code, stderr } = await spawnTar(extractArgs, {
      tarPath: overrides.tarPath
    });
    if (code !== 0) {
      throw new SourceAcquisitionError(
        'source-safety',
        `tar extract failed (exit ${code}): ${stderr.trim() || 'no stderr'}`
      );
    }

    const written = await walkStaging(stagingRoot);

    const claimedFileOrDirs = entries.filter((entry) => entry.type !== 'directory').length;
    const writtenFileOrDirs = written.filter((entry) => entry.type !== 'directory').length;
    if (writtenFileOrDirs !== claimedFileOrDirs) {
      await cleanupStaging(stagingRoot);
      throw new SourceAcquisitionError(
        'source-safety',
        `library image wrote ${writtenFileOrDirs} entries but advertised ${claimedFileOrDirs}; pre-flight honest extraction count must match claimed count to avoid silent filtering`
      );
    }

    return written;
  } catch (error) {
    await cleanupStaging(stagingRoot);
    if (error instanceof SourceAcquisitionError) throw error;
    throw new SourceAcquisitionError(
      'source-safety',
      `library image extraction failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
