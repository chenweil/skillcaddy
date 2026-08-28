import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  rm
} from 'node:fs/promises';
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
// 会向该数组追加平台特定 flag；T2 在没有追加的情况下依赖 pre/post-flight 防御，
// T4 增量以独立 commit 填充。常量为空是合法中间态。
export const LIBRARY_IMAGE_REQUIRED_TAR_FLAGS = Object.freeze([]);

const TAR_INVOCATION_TIMEOUT_MS = 30_000;

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

function assertEntryInsideStaging(entryPath, stagingRoot) {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
  // path.resolve always returns platform-native paths; coerce staging to native.
  const stagingAbsolute = path.resolve(stagingRoot);
  const candidate = path.resolve(stagingAbsolute, normalized);
  if (!isPathInsideOrEqual(stagingAbsolute, candidate)) {
    throw new SourceAcquisitionError(
      'source-safety',
      `library image entry path resolves outside staging: ${entryPath}`
    );
  }
}

function asyncLstat(target) {
  return lstat(target).then((stat) => ({ absPath: target, stat }));
}

async function walkStaging(stagingRoot) {
  const results = [];
  const queue = [stagingRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    const statResults = await Promise.all(
      entries.map((entry) => asyncLstat(path.join(current, entry.name)))
    );
    for (const { absPath, stat } of statResults) {
      results.push({ absPath, type: classifyLstat(stat) });
      if (stat.isDirectory()) queue.push(absPath);
    }
  }
  return results;
}

function cleanupStaging(stagingRoot) {
  return rm(stagingRoot, { recursive: true, force: true });
}

/**
 * 读取 library image 的条目清单。当前返回 `path`；`type`/`size`/`mode`
 * 的精确填充留给 T3（post-flight lstat 决定真实类型）。
 *
 * @param {string} filePath tar 路径
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string }} [overrides]
 * @returns {Promise<{ entries: Array<{ path: string }>, totalBytes: number }>}
 */
export async function inspectLibraryImage(filePath, overrides = {}) {
  void resolveLimits(overrides);
  const args = [...LIBRARY_IMAGE_REQUIRED_TAR_FLAGS, '-tf', filePath];
  const { code, stdout, stderr } = await spawnTar(args, {
    tarPath: overrides.tarPath
  });
  if (code !== 0) {
    throw new SourceAcquisitionError(
      'source-safety',
      `tar list failed (exit ${code}): ${stderr.trim() || 'no stderr'}`
    );
  }
  const entries = [];
  let totalBytes = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    entries.push({ path: line });
  }
  return { entries, totalBytes };
}

/**
 * 把 library image 解到 `stagingRoot`，pre-flight 拒绝绝对/穿越路径，
 * 失败时原子清理。Post-flight 把真实写入条目（lstat-derived type）返回给调用方。
 *
 * @param {string} filePath
 * @param {string} stagingRoot
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string }} [overrides]
 * @returns {Promise<Array<{ absPath: string, type: string }>>}
 */
export async function extractLibraryImage(filePath, stagingRoot, overrides = {}) {
  const limits = resolveLimits(overrides);
  void limits;

  // Pre-flight: list + path-shape validation. Listing happens BEFORE any mkdir/extract,
  // so a rejected image never leaves behind a half-populated staging root.
  const listing = await inspectLibraryImage(filePath, overrides);
  for (const entry of listing.entries) {
    assertEntryInsideStaging(entry.path, stagingRoot);
  }

  // Entry count guard: rejects tarballs that exceed the configured ceiling
  // before any fs write happens.
  if (listing.entries.length > limits.maxEntries) {
    throw new SourceAcquisitionError(
      'source-safety',
      `library image entry count ${listing.entries.length} exceeds limit ${limits.maxEntries}`
    );
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

    // Post-flight: enumerate staged entries with their real lstat type.
    const written = await walkStaging(stagingRoot);

    // Entry count consistency: written minus the staging root itself must match
    // the listing; a mismatch implies an entry was filtered out by the system tar
    // after pre-flight, which means the image claimed more than it produced.
    const claimedFileOrDirs = listing.entries.filter((entry) =>
      !entry.path.endsWith('/')
    ).length;
    const writtenFileOrDirs = written.filter((entry) => entry.type !== 'directory').length;
    if (writtenFileOrDirs !== claimedFileOrDirs) {
      await cleanupStaging(stagingRoot);
      throw new SourceAcquisitionError(
        'source-safety',
        `library image wrote ${writtenFileOrDirs} entries but advertised ${claimedFileOrDirs} (pre-flight honest)` +
          ` extraction count must equal claimed count to avoid silent filtering`
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
