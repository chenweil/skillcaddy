import { chmod, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { planSourceAcquisition, applySourceAcquisition } from './sourceAcquisition.js';
import { readSourceRecords } from './sourceRegistry.js';
import { checksumDirectory, checksumDirectoryNormalized, ensureSourceDirectory, sourcePathExists } from './sourceTree.js';
import { SOURCE_FOLDERS, SOURCE_INSTALLING_MARKER } from './sourcePolicy.js';
import { createManagedSourceWorkspace, removeManagedSourceWorkspace } from './sourceWorkspace.js';
import { getGlobalSkillsDir } from './skillStore.js';
import { homedir } from 'node:os';
import { updateSkillMetadata } from './skillMetadata.js';
import { getHermesSkillsDir, isHermesEligibleSource } from './hermesStore.js';
import { scanSkillLinks } from './skillLinkStore.js';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { readGitHead } from './sourceGit.js';
import { isPathInsideOrEqual } from './sourcePath.js';

// 默认限制。形状与 `DEFAULT_ARCHIVE_LIMITS`（`lib/sourceArchive.js`）一致，
// `maxDepth` 提高到 40 以容忍 tar 内更深嵌套，同时保持失败语义闭环。
export const DEFAULT_LIBRARY_IMAGE_LIMITS = Object.freeze({
  maxExpandedBytes: 500 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 40
});

// staging 内唯一允许存在的两类条目。这是 allowlist：
// 任何没落在这里的类型都会被拒收，即使它不在下面的 denylist 里。
export const LIBRARY_IMAGE_ENTRY_TYPES = new Set(['file', 'directory']);

// denylist 只负责给已知的危险类型一个精确的错误信息；
// 真正的闭环由上面的 allowlist 提供。
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

// 跨平台强制 flag。
//
// `common` 只收录两个实现都长期支持的选项，实测于 macOS bsdtar 3.5.3：
//   --no-acls  --no-xattrs  --no-same-permissions  --no-same-owner
// `--no-same-owner` 尤其重要：GNU tar 以 root 运行时默认按归档里的
// uid/gid 恢复所有权，解压不可信归档时必须关掉。
//
// `bsdtar` 收录 bsdtar 专属项（GNU tar 会当作未知选项报错）。
// GNU-only flags verified by the #33 unpacking research.
export const LIBRARY_IMAGE_FLAG_POLICY = Object.freeze({
  common: Object.freeze([
    '--no-acls',
    '--no-xattrs',
    '--no-same-permissions',
    '--no-same-owner'
  ]),
  bsdtar: Object.freeze(['--no-mac-metadata', '--no-fflags']),
  gnutar: Object.freeze(['--no-selinux', '--no-overwrite-dir', '--delay-directory-restore'])
});

export const LIBRARY_IMAGE_REQUIRED_TAR_FLAGS = LIBRARY_IMAGE_FLAG_POLICY.common;

const TAR_INVOCATION_TIMEOUT_MS = 30_000;

// tar 的 stderr 由归档内容驱动，恶意归档可以让它无限输出；
// 只保留前 64 KiB 用于错误信息。
const MAX_TAR_OUTPUT_BYTES = 64 * 1024;

const BLOCK_SIZE = 512;

// PAX / GNU 元数据块的 payload 上限。正常的 PAX 记录只有几百字节。
const MAX_METADATA_PAYLOAD_BYTES = 1024 * 1024;

// tar header 的 typeflag。'x' / 'g' / 'L' / 'K' 不是条目本身，
// 而是描述下一个条目的元数据块，由 parser 消化后不进入条目列表。
const TAR_TYPEFLAG_BY_BYTE = {
  0x00: 'file', // ustar 'NUL' alternative
  0x30: 'file', // '0'
  0x31: 'hardlink', // '1'
  0x32: 'symlink', // '2'
  0x33: 'character', // '3'
  0x34: 'block', // '4'
  0x35: 'directory', // '5'
  0x36: 'fifo', // '6'
  0x37: 'contiguous', // '7' —— GNU tar 视作普通文件，这里保持更严的拒收
  0x53: 'socket' // 'S'
};

const TAR_METADATA_KIND_BY_BYTE = {
  0x78: 'pax-extended', // 'x' —— 作用于紧随其后的一个条目
  0x67: 'pax-global', // 'g' —— 作用于其后所有条目
  0x4c: 'gnu-long-name', // 'L'
  0x4b: 'gnu-long-link' // 'K'
};

// 压缩容器签名。`tar -xf` 会自动识别压缩格式，但 pre-flight 解析的是裸 tar；
// 两者对同一个字节流的解读会完全脱节，因此压缩输入一律拒收。
const COMPRESSED_SIGNATURES = [
  { label: 'gzip', bytes: [0x1f, 0x8b] },
  { label: 'bzip2', bytes: [0x42, 0x5a, 0x68] },
  { label: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { label: 'zstd', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { label: 'lz4', bytes: [0x04, 0x22, 0x4d, 0x18] },
  { label: 'compress', bytes: [0x1f, 0x9d] },
  { label: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }
];

function safetyError(message) {
  return new SourceAcquisitionError('source-safety', message);
}

function classifyTypeflag(byte) {
  return TAR_TYPEFLAG_BY_BYTE[byte] || 'unknown';
}

function classifyDirent(dirent) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFIFO()) return 'fifo';
  if (dirent.isSocket()) return 'socket';
  if (dirent.isBlockDevice()) return 'block';
  if (dirent.isCharacterDevice()) return 'character';
  return 'unknown';
}

function resolveLimits(overrides) {
  const limits = { ...DEFAULT_LIBRARY_IMAGE_LIMITS, ...(overrides?.imageLimits || {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw safetyError(`invalid library image limit ${name}: ${String(value)}`);
    }
  }
  return limits;
}

// A real library can contain the complete nested Git state described by
// ADR-0011. Keep the public extraction seam's conservative limits stable while
// giving the image transaction an explicit, larger budget.
const DEFAULT_LIBRARY_IMAGE_WORKFLOW_LIMITS = Object.freeze({
  maxExpandedBytes: 8 * 1024 * 1024 * 1024,
  maxEntries: 500_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxDepth: 40
});

function resolveWorkflowLimits(overrides) {
  return resolveLimits({
    ...overrides,
    imageLimits: overrides?.imageLimits || DEFAULT_LIBRARY_IMAGE_WORKFLOW_LIMITS
  });
}

function spawnTar(args, { timeoutMs = TAR_INVOCATION_TIMEOUT_MS, tarPath = 'tar' } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    delete env.TAR_OPTIONS;
    const child = spawn(tarPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(safetyError(`tar invocation timed out after ${timeoutMs}ms: tar ${args.join(' ')}`));
    }, timeoutMs);

    const collect = (current, chunk) =>
      current.length >= MAX_TAR_OUTPUT_BYTES
        ? current
        : (current + chunk.toString('utf8')).slice(0, MAX_TAR_OUTPUT_BYTES);

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
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
  return buffer.subarray(offset, end).toString('utf8');
}

/**
 * 读取 tar 的数值字段。支持两种编码：
 * - 传统 octal（ASCII，空格或 NUL 结尾）；
 * - base-256（首字节高位置 1，big-endian）——GNU / bsdtar 在数值超出 octal
 *   宽度时使用。旧实现只认 octal 且解析失败时静默返回 0，会让 header 流错位。
 */
function readNumericField(buffer, offset, length, fieldName, blockOffset) {
  const first = buffer[offset];
  if ((first & 0x80) !== 0) {
    const negative = (first & 0x40) !== 0;
    if (negative) {
      throw safetyError(
        `tar header at offset ${blockOffset} declares a negative ${fieldName}`
      );
    }
    let value = first & 0x3f;
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + buffer[index];
      if (!Number.isSafeInteger(value)) {
        throw safetyError(
          `tar header at offset ${blockOffset} declares an out-of-range ${fieldName}`
        );
      }
    }
    return value;
  }

  const raw = buffer.subarray(offset, offset + length).toString('ascii');
  const trimmed = raw.replace(/\0/g, ' ').trim();
  if (trimmed === '') return 0;
  if (!/^[0-7]+$/.test(trimmed)) {
    throw safetyError(
      `tar header at offset ${blockOffset} has a malformed ${fieldName} field: ${JSON.stringify(raw)}`
    );
  }
  const value = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(value)) {
    throw safetyError(`tar header at offset ${blockOffset} declares an out-of-range ${fieldName}`);
  }
  return value;
}

/**
 * 校验 header 的 checksum。这是防止 parser 与系统 tar 解读脱节的关键一环：
 * 一旦 offset 计算错位，落到数据块上的“伪 header”几乎不可能通过校验。
 */
