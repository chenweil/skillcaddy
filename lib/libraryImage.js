import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
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
// `gnutar` 目前为空：`--no-selinux` / `--no-overwrite-dir` 只存在于 GNU tar，
// 但本机没有 GNU tar 运行时可验证，未经实测的 flag 一旦拼错会让 Linux 上
// 整条解压路径失败，因此留给 Issue #33 的研究结论填充。
export const LIBRARY_IMAGE_FLAG_POLICY = Object.freeze({
  common: Object.freeze([
    '--no-acls',
    '--no-xattrs',
    '--no-same-permissions',
    '--no-same-owner'
  ]),
  bsdtar: Object.freeze(['--no-mac-metadata', '--no-fflags']),
  gnutar: Object.freeze([])
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
    if (space < 0) break;
    const declaredLength = Number.parseInt(payload.subarray(cursor, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      throw safetyError('library image contains a malformed PAX record length');
    }
    const end = cursor + declaredLength;
    if (end > payload.length) {
      throw safetyError('library image contains a truncated PAX record');
    }
    const body = payload.subarray(space + 1, end).toString('utf8').replace(/\n$/, '');
    const equals = body.indexOf('=');
    if (equals > 0) records[body.slice(0, equals)] = body.slice(equals + 1);
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
    let pending = {};
    const global = {};

    while (offset + BLOCK_SIZE <= fileSize) {
      const blockOffset = offset;
      const block = await readBlock(handle, blockOffset);
      if (isZeroBlock(block)) {
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
          const target = metadataKind === 'pax-global' ? global : pending;
          if (records.path !== undefined) target.path = records.path;
          if (records.linkpath !== undefined) target.linkname = records.linkpath;
          if (records.size !== undefined) {
            const paxSize = Number.parseInt(records.size, 10);
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

      // PAX 覆盖的 size 只影响条目声明，数据块推进仍按 header 的 size 计算，
      // 这与 tar 自身的行为一致。
      entries.push({
        path: entryPath,
        type,
        size: entrySize,
        linkname: type === 'hardlink' || type === 'symlink' ? linkname : undefined
      });
    }

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

async function walkStaging(stagingRoot) {
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
      if (!LIBRARY_IMAGE_ENTRY_TYPES.has(type)) {
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
    assertEntryTypeAllowed(entry, 'pre-flight');
    assertEntryDepth(entry, limits);
  }

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

    const written = await walkStaging(staging.stagingRoot);
    const expected = buildExpectedPaths(entries);

    // 安全性质：tar 不得写出 pre-flight 没批准的路径。
    for (const item of written) {
      const relative = path.relative(staging.stagingRoot, item.absPath).split(path.sep).join('/');
      if (!expected.has(relative)) {
        throw safetyError(
          `post-flight found a staged path that pre-flight never advertised: ${relative}`
        );
      }
    }

    // 完整性性质：pre-flight 声明的文件不得被静默丢弃。
    // macOS 打包垃圾（`._*` / `.DS_Store` / `__MACOSX`）由 tar 按 flag 策略消化，不参与核对。
    const writtenRelative = new Set(
      written.map((item) =>
        path.relative(staging.stagingRoot, item.absPath).split(path.sep).join('/')
      )
    );
    const missing = entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => normalizeEntryPath(entry.path))
      .filter((relative) => relative && !isMacPackagingJunk(relative))
      .filter((relative) => !writtenRelative.has(relative));
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