function assertHeaderChecksum(block, blockOffset) {
  const declared = readNumericField(block, 148, 8, 'checksum', blockOffset);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (declared !== unsigned && declared !== signed) {
    throw safetyError(
      `tar header checksum mismatch at offset ${blockOffset} (declared ${declared}, computed ${unsigned})`
    );
  }
}

function parsePaxRecords(payload) {
  const records = {};
  let cursor = 0;
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor);
    if (space < 0) throw safetyError('Malformed PAX record.');
    const lengthText = payload.subarray(cursor, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw safetyError('Malformed PAX record length.');
    const declaredLength = Number(lengthText);
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      throw safetyError('library image contains a malformed PAX record length');
    }
    const end = cursor + declaredLength;
    if (end <= space + 1 || payload[end - 1] !== 10 || end > payload.length) {
      throw safetyError('library image contains a truncated PAX record');
    }
    const body = payload.subarray(space + 1, end).toString('utf8').replace(/\n$/, '');
    const equals = body.indexOf('=');
    if (equals <= 0) throw safetyError('Malformed PAX record key.');
    records[body.slice(0, equals)] = body.slice(equals + 1);
    cursor = end;
  }
  return records;
}

async function readBlock(handle, offset) {
  const block = Buffer.alloc(BLOCK_SIZE);
  const { bytesRead } = await handle.read(block, 0, BLOCK_SIZE, offset);
  if (bytesRead < BLOCK_SIZE) {
    throw safetyError(`library image is truncated at offset ${offset}`);
  }
  return block;
}

async function readPayload(handle, offset, size, blockOffset) {
  if (size > MAX_METADATA_PAYLOAD_BYTES) {
    throw safetyError(
      `library image metadata block at offset ${blockOffset} declares ${size} bytes (limit ${MAX_METADATA_PAYLOAD_BYTES})`
    );
  }
  const payload = Buffer.alloc(size);
  if (size === 0) return payload;
  const { bytesRead } = await handle.read(payload, 0, size, offset);
  if (bytesRead < size) {
    throw safetyError(`library image metadata block at offset ${blockOffset} is truncated`);
  }
  return payload;
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * 归档结束标记之后必须全为零。真实 tar 会用零块把归档补齐到 blocking factor，
 * 所以这一条对合法归档无害；它封掉的是「单个零块之后藏一个条目」——
 * 系统 tar 在遇到零块时停止读取，而藏起来的条目对 pre-flight 不可见。
 */
async function assertTrailerIsZeroed(handle, offset, fileSize) {
  let cursor = offset;
  const scratch = Buffer.alloc(BLOCK_SIZE);
  while (cursor < fileSize) {
    const { bytesRead } = await handle.read(scratch, 0, BLOCK_SIZE, cursor);
    if (bytesRead === 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (scratch[index] !== 0) {
        throw safetyError(
          `library image carries non-zero data after the end-of-archive marker at offset ${cursor + index}`
        );
      }
    }
    cursor += bytesRead;
  }
}

async function assertUncompressed(handle) {
  const probe = Buffer.alloc(8);
  const { bytesRead } = await handle.read(probe, 0, 8, 0);
  for (const signature of COMPRESSED_SIGNATURES) {
    if (bytesRead < signature.bytes.length) continue;
    if (signature.bytes.every((byte, index) => probe[index] === byte)) {
      throw safetyError(
        `library image looks like a ${signature.label} container; library images must be uncompressed tar so pre-flight and tar read the same bytes`
      );
    }
  }
}

function headerEntryPath(block, name) {
  const magic = block.subarray(257, 263).toString('ascii');
  if (magic !== 'ustar\0' && magic !== 'ustar ') return name;
  const prefix = readCString(block, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * 解析整个 header 流，返回归档实际声明的条目。
 *
 * 相对早期版本补齐的部分（每一项都对应一个 pre-flight 与系统 tar 解读
 * 不一致的缺口）：USTAR prefix 字段、base-256 数值编码、PAX 扩展/全局头、
 * GNU 长文件名、header checksum、结束标记之后的残留数据。
 */
async function readTarEntries(filePath, limits) {
  const handle = await open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    await assertUncompressed(handle);

    const entries = [];
    let offset = 0;
    let totalBytes = 0;
    let ended = false;
    let pending = {};
    const global = {};

    while (offset + BLOCK_SIZE <= fileSize) {
      const blockOffset = offset;
      const block = await readBlock(handle, blockOffset);
      if (isZeroBlock(block)) {
        ended = true;
        await assertTrailerIsZeroed(handle, blockOffset, fileSize);
        break;
      }
      assertHeaderChecksum(block, blockOffset);

      const typeByte = block[156];
      const size = readNumericField(block, 124, 12, 'size', blockOffset);
      const dataOffset = blockOffset + BLOCK_SIZE;
      offset = dataOffset + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

      const metadataKind = TAR_METADATA_KIND_BY_BYTE[typeByte];
      if (metadataKind) {
        const payload = await readPayload(handle, dataOffset, size, blockOffset);
        if (metadataKind === 'gnu-long-name') {
          pending.path = payload.toString('utf8').replace(/\0.*$/, '');
        } else if (metadataKind === 'gnu-long-link') {
          pending.linkname = payload.toString('utf8').replace(/\0.*$/, '');
        } else {
          const records = parsePaxRecords(payload);
          if (Object.keys(records).some(key => key.startsWith('GNU.sparse') || ['SCHILY.filetype', 'SCHILY.realsize', 'SCHILY.mode'].includes(key))) throw safetyError('Unsupported PAX entry interpretation.');
          const target = metadataKind === 'pax-global' ? global : pending;
          target.xattrs = Object.keys(records).filter(key => /^(LIBARCHIVE\.xattr\.|SCHILY\.xattr\.)/.test(key));
          if (records.path !== undefined) target.path = records.path;
          if (records.linkpath !== undefined) target.linkname = records.linkpath;
          if (records.size !== undefined) {
            const paxSize = /^[0-9]+$/.test(records.size) ? Number(records.size) : NaN;
            if (!Number.isSafeInteger(paxSize) || paxSize < 0) {
              throw safetyError('library image declares a malformed PAX size record');
            }
            target.size = paxSize;
          }
        }
        continue;
      }

      const overrides = { ...global, ...pending };
      pending = {};

      const type = classifyTypeflag(typeByte);
      const entryPath = overrides.path ?? headerEntryPath(block, readCString(block, 0, 100));
      const entrySize = overrides.size ?? size;
      const linkname = overrides.linkname ?? readCString(block, 157, 100);

      if (entryPath === '') {
        throw safetyError(`tar header at offset ${blockOffset} declares an empty entry path`);
      }
      if (entries.length >= limits.maxEntries) {
        throw safetyError(`library image entry count exceeds limit ${limits.maxEntries}`);
      }
      if (entrySize > limits.maxFileBytes) {
        throw safetyError(
          `library image entry exceeds max file size ${limits.maxFileBytes}: ${entryPath} (${entrySize} bytes)`
        );
      }
      totalBytes += entrySize;
      if (totalBytes > limits.maxExpandedBytes) {
        throw safetyError(
          `library image expanded size exceeds limit ${limits.maxExpandedBytes}`
        );
      }

      // PAX size controls the physical payload consumed by the extractor too.
      offset = dataOffset + Math.ceil(entrySize / BLOCK_SIZE) * BLOCK_SIZE;
      if (offset > fileSize) throw safetyError('Truncated tar entry payload.');
      entries.push({
        path: entryPath,
        type,
        size: entrySize,
        dataOffset,
        xattrs: overrides.xattrs || [],
        uid: readNumericField(block, 108, 8, 'uid', blockOffset),
        gid: readNumericField(block, 116, 8, 'gid', blockOffset),
        mtime: readNumericField(block, 136, 12, 'mtime', blockOffset),
        mode: readNumericField(block, 100, 8, 'mode', blockOffset),
        linkname: type === 'hardlink' || type === 'symlink' ? linkname : undefined
      });
    }

    if (!ended || Object.keys(pending).length) throw safetyError('Missing tar end marker or orphaned metadata.');
    return { entries, totalBytes };
  } finally {
    await handle.close();
  }
}

function normalizeEntryPath(entryPath) {
  return path.posix.normalize(entryPath.replace(/\\/g, '/')).replace(/\/+$/, '');
}

function isMacPackagingJunk(entryPath) {
  const segments = entryPath.split('/');
  const basename = segments.at(-1) || '';
  return segments[0] === '__MACOSX' || basename === '.DS_Store' || basename.startsWith('._');
}

function assertEntryInsideStaging(entryPath, stagingRoot) {
  if (/^(?:[\\/]|[A-Za-z]:)/.test(entryPath) || entryPath.replace(/\\/g, '/').split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(entryPath)) {
    throw safetyError(`library image entry path resolves outside staging or declares traversal: ${entryPath}`);
  }
  const normalized = normalizeEntryPath(entryPath);
  const stagingAbsolute = path.resolve(stagingRoot);
  const candidate = path.resolve(stagingAbsolute, normalized);
  if (!isPathInsideOrEqual(stagingAbsolute, candidate)) {
    throw safetyError(`library image entry path resolves outside staging: ${entryPath}`);
  }
}

function assertEntryDepth(entry, limits) {
  const segments = normalizeEntryPath(entry.path).split('/').filter(Boolean);
  const depth = entry.type === 'directory' ? segments.length : segments.length - 1;
  if (depth > limits.maxDepth) {
    throw safetyError(
      `library image directory depth exceeds limit ${limits.maxDepth}: ${entry.path}`
    );
  }
}

function assertEntryTypeAllowed(entry, stage) {
  if (LIBRARY_IMAGE_ENTRY_TYPES.has(entry.type)) return;
  const suffix = entry.linkname ? ` -> ${entry.linkname}` : '';
  if (LIBRARY_IMAGE_DENIED_ENTRY_TYPES.has(entry.type)) {
    throw safetyError(
      `library image declares ${entry.type} entry in ${stage}: ${entry.path}${suffix}`
    );
  }
  throw safetyError(
    `library image declares unsupported entry type ${entry.type} in ${stage}: ${entry.path}${suffix}`
  );
}

/**
 * pre-flight 认可的相对路径集合，含 tar 会隐式创建的父目录。
 * post-flight 用它做 containment 校验：staging 里出现任何不在集合内的
 * 路径，都说明系统 tar 写了 pre-flight 没批准的东西。
 */
function buildExpectedPaths(entries) {
  const expected = new Set();
  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.path);
    if (!normalized || normalized === '.') continue;
    const segments = normalized.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      expected.add(segments.slice(0, index).join('/'));
    }
  }
  return expected;
}

async function walkStaging(stagingRoot, libraryLayout = false) {
  const results = [];
  const queue = [stagingRoot];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // 归档可以声明 mode 0000 的目录。那会让 post-flight 无法进入，
      // 等于有一块没被校验的 staging 区域，因此拒收。
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw safetyError(
          `post-flight cannot traverse staged directory ${current}; the image declares permissions that would leave part of staging unverified`
        );
      }
      throw error;
    }
    for (const dirent of dirents) {
      const absPath = path.join(current, dirent.name);
      const type = classifyDirent(dirent);
      if (!LIBRARY_IMAGE_ENTRY_TYPES.has(type) && !(libraryLayout && type === 'symlink')) {
        throw safetyError(`post-flight walk found ${type} at staging path: ${absPath}`);
      }
      results.push({ absPath, type });
      if (type === 'directory') queue.push(absPath);
    }
  }
  return results;
}

/**
 * 准备 staging 目录，并记录它是否由本次调用创建。
 *
 * 这里刻意不用 `mkdir(..., { recursive: true })` 建最后一级：recursive 模式
 * 对已存在的目录不报错，调用方传错路径时函数无法分辨「我建的」和「别人的」，
 * 失败清理就会把调用方的数据一起删掉。
 */
async function prepareStaging(stagingRoot) {
  const absolute = path.resolve(stagingRoot);
  const parent = path.dirname(absolute);
  if (parent !== absolute) await mkdir(parent, { recursive: true });

  try {
    await mkdir(absolute);
    return { stagingRoot: absolute, createdHere: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stat = await lstat(absolute);
  if (!stat.isDirectory()) {
    throw safetyError(`staging root is not a directory: ${absolute}`);
  }
  const existing = await readdir(absolute);
  if (existing.length > 0) {
    throw safetyError(
      `staging root must be empty before extraction: ${absolute} holds ${existing.length} entries`
    );
  }
  return { stagingRoot: absolute, createdHere: false };
}

/**
 * 归档可以声明不可遍历的目录（例如 mode 0644），`rm -r` 会在这种目录上拿到
 * EACCES。清理失败等于把攻击者的内容留在 staging 里，所以这里先把目录权限
 * 放开再重试一次。
 */
async function forceRemove(target) {
  try {
    await rm(target, { recursive: true, force: true });
    return;
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
  }
  await relaxDirectoryModes(target);
  await rm(target, { recursive: true, force: true });
}

async function relaxDirectoryModes(root) {
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    try {
      await chmod(current, 0o700);
      const dirents = await readdir(current, { withFileTypes: true });
      for (const dirent of dirents) {
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
          queue.push(path.join(current, dirent.name));
        }
      }
    } catch {
      // best-effort：单个节点放开失败不应中断整体清理
    }
  }
}

/**
 * 只回收本次调用产生的东西：自己建的目录整体删除，
 * 调用方预先提供的空目录则只清空内容、保留目录本身。
 *
 * 返回清理失败的原因（如果有）。清理失败绝不能覆盖调用方真正要看的那个错误，
 * 但也不能被静默丢弃 —— staging 里可能还留着攻击者的内容。
 */
async function cleanupStaging({ stagingRoot, createdHere }) {
  try {
    if (createdHere) {
      await forceRemove(stagingRoot);
      return null;
    }
    let children = [];
    try {
      children = await readdir(stagingRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    for (const child of children) {
      await forceRemove(path.join(stagingRoot, child));
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function probeTarImplementation(tarPath, timeoutMs) {
  const { code, stdout, stderr } = await spawnTar(['--version'], { tarPath, timeoutMs });
  if (code !== 0) {
    throw safetyError(
      `tar --version probe failed (exit ${code}): ${stderr.trim() || 'no stderr'}`
    );
  }
  const firstLine = stdout.split('\n')[0] || '';
  if (/bsdtar|libarchive/i.test(firstLine)) {
    return { implementation: 'bsdtar', version: firstLine };
  }
  if (/GNU tar/i.test(firstLine)) {
    return { implementation: 'gnutar', version: firstLine };
  }
  throw safetyError(`unknown tar implementation: ${firstLine || '<empty>'}`);
}

function flagsForImplementation(implementation) {
  const policy = LIBRARY_IMAGE_FLAG_POLICY;
  if (implementation === 'bsdtar') return [...policy.common, ...policy.bsdtar];
  if (implementation === 'gnutar') return [...policy.common, ...policy.gnutar];
  return [...policy.common];
}

/**
 * 探测系统 tar 的实现，并在允许列表内挑选 flag 集合。
 *
 * 探测失败或实现无法识别时直接拒收：不认识实现就无法判断哪些 flag 安全可用，
 * 继续解压等于放弃整套 flag 策略。
 */
export async function resolveTarInvocation(tarPath = 'tar', { timeoutMs } = {}) {
  const probe = await probeTarImplementation(tarPath, timeoutMs);
  return {
    binary: tarPath,
    implementation: probe.implementation,
    version: probe.version,
    flags: flagsForImplementation(probe.implementation)
  };
}

/**
 * 拼装 `tar -xf` 调用参数。导出仅供测试；运行时不直接调用。
 */
export function composeExtractArgs({ invocation, filePath, stagingRoot }) {
  return [...invocation.flags, '-xf', filePath, '-C', stagingRoot];
}

/**
 * 读取 library image 的条目与类型。
 *
 * @param {string} filePath tar 路径
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS> }} [overrides]
 * @returns {Promise<{ entries: Array<{ path: string, type: string, size: number, linkname?: string }>, totalBytes: number }>}
 */
export async function inspectLibraryImage(filePath, overrides = {}) {
  const limits = resolveLimits(overrides);
  const { entries, totalBytes } = await readTarEntries(filePath, limits);
  const projected = entries.map((entry) => {
    const projectedEntry = { path: entry.path, type: entry.type, size: entry.size };
    if (entry.linkname) projectedEntry.linkname = entry.linkname;
    return projectedEntry;
  });
  return { entries: projected, totalBytes };
}

/**
 * 把 library image 解到 `stagingRoot`。
 *
 * Pre-flight 与 post-flight 都是 load-bearing 防御层：
 * - pre-flight 解析 tar header，校验路径形状、条目类型、深度与体积；
 * - post-flight 在 staging 上按 allowlist 走一遍目录树，并核对写出的
 *   每个路径都在 pre-flight 认可的集合内（defense in depth）。
 *
 * @param {string} filePath
 * @param {string} stagingRoot 必须不存在或为空目录；函数只回收自己创建的内容
 * @param {{ imageLimits?: Partial<typeof DEFAULT_LIBRARY_IMAGE_LIMITS>, tarPath?: string, timeoutMs?: number }} [overrides]
 * @returns {Promise<Array<{ absPath: string, type: string }>>}
 */
export async function extractLibraryImage(filePath, stagingRoot, overrides = {}) {
  const limits = resolveLimits(overrides);
  const { entries } = await readTarEntries(filePath, limits);

  for (const entry of entries) {
    assertEntryInsideStaging(entry.path, stagingRoot);
    if (!(overrides.libraryLayout && ['symlink', 'hardlink'].includes(entry.type))) assertEntryTypeAllowed(entry, 'pre-flight');
    if (entry.mode & 0o7000) throw safetyError(`library image declares privileged mode: ${entry.path}`);
    assertEntryDepth(entry, limits);
  }

  if (overrides.libraryLayout) validateImageEntries(entries);
  const staging = await prepareStaging(stagingRoot);

  try {
    const invocation = await resolveTarInvocation(overrides.tarPath, {
      timeoutMs: overrides.timeoutMs
    });
    const extractArgs = composeExtractArgs({
      invocation,
      filePath,
      stagingRoot: staging.stagingRoot
    });
    const { code, stderr } = await spawnTar(extractArgs, {
      tarPath: invocation.binary,
      timeoutMs: overrides.timeoutMs
    });
    if (code !== 0) {
      throw safetyError(`tar extract failed (exit ${code}): ${stderr.trim() || 'no stderr'}`);
    }

    const written = await walkStaging(staging.stagingRoot, overrides.libraryLayout);
    if (overrides.libraryLayout) await verifyImageTree(staging.stagingRoot, entries, overrides);
    const expected = new Set([...buildExpectedPaths(entries)].map(name => name.normalize('NFC')));

    // 安全性质：tar 不得写出 pre-flight 没批准的路径。
    for (const item of written) {
      const relative = path.relative(staging.stagingRoot, item.absPath).split(path.sep).join('/');
      if (!expected.has(relative.normalize('NFC'))) {
        throw safetyError(
          `post-flight found a staged path that pre-flight never advertised: ${relative}`
        );
      }
    }

    // 完整性性质：pre-flight 声明的文件不得被静默丢弃。
    // macOS 打包垃圾（`._*` / `.DS_Store` / `__MACOSX`）由 tar 按 flag 策略消化，不参与核对。
    const writtenRelative = new Set(
      written.map((item) =>
        path.relative(staging.stagingRoot, item.absPath).split(path.sep).join('/').normalize('NFC')
      )
    );
    const missing = entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => normalizeEntryPath(entry.path))
      .filter((relative) => relative && !isMacPackagingJunk(relative))
      .filter((relative) => !writtenRelative.has(relative.normalize('NFC')));
    if (missing.length > 0) {
      throw safetyError(
        `library image advertised ${missing.length} file entries that tar did not write (first: ${missing[0]}); silent filtering would install an incomplete image`
      );
    }

    return written;
  } catch (error) {
    const cleanupError = await cleanupStaging(staging);
    const cleanupNote = cleanupError
      ? ` (staging cleanup also failed, ${staging.stagingRoot} may still hold image content: ${cleanupError.message})`
      : '';
    if (error instanceof SourceAcquisitionError) {
      if (!cleanupNote) throw error;
      throw safetyError(`${error.message}${cleanupNote}`);
    }
    throw safetyError(
      `library image extraction failed: ${
        error instanceof Error ? error.message : String(error)
      }${cleanupNote}`
    );
  }
}

// The workflow uses a private, bounded uncompressed copy for both inspection and
// extraction. System tar never reopens the caller's mutable compressed input.
const execImageGit = promisify(execFile);
const IMAGE_DECLARATIONS = Object.freeze({
  noAbsolutePaths: true, noTraversal: true, noSpecialFiles: true,
  noContiguousEntries: true, noEntriesAfterEnd: true,
  noSymlinkEscape: true, noExternalHardlinks: true, noPrivilegedModes: true
});

function imageError(category, message, exitCode = 1) {
  return new SourceAcquisitionError(category, message, exitCode);
}
function reportImage(context, message) { context.report?.(message); }
function requireImagePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.endsWith('.tar.gz')) {
    throw imageError('argument', 'Library images require a .tar.gz path.', 2);
  }
  return path.resolve(filePath);
}
function wrapImageError(error, category) {
  if (error instanceof SourceAcquisitionError && error.category !== 'source-safety') {
    if (error.category === 'source-collision') return imageError(error.category, error.message);
    return error;
  }
  const filesystem = ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EIO', 'ENOTDIR'].includes(error.code);
  return imageError(filesystem ? 'filesystem' : category, error.message, filesystem ? 3 : 1);
}
async function imageGit(rootDir, ...args) {
  return (await execImageGit('git', ['-C', rootDir, ...args], { timeout: 30_000 })).stdout.trim();
}
async function producerState(rootDir) {
  return {
    commit: await readGitHead(rootDir),
    branch: await imageGit(rootDir, 'symbolic-ref', 'HEAD'),
    dirty: Boolean(await imageGit(rootDir, 'status', '--porcelain')),
    pushed: !await imageGit(rootDir, 'log', '@{u}..', '--oneline')
  };
}
async function imageTree(rootDir, relative = '') {
  const items = [];
  for (const entry of await readdir(path.join(rootDir, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    const absolute = path.join(rootDir, name);
    const info = await lstat(absolute);
    items.push({ path: name, info });
    if (info.isDirectory()) items.push(...await imageTree(rootDir, name));
  }
  return items;
}
function belongsToRegisteredSource(item, records) {
  const itemPath = item.path.normalize('NFC');
  return records.some((record) => {
    const installPath = record.installPath.normalize('NFC');
    return itemPath === installPath ||
      itemPath.startsWith(`${installPath}/`) ||
      (item.info.isDirectory() && installPath.startsWith(`${itemPath}/`));
  });
}
async function carriedEnablements(context, records) {
  const result = [];
  for (const [scope, directory] of Object.entries(imageScopes(context))) {
    for (const item of await scanSkillLinks(directory)) {
      if (!item.isSymlink || item.alias === 'skillcaddy-manager') continue;
      const libraryPath = path.relative(context.rootDir, item.targetPath)
        .split(path.sep)
        .join('/')
        .normalize('NFC');
      if (path.basename(libraryPath) === 'skillcaddy-manager') continue;
      if (records.some((record) => record.skills.some((skill) =>
        path.posix.join(record.installPath, skill).normalize('NFC') === libraryPath
      ))) {
        result.push({ scope, libraryPath, alias: item.alias });
      }
    }
  }
  return result;
}
function imageScopes(context) {
  return { global: getGlobalSkillsDir(context.globalDir), hermes: getHermesSkillsDir(context.hermesDir) };
}
async function checkExport(context) {
  const rootDir = path.resolve(context.rootDir);
  const managedRoot = path.join(rootDir, '.skillcaddy');
  if (await sourcePathExists(managedRoot)) {
    const managedInfo = await lstat(managedRoot);
    if (!managedInfo.isDirectory() || managedInfo.isSymbolicLink() ||
        !isPathInsideOrEqual(await realpath(rootDir), await realpath(managedRoot))) {
      throw imageError('export-blocked', 'The .skillcaddy state directory must be a directory inside the central-library root.');
    }
  }
  const items = [];
  for (const bucket of SOURCE_FOLDERS) {
    if (await sourcePathExists(path.join(rootDir, bucket))) {
      const info = await lstat(path.join(rootDir, bucket));
      if (!info.isDirectory()) throw imageError('export-blocked', `Unsafe bucket: ${bucket}`);
      items.push(...await imageTree(rootDir, bucket));
    }
  }
  if (items.some(item => path.basename(item.path) === SOURCE_INSTALLING_MARKER)) {
    throw imageError('export-blocked', 'Installing marker found. Recover the interrupted source acquisition before export.');
  }
  reportImage(context, '[pass] installing markers');
  const stagingPath = path.join(rootDir, '.skillcaddy/staging');
  if (await sourcePathExists(stagingPath)) {
    throw imageError('export-blocked', 'Staging residue found. Inspect .skillcaddy/staging/ and finish or cancel the interrupted transaction.');
  }
  reportImage(context, '[pass] staging residue');
  const records = await readSourceRecords(rootDir);
  for (const item of items) {
    if (!belongsToRegisteredSource(item, records)) {
      throw imageError('export-blocked', `Unregistered bucket entry: ${item.path}. Register or move it before export.`);
    }
  }
  reportImage(context, '[pass] registered bucket layout');
  for (const record of records) {
    if (!await sourcePathExists(path.join(rootDir, record.installPath)) ||
        !(await lstat(path.join(rootDir, record.installPath))).isDirectory()) {
      throw imageError('export-blocked', `Missing registered directory: ${record.installPath}. Restore it before export.`);
    }
  }
  reportImage(context, '[pass] registered directories');
  const hashes = {};
  const headRecords = [];
  for (const record of records) {
    const source = path.join(rootDir, record.installPath.normalize('NFC'));
    hashes[record.sourceId] = await checksumDirectory(source);
    if (record.type === 'git') headRecords.push({ sourceId: record.sourceId, head: await readGitHead(source) });
    else if (record.integrity &&
      hashes[record.sourceId] !== record.integrity.value &&
      await checksumDirectoryNormalized(source) !== record.integrity.value) {
      throw imageError('export-blocked', `Integrity drift: ${record.sourceId}. Review and repair the source before export.`);
    }
    else if (!record.integrity) {
      reportImage(context, `[warn] integrity baseline unavailable: ${record.sourceId}`);
    }
  }
  reportImage(context, '[pass] source integrity');
  let producer;
  try { producer = await producerState(rootDir); }
  catch { throw imageError('export-blocked', 'Repository state unavailable. Commit on a branch and configure its upstream before export.'); }
  if (producer.dirty || !producer.pushed) throw imageError('export-blocked', 'Repository is dirty or has unpushed commits. Commit and push before export.');
  reportImage(context, '[pass] repository state');
  for (const item of items) {
    if (item.info.mode & 0o7000) throw imageError('export-blocked', `Privileged mode: ${item.path}`);
    if (item.info.isSymbolicLink()) {
      const target = await readlink(path.join(rootDir, item.path));
      const resolved = path.resolve(rootDir, path.dirname(item.path), target);
      if (path.isAbsolute(target) || !isPathInsideOrEqual(rootDir, resolved)) throw imageError('export-blocked', `Escaping symlink: ${item.path}`);
      try {
        if (!isPathInsideOrEqual(await realpath(rootDir), await realpath(path.join(rootDir, item.path)))) throw imageError('export-blocked', `Escaping symlink: ${item.path}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        reportImage(context, `[warn] dead-symlink: ${item.path}`);
      }
    } else if (!item.info.isDirectory() && !item.info.isFile()) throw imageError('export-blocked', `Special file: ${item.path}`);
  }
  const metadataRoot = path.join(rootDir, '.skillcaddy', 'metadata');
  const metadataHash = await checksumOptionalDirectory(metadataRoot);
  const bucketHashes = {};
  for (const bucket of SOURCE_FOLDERS) {
    bucketHashes[bucket] = await checksumOptionalDirectory(path.join(rootDir, bucket));
  }
  const enablement = await carriedEnablements(context, records);
  return { records, hashes, producer, headRecords, enablement, metadataHash, bucketHashes };
}

export async function exportLibraryImage(context, filePath) {
  const destination = requireImagePath(filePath);
  let workspace;
  let temporary;
  try {
    if (await sourcePathExists(destination)) throw imageError('export-blocked', 'Archive already exists. Choose a new .tar.gz destination.');
    const before = await checkExport(context);
    workspace = await createManagedSourceWorkspace(context.rootDir, 'library-image-');
    const packing = path.join(workspace.root, 'pack');
    await mkdir(packing);
    const manifest = { schemaVersion: 1, producer: before.producer,
      sources: before.records.map(({ sourceId, installPath }) => ({ sourceId, installPath })),
      enablement: before.enablement,
      declarations: { ...IMAGE_DECLARATIONS, gitSourceMode: { headRecords: before.headRecords } },
      gitSourceMode: { mode: 'rev-parse-head-only', noIntegrityBaseline: true } };
    await writeFile(path.join(packing, 'library-image.json'), JSON.stringify(manifest, null, 2));
    const members = ['library-image.json'];
    for (const relative of [...SOURCE_FOLDERS, '.skillcaddy/sources', '.skillcaddy/metadata']) {
      if (!await sourcePathExists(path.join(context.rootDir, relative))) continue;
      await mkdir(path.dirname(path.join(packing, relative)), { recursive: true });
      await cp(path.join(context.rootDir, relative), path.join(packing, relative), { recursive: true, verbatimSymlinks: true });
      members.push(relative);
    }
    temporary = path.join(path.dirname(destination), `.library-image-${path.basename(workspace.root)}.tmp`);
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    const invocation = await resolveTarInvocation(context.tarPath || process.env.LIBRARY_IMAGE_TAR_PATH);
    const result = await spawnTar([...invocation.flags, '-czf', temporary, '-C', packing, '--', ...members], { tarPath: invocation.binary, timeoutMs: 300_000 });
    if (result.code !== 0) throw imageError('export-blocked', `Packing failed: ${result.stderr}`);
    await verifyPackedImage(temporary, packing, workspace.root, context);
    for (const record of before.records) {
      if (await checksumDirectory(path.join(context.rootDir, record.installPath)) !== before.hashes[record.sourceId] ||
          await checksumDirectory(path.join(packing, record.installPath)) !== before.hashes[record.sourceId]) {
        throw imageError('export-blocked', `Post-pack source drift: ${record.sourceId}. Retry once the library is idle.`);
      }
    }
    for (const bucket of SOURCE_FOLDERS) {
      if (await checksumOptionalDirectory(path.join(context.rootDir, bucket)) !== before.bucketHashes[bucket]) {
        throw imageError('export-blocked', `Post-pack source tree drift: ${bucket}. Retry once the library is idle.`);
      }
    }
    if (JSON.stringify(await readSourceRecords(context.rootDir)) !== JSON.stringify(before.records) ||
        JSON.stringify(await producerState(context.rootDir)) !== JSON.stringify(before.producer) ||
        await checksumOptionalDirectory(path.join(context.rootDir, '.skillcaddy', 'metadata')) !== before.metadataHash ||
        JSON.stringify(await carriedEnablements(context, before.records)) !== JSON.stringify(before.enablement)) {
      throw imageError('export-blocked', 'Post-pack registry or repository drift. Retry once the library is idle.');
    }
    reportImage(context, '[pass] post-pack drift');
    // Exclusive hard-link publication provides atomic visibility without rename's
    // overwrite race. Both paths are on the destination filesystem.
    try { await link(temporary, destination); }
    catch (error) { if (error.code === 'EEXIST') throw imageError('export-blocked', 'Archive destination became occupied. Choose a new path.'); throw error; }
    return { path: destination, manifest };
  } catch (error) { throw wrapImageError(error, 'export-blocked'); }
  finally {
    if (temporary) await rm(temporary, { force: true });
    if (workspace) await removeManagedSourceWorkspace(workspace);
  }
}

async function checksumOptionalDirectory(directory) {
  if (!await sourcePathExists(directory)) return null;
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw imageError('export-blocked', `Metadata path is not a directory: ${directory}`);
  }
  return checksumDirectory(directory);
}

async function inflateImage(filePath, destination, limits) {
  const input = await open(filePath, 'r');
  try {
    const signature = Buffer.alloc(2);
    await input.read(signature, 0, 2, 0);
    if (signature[0] !== 0x1f || signature[1] !== 0x8b) throw imageError('image-preflight-failed', 'Image is not gzip compressed.');
    let bytes = 0;
    const bound = limits.maxExpandedBytes + limits.maxEntries * 4096;
    await pipeline(input.createReadStream({ start: 0, autoClose: false }), createGunzip(), new Transform({
      transform(chunk, encoding, done) {
        bytes += chunk.length;
        done(bytes > bound ? imageError('image-preflight-failed', 'Expanded tar exceeds image limit.') : null, chunk);
      }
    }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } finally { await input.close(); }
}
function normalizeLinkTarget(target) {
  return target.split('/').map((segment) => segment.normalize('NFC')).join('/');
}
async function normalizeStagingPaths(root) {
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const current = path.join(directory, entry.name);
      const normalizedName = entry.name.normalize('NFC');
      let normalizedPath = current;
      if (normalizedName !== entry.name) {
        normalizedPath = path.join(directory, normalizedName);
        const currentInfo = await lstat(current);
        if (await sourcePathExists(normalizedPath)) {
          // APFS commonly returns decomposed names while treating their NFC
          // spelling as the same directory entry. That is not a collision;
          // two different inodes resolving to one NFC name is.
          const normalizedInfo = await lstat(normalizedPath);
          if (normalizedInfo.dev !== currentInfo.dev || normalizedInfo.ino !== currentInfo.ino) {
            throw imageError('image-staging-verify-failed', `Unicode-normalized path collision: ${entry.name}`);
          }
          normalizedPath = current;
        } else {
          await rename(current, normalizedPath);
        }
      }
      const info = await lstat(normalizedPath);
      if (info.isDirectory()) await walk(normalizedPath);
      else if (info.isSymbolicLink()) {
        const target = await readlink(normalizedPath);
        const normalizedTarget = normalizeLinkTarget(target);
        if (normalizedTarget !== target) {
          await unlink(normalizedPath);
          await symlink(normalizedTarget, normalizedPath);
        }
      }
    }
  }
  await walk(root);
}
async function verifyImageSources(rootDir, manifest, entries = []) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sources) || !Array.isArray(manifest.enablement) ||
      manifest.gitSourceMode?.mode !== 'rev-parse-head-only' || manifest.gitSourceMode.noIntegrityBaseline !== true ||
      !manifest.producer || typeof manifest.producer.commit !== 'string' || typeof manifest.producer.branch !== 'string' ||
      typeof manifest.producer.dirty !== 'boolean' || typeof manifest.producer.pushed !== 'boolean' ||
      Object.keys(IMAGE_DECLARATIONS).some(key => manifest.declarations?.[key] !== true)) {
    throw imageError('image-preflight-failed', 'Invalid library-image.json schema or declarations.');
  }
  validateImageEnablements(manifest.enablement);
  const records = await readSourceRecords(rootDir);
  const registryEnumeration = records
    .map(({ sourceId, installPath }) => ({ sourceId, installPath }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const manifestEnumeration = manifest.sources
    .map((entry) => ({ sourceId: entry?.sourceId, installPath: entry?.installPath }))
    .sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
  if (
    manifest.sources.some((entry) => !entry || typeof entry.sourceId !== 'string' || typeof entry.installPath !== 'string') ||
    JSON.stringify(registryEnumeration) !== JSON.stringify(manifestEnumeration)
  ) throw imageError('image-preflight-failed', 'Manifest source enumeration differs from the registry.');
  for (const record of records) {
    if (records.some(other => other !== record && (other.installPath === record.installPath || other.installPath.startsWith(`${record.installPath}/`)))) throw imageError('image-preflight-failed', 'Overlapping source installation paths.');
  }
  for (const bucket of SOURCE_FOLDERS) {
    if (!await sourcePathExists(path.join(rootDir, bucket))) continue;
    for (const item of await imageTree(rootDir, bucket)) {
      if (!belongsToRegisteredSource(item, records)) throw imageError('image-preflight-failed', `Unregistered image entry: ${item.path}`);
    }
  }
  await assertImageLinksInsideSources(entries, records);
  for (const record of records) {
    const source = path.join(rootDir, record.installPath.normalize('NFC'));
    if (!await sourcePathExists(source) || !(await lstat(source)).isDirectory()) throw imageError('image-staging-verify-failed', `Missing source directory: ${record.sourceId}`);
    if (record.type === 'git') {
      const head = declaredGitHead(manifest, record.sourceId);
      if (!head || await readGitHead(source) !== head) throw imageError('source-validation', `Staged Git HEAD mismatch: ${record.sourceId}`);
    } else if (record.integrity && await checksumDirectoryNormalized(source) !== record.integrity.value) {
      throw imageError('source-validation', `Staged checksum mismatch: ${record.sourceId}`);
    }
  }
  return records;
}

function validateImageEnablements(enablement) {
  const seen = new Set();
  for (const triple of enablement) {
    if (!triple || typeof triple !== 'object' || Array.isArray(triple) ||
        Object.keys(triple).some((key) => !['scope', 'libraryPath', 'alias'].includes(key)) ||
        !['global', 'hermes'].includes(triple.scope) ||
        typeof triple.alias !== 'string' || !triple.alias ||
        triple.alias === '.' || triple.alias === '..' ||
        /[\\/\u0000-\u001f\u007f]/.test(triple.alias) ||
        typeof triple.libraryPath !== 'string' || !triple.libraryPath ||
        path.posix.isAbsolute(triple.libraryPath) || triple.libraryPath.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(triple.libraryPath) ||
        triple.libraryPath.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
        path.posix.normalize(triple.libraryPath) !== triple.libraryPath ||
        !SOURCE_FOLDERS.includes(triple.libraryPath.split('/')[0])) {
      throw imageError('image-preflight-failed', 'Manifest contains a malformed enablement triple.');
    }
    const key = `${triple.scope}\0${triple.alias}`;
    if (seen.has(key)) throw imageError('image-preflight-failed', `Manifest repeats enablement alias: ${triple.scope}/${triple.alias}`);
    seen.add(key);
  }
}

function assertImageLinksInsideSources(entries, records) {
  for (const entry of entries) {
    if (entry.type !== 'symlink') continue;
    const relativePath = normalizeEntryPath(entry.path).normalize('NFC');
    const record = records.find((candidate) => {
      const installPath = candidate.installPath.normalize('NFC');
      return relativePath === installPath || relativePath.startsWith(`${installPath}/`);
    });
    if (!record) {
      throw imageError('image-staging-verify-failed', `Symlink is outside a registered source: ${entry.path}`);
    }
    const sourceRoot = record.installPath.normalize('NFC');
    const target = normalizeEntryPath(
      path.posix.join(path.posix.dirname(relativePath), normalizeLinkTarget(entry.linkname))
    ).normalize('NFC');
    if (target !== sourceRoot && !target.startsWith(`${sourceRoot}/`)) {
      throw imageError('image-staging-verify-failed', `Symlink escapes its source: ${entry.path}`);
    }
  }
}

export async function importLibraryImage(context, filePath, options = {}) {
  const input = requireImagePath(filePath);
  let workspace;
  let preserve = false;
  const skillcaddyRoot = path.join(path.resolve(context.rootDir), '.skillcaddy');
  const skillcaddyExisted = await sourcePathExists(skillcaddyRoot);
  try {
    const inputSha256 = await hashImageFile(input);
    const resumable = await findResumableImageWorkspace(context.rootDir, inputSha256);
    workspace = resumable || await createManagedSourceWorkspace(context.rootDir, 'library-image-');
    const rawTarPath = path.join(workspace.root, 'image.tar');
    const staged = path.join(workspace.root, 'library');
    const limits = resolveWorkflowLimits(context);
    let entries;
    if (resumable) {
      const transaction = await readTransactionMarker(workspace.root);
      if (!transaction?.rawTarSha256 || await hashImageFile(rawTarPath) !== transaction.rawTarSha256) {
        throw imageError('image-staging-verify-failed', `Preserved image staging is incomplete: ${workspace.root}. Delete it and retry.`);
      }
      ({ entries } = await readTarEntries(rawTarPath, limits));
      if (entries[0]?.path !== 'library-image.json' || entries[0]?.type !== 'file') {
        throw imageError('image-preflight-failed', 'Preserved library-image.json is not the first archive entry.');
      }
      await normalizeStagingPaths(staged);
      await verifyResumedImageStaging(staged, entries, context);
    } else {
      await inflateImage(input, rawTarPath, limits);
      ({ entries } = await readTarEntries(rawTarPath, limits));
      if (entries[0]?.path !== 'library-image.json' || entries[0]?.type !== 'file') {
        throw imageError('image-preflight-failed', 'library-image.json must be the first archive entry.');
      }
      await extractLibraryImage(rawTarPath, staged, {
        ...context,
        imageLimits: limits,
        libraryLayout: true,
        tarPath: context.tarPath || process.env.LIBRARY_IMAGE_TAR_PATH
      });
      await normalizeStagingPaths(staged);
    }
    const manifest = JSON.parse(await readFile(path.join(staged, 'library-image.json'), 'utf8'));
    const records = await verifyImageSources(staged, manifest, entries);
    if (resumable) preserve = true;
    const rawTarSha256 = await hashImageFile(rawTarPath);
    if (!resumable) {
      await writeFile(
        path.join(workspace.root, 'transaction.json'),
        JSON.stringify({ kind: 'library-image-import', archiveSha256: inputSha256, rawTarSha256 }),
        { flag: 'wx', mode: 0o600 }
      );
    }
    reportImage(context, '[pass] image unpack and source verification');
    const scopeSnapshot = await snapshotImageScopes(context);
    const enablement = await planImageEnablements(context, manifest.enablement, records, staged);
    const result = { sources: [], enablement };
    for (const record of records) reportImage(context, `[source] ${record.sourceId} -> ${record.installPath}`);
    for (const item of enablement) reportImage(context, `[${item.disposition}] ${item.scope}/${item.alias}`);
    if (options.dryRun) {
      for (const record of records) {
        const plan = await planSourceAcquisition(context, buildImageAcquisitionRequest(record, staged, manifest));
        result.sources.push({ sourceId: record.sourceId, status: plan.status });
        reportImage(context, `[${plan.status}] ${record.sourceId}`);
      }
      return result;
    }
    if (!options.yes && !await options.confirm?.({ sources: records, enablement })) return { ...result, cancelled: true };
    await assertImageScopes(context, scopeSnapshot);
    const committed = [];
    for (const [index, record] of records.entries()) {
      try {
        const receiverRecord = (await readSourceRecords(context.rootDir))
          .find((item) => item.sourceId === record.sourceId);
        const request = buildImageAcquisitionRequest(record, staged, manifest);
        const plan = await planSourceAcquisition(context, request);
        const submitted = await applySourceAcquisition(context, plan);
        if (receiverRecord && JSON.stringify(receiverRecord) !== JSON.stringify(record)) {
          reportImage(context, `[not-applied] receiver source sidecar wins: ${record.sourceId}`);
        }
        result.sources.push(submitted);
        committed.push(record.sourceId);
        reportImage(context, `[${submitted.status}] ${record.sourceId}`);
      } catch (error) {
        preserve = true;
        const detail = `committed: ${committed.join(', ') || '(none)'}\nuncommitted: ${record.sourceId}\nunattempted: ${records.slice(index + 1).map(item => item.sourceId).join(', ') || '(none)'}\nStaging preserved: ${workspace.root}. Re-run image import to resume; delete this staging directory to cancel.`;
        throw imageError(error.category || 'image-source-mismatch', `${error.message}\n${detail}`);
      }
    }
    try {
      await restoreImageMetadata(context, staged, records);
      result.enablement = await applyImageEnablements(context, manifest.enablement, records, scopeSnapshot);
      await ensureSourceDirectory(context.rootDir, '.skillcaddy');
      const breadcrumb = path.join(context.rootDir, '.skillcaddy/library-image-import.json');
      if (await sourcePathExists(breadcrumb) && !(await lstat(breadcrumb)).isFile()) throw imageError('source-safety', 'Provenance breadcrumb is not a regular file.');
      await writeFile(breadcrumb, JSON.stringify(manifest.producer, null, 2));
    } catch (error) {
      preserve = true;
      throw error;
    }
    preserve = false;
    await clearResumedImageWorkspaces(workspace, inputSha256);
    return result;
  } catch (error) { throw wrapImageError(error, 'image-preflight-failed'); }
  finally {
    if (workspace && !preserve) await removeManagedSourceWorkspace(workspace);
    if (!preserve) await removeEmptyImageStagingParent(context.rootDir);
    if (!preserve && !skillcaddyExisted) await removeEmptyImageStateRoot(skillcaddyRoot);
  }
}

function buildImageAcquisitionRequest(record, staged, manifest) {
  const head = record.type === 'git'
    ? declaredGitHead(manifest, record.sourceId)
    : undefined;
  return {
    image: {
      record,
      contentRoot: path.join(staged, record.installPath.normalize('NFC')),
      ...(head ? { head } : {})
    }
  };
}

function declaredGitHead(manifest, sourceId) {
  return manifest.declarations.gitSourceMode?.headRecords
    ?.find((item) => item.sourceId === sourceId)?.head;
}

function isImageMember(name) {
  return name === 'library-image.json' || SOURCE_FOLDERS.some(bucket => name === bucket || name.startsWith(`${bucket}/`)) ||
    name === '.skillcaddy' || ['.skillcaddy/sources', '.skillcaddy/metadata'].some(root => name === root || name.startsWith(`${root}/`));
}
function validateImageEntries(entries) {
  const byPath = new Map();
  const normalizedPaths = new Map();
  for (const entry of entries) {
    const name = normalizeEntryPath(entry.path);
    if (!isImageMember(name) || entry.path.includes('\\')) throw safetyError(`Unexpected image member: ${entry.path}`);
    const normalizedName = name.normalize('NFC');
    const normalizedPrevious = normalizedPaths.get(normalizedName);
    if (normalizedPrevious && normalizedPrevious.path !== entry.path) {
      throw safetyError(`Unicode-normalized path collision: ${entry.path}`);
    }
    normalizedPaths.set(normalizedName, entry);
    if (path.basename(name) === SOURCE_INSTALLING_MARKER) throw safetyError(`Image contains an installing marker: ${name}`);
    const previous = byPath.get(name);
    if (previous && (name === 'library-image.json' || previous.type !== entry.type || ['symlink', 'hardlink'].includes(entry.type))) throw safetyError(`Ambiguous duplicate image member: ${name}`);
    byPath.set(name, entry);
    if (['symlink', 'hardlink'].includes(entry.type)) {
      if (name.startsWith('.skillcaddy/')) throw safetyError(`Registry or metadata link: ${name}`);
      if (!entry.linkname || /^(?:[\\/]|[A-Za-z]:)/.test(entry.linkname) || /[\\\u0000-\u001f\u007f]/.test(entry.linkname) || entry.linkname.includes('\\')) throw safetyError(`Unsafe ${entry.type} target: ${name}`);
      const target = entry.type === 'symlink' ? path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.linkname)) : entry.linkname;
      if (!SOURCE_FOLDERS.some(bucket => target.startsWith(`${bucket}/`)) || (entry.type === 'hardlink' && entry.linkname.split('/').includes('..'))) throw safetyError(`Escaping ${entry.type}: ${name}`);
    }
  }
  // Do not allow tar to traverse any link, including a safe in-library link,
  // while writing another member. This closes order-dependent alias attacks.
  for (const [name, entry] of byPath) {
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index++) {
    const ancestor = byPath.get(segments.slice(0, index).join('/'));
      if (ancestor && ancestor.type !== 'directory') throw safetyError(`Entry traverses a non-directory: ${name}`);
    }
    if (entry.type === 'hardlink' && byPath.get(normalizeEntryPath(entry.linkname))?.type !== 'file') throw safetyError(`Hardlink must target an image regular file: ${name}`);
  }
}
async function verifyImageTree(rootDir, entries, context) {
  const root = await realpath(rootDir);
  const expected = new Map(entries.map(entry => [normalizeEntryPath(entry.path).normalize('NFC'), entry]));
  const inodes = new Map();
  for (const item of await imageTree(rootDir)) {
    const absolute = path.join(rootDir, item.path);
    try {
      if (!isPathInsideOrEqual(root, await realpath(absolute))) throw imageError('image-staging-verify-failed', `Escaping realpath: ${item.path}`);
    } catch (error) {
      if (error.code !== 'ENOENT' || !item.info.isSymbolicLink()) throw error;
      reportImage(context, `[warn] dead-symlink: ${item.path}`);
    }
    const declared = expected.get(item.path.normalize('NFC'));
    if (declared) {
      if (declared.type === 'directory' ? !item.info.isDirectory() : ['file', 'hardlink'].includes(declared.type) && !item.info.isFile()) throw imageError('image-staging-verify-failed', `Staged inode type mismatch: ${item.path}`);
      if (declared.xattrs.length) reportImage(context, `[warn] xattrs: ${item.path} (archive attributes not restored)`);
      for (const [category, actual, original] of [
        ['uid', item.info.uid, declared.uid], ['gid', item.info.gid, declared.gid],
        ['mtime', Math.floor(item.info.mtimeMs / 1000), declared.mtime],
        ['mode', item.info.mode & 0o777, declared.mode & 0o777]
      ]) if (actual !== original) reportImage(context, `[warn] ${category}: ${item.path} (${original} -> ${actual})`);
      if (item.path !== normalizeEntryPath(declared.path)) reportImage(context, `[warn] nfd-roundtrip: ${item.path}`);
      if (declared.type === 'symlink' && (!item.info.isSymbolicLink() || (await readlink(absolute)).normalize('NFC') !== normalizeLinkTarget(declared.linkname).normalize('NFC'))) throw imageError('image-staging-verify-failed', `Symlink mismatch: ${item.path}`);
    }
    if (item.info.mode & 0o7000) throw imageError('image-staging-verify-failed', `Privileged staged mode: ${item.path}`);
    if (item.info.isFile()) {
      const key = `${item.info.dev}:${item.info.ino}`;
      const inode = inodes.get(key) || { count: 0, links: item.info.nlink };
      inode.count++; inodes.set(key, inode);
      if (item.info.nlink > 1) reportImage(context, `[warn] nlink: ${item.path} (${item.info.nlink})`);
    }
  }
  if ([...inodes.values()].some(inode => inode.count !== inode.links)) throw imageError('image-staging-verify-failed', 'Staged hardlink points outside the image.');
}

async function snapshotImageScopes(context) {
  const home = homedir();
  const snapshot = {};
  for (const [scope, directory] of Object.entries(imageScopes(context))) {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    snapshot[scope] = {
      relative: path.relative(home, directory),
      identity: info ? `${info.dev}:${info.ino}` : null,
      realpath: info ? await realpath(directory).catch(() => null) : null
    };
  }
  return snapshot;
}
async function assertImageScopes(context, before) {
  const after = await snapshotImageScopes(context);
  for (const scope of Object.keys(before)) {
    // An explicit directory left behind by a HOME change is dealt with per
    // triple, not mistaken for a change to the configured scope layout.
    if (after[scope].relative.startsWith('..')) continue;
    if (after[scope].relative !== before[scope].relative ||
        (before[scope].identity && after[scope].identity !== before[scope].identity) ||
        (before[scope].realpath && after[scope].realpath !== before[scope].realpath)) {
      throw imageError('stale-plan', `Scope directory changed: ${scope}. Re-run image import to review a new plan.`);
    }
  }
}
async function pathRemainsInside(root, target) {
  if (!isPathInsideOrEqual(path.resolve(root), path.resolve(target))) return false;
  let ancestor = target;
  while (!await sourcePathExists(ancestor)) ancestor = path.dirname(ancestor);
  return isPathInsideOrEqual(await realpath(root), await realpath(ancestor));
}
async function planImageEnablements(context, triples, records, contentRoot = context.rootDir) {
  const scopes = imageScopes(context);
  const home = homedir();
  const result = [];
  for (const triple of triples) {
    const { scope, alias } = triple || {};
    const libraryPath = typeof triple?.libraryPath === 'string'
      ? normalizeEntryPath(triple.libraryPath).normalize('NFC')
      : triple?.libraryPath;
    if (alias === 'skillcaddy-manager' || (typeof libraryPath === 'string' && path.posix.basename(libraryPath) === 'skillcaddy-manager')) continue;
    const item = { scope, alias, libraryPath, disposition: 'unsatisfiable' };
    result.push(item);
    if (!Object.hasOwn(scopes, scope) || typeof alias !== 'string' || !alias || alias === '.' || alias === '..' || /[\\/\u0000-\u001f\u007f]/.test(alias) || typeof libraryPath !== 'string') continue;
    const record = records.find((record) => record.skills.some((skill) =>
      path.posix.join(record.installPath, skill).normalize('NFC') === libraryPath
    ));
    if (!record) continue;
    if (scope === 'hermes' && !isHermesEligibleSource(record.bucket)) { item.disposition = 'ineligible'; continue; }
    const target = path.join(scopes[scope], alias);
    if (!await pathRemainsInside(home, scopes[scope])) continue;
    const skillPath = path.join(contentRoot, libraryPath);
    if (!await sourcePathExists(skillPath) || !await pathRemainsInside(contentRoot, skillPath)) continue;
    const installedTarget = path.resolve(context.rootDir, libraryPath);
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info) item.disposition = 'create';
    else if (!info.isSymbolicLink()) item.disposition = 'conflict:not-a-symlink';
    else item.disposition = path.resolve(path.dirname(target), await readlink(target)) === installedTarget ? 'unchanged' : 'conflict:other-target';
  }
  return result;
}
async function applyImageEnablements(context, triples, records, snapshot) {
  await assertImageScopes(context, snapshot);
  const result = await planImageEnablements(context, triples, records);
  for (const item of result) {
    if (item.disposition === 'create') {
      const directory = imageScopes(context)[item.scope];
      // ensureSourceDirectory refuses symlink ancestors, even inside HOME.
      const relative = path.relative(homedir(), directory);
      await ensureSourceDirectory(homedir(), ...relative.split(path.sep));
      try { await symlink(path.resolve(context.rootDir, item.libraryPath), path.join(directory, item.alias)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        Object.assign(item, (await planImageEnablements(context, [item], records))[0]);
      }
    }
    reportImage(context, `[${item.disposition}] ${item.scope}/${item.alias}`);
  }
  return result;
}
async function restoreImageMetadata(context, staged, records) {
  for (const record of records) {
    for (const skill of record.skills) {
      const libraryPath = path.posix.join(record.installPath, skill).normalize('NFC');
      const relative = `.skillcaddy/metadata/${libraryPath}/skillcaddy.json`;
      if (!await sourcePathExists(path.join(staged, relative))) continue;
      if (await sourcePathExists(path.join(context.rootDir, relative))) {
        reportImage(context, `[not-applied] receiver metadata sidecar wins: ${libraryPath}`);
        continue;
      }
      const metadata = JSON.parse(await readFile(path.join(staged, relative), 'utf8'));
      await ensureSourceDirectory(context.rootDir, ...path.posix.dirname(relative).split('/'));
      try { await updateSkillMetadata(context.rootDir, { ...metadata, skillPath: path.join(context.rootDir, libraryPath), createOnly: true }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        reportImage(context, `[not-applied] receiver metadata sidecar wins: ${libraryPath}`);
      }
    }
  }
}

async function hashImageFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
async function readTransactionMarker(root) {
  const marker = path.join(root, 'transaction.json');
  try {
    if (!(await lstat(marker)).isFile()) return null;
    return JSON.parse(await readFile(marker, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function findResumableImageWorkspace(rootDir, archiveSha256) {
  const parent = await ensureSourceDirectory(rootDir, '.skillcaddy', 'staging');
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^library-image-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const root = path.join(parent, entry.name);
    const transaction = await readTransactionMarker(root);
    if (transaction?.kind === 'library-image-import' && transaction.archiveSha256 === archiveSha256) {
      return { parent, root };
    }
  }
  return null;
}
async function verifyResumedImageStaging(staged, entries, context) {
  validateImageEntries(entries);
  const written = await walkStaging(staged, true);
  const expected = new Set([...buildExpectedPaths(entries)].map((name) => name.normalize('NFC')));
  for (const item of written) {
    const relative = path.relative(staged, item.absPath).split(path.sep).join('/').normalize('NFC');
    if (!expected.has(relative)) throw imageError('image-staging-verify-failed', `Preserved staging contains an unexpected path: ${relative}`);
  }
  const missing = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => normalizeEntryPath(entry.path))
    .filter((relative) => relative && !isMacPackagingJunk(relative))
    .filter((relative) => !expected.has(relative.normalize('NFC')) || !written.some((item) => path.relative(staged, item.absPath).split(path.sep).join('/').normalize('NFC') === relative.normalize('NFC')));
  if (missing.length) throw imageError('image-staging-verify-failed', `Preserved image staging is missing: ${missing[0]}`);
  await verifyImageTree(staged, entries, context);
}
async function clearResumedImageWorkspaces(workspace, archiveSha256) {
  for (const entry of await readdir(workspace.parent, { withFileTypes: true })) {
    const root = path.join(workspace.parent, entry.name);
    if (root === workspace.root || !entry.isDirectory() || !/^library-image-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const marker = path.join(root, 'transaction.json');
    if (!await sourcePathExists(marker) || !(await lstat(marker)).isFile()) continue;
    let transaction;
    try { transaction = JSON.parse(await readFile(marker, 'utf8')); } catch { continue; }
    if (transaction.kind === 'library-image-import' && transaction.archiveSha256 === archiveSha256) await forceRemove(root);
  }
}

async function removeEmptyImageStagingParent(rootDir) {
  await removeEmptyDirectory(path.join(path.resolve(rootDir), '.skillcaddy', 'staging'));
}

async function removeEmptyImageStateRoot(root) {
  await removeEmptyDirectory(root);
}

async function removeEmptyDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length > 0) return;
    await rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function verifyPackedImage(archive, packing, workspace, context) {
  const rawTarPath = path.join(workspace, 'packed.tar');
  const digest = await hashImageFile(archive);
  const limits = resolveWorkflowLimits(context);
  await inflateImage(archive, rawTarPath, limits);
  const { entries } = await readTarEntries(rawTarPath, limits);
  validateImageEntries(entries);
  if (entries[0]?.path !== 'library-image.json') throw imageError('export-blocked', 'Packed manifest is not first.');
  const advertised = new Set(entries.map(entry => normalizeEntryPath(entry.path)));
  for (const item of await imageTree(packing)) {
    if (!item.info.isDirectory() && !advertised.has(item.path)) throw imageError('export-blocked', `Packing omitted library bytes: ${item.path}`);
  }
  const handle = await open(rawTarPath, 'r');
  try {
    for (const entry of entries) {
      if (entry.mode & 0o7000) throw imageError('export-blocked', `Privileged packed mode: ${entry.path}`);
      assertEntryInsideStaging(entry.path, packing);
      if (entry.type === 'file') {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let remaining = entry.size;
        let offset = entry.dataOffset;
        while (remaining) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), offset);
          if (!bytesRead) throw imageError('export-blocked', 'Packed tar was truncated during verification.');
          hash.update(buffer.subarray(0, bytesRead));
          remaining -= bytesRead; offset += bytesRead;
        }
        if (hash.digest('hex') !== await hashImageFile(path.join(packing, entry.path))) throw imageError('export-blocked', `Packed bytes differ: ${entry.path}`);
      }
    }
  } finally { await handle.close(); }
  const roundtrip = path.join(workspace, 'roundtrip');
  try {
    await extractLibraryImage(rawTarPath, roundtrip, {
      ...context,
      imageLimits: limits,
      libraryLayout: true,
      tarPath: context.tarPath || process.env.LIBRARY_IMAGE_TAR_PATH
    });
    await normalizeStagingPaths(roundtrip);
    const roundtripManifest = JSON.parse(await readFile(path.join(roundtrip, 'library-image.json'), 'utf8'));
    await verifyImageSources(roundtrip, roundtripManifest, entries);
  } finally {
    await forceRemove(roundtrip);
  }
  if (await hashImageFile(archive) !== digest) throw imageError('export-blocked', 'Archive changed during the post-pack gate.');
}
