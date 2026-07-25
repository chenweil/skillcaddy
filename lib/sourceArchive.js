import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  rm
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_SIGNATURES = new Set([ZIP_LOCAL_SIGNATURE, ZIP_END_SIGNATURE, 0x08074b50]);

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxExpandedBytes: 500 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 30
});

export async function hasZipSignature(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === signature.length && ZIP_SIGNATURES.has(signature.readUInt32LE(0));
  } finally {
    await handle.close();
  }
}

export async function extractZip(filePath, destination, overrides = {}) {
  const limits = resolveLimits(overrides);
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const directory = await readCentralDirectory(handle, stat.size, limits);
    await validateOutputPaths(directory.entries, destination, limits);
    await mkdir(destination, { recursive: true });

    const totals = { expandedBytes: 0 };
    for (const entry of directory.entries) {
      if (entry.ignored) continue;
      const targetPath = path.join(destination, ...entry.path.split('/'));
      if (entry.directory) {
        await mkdir(targetPath, { recursive: true, mode: entry.permissions });
      } else {
        await extractFile(handle, entry, targetPath, directory.centralOffset, limits, totals);
      }
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (error instanceof SourceAcquisitionError) throw error;
    throw archiveError(error.message);
  } finally {
    await handle.close();
  }
}

async function readCentralDirectory(handle, fileSize, limits) {
  const tailLength = Math.min(fileSize, 65_557);
  const tail = Buffer.alloc(tailLength);
  await readExactly(handle, tail, fileSize - tailLength);
  const endOffset = findEndRecord(tail);
  const diskNumber = tail.readUInt16LE(endOffset + 4);
  const centralDisk = tail.readUInt16LE(endOffset + 6);
  const diskEntries = tail.readUInt16LE(endOffset + 8);
  const totalEntries = tail.readUInt16LE(endOffset + 10);
  const centralSize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw archiveError('Multi-disk and ZIP64 archives are not supported');
  }
  if (totalEntries > limits.maxEntries) {
    throw archiveError(`ZIP entry count exceeds limit ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize > fileSize) {
    throw archiveError('ZIP central directory escapes the archive');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const header = Buffer.alloc(46);
    await readExactly(handle, header, cursor);
    if (header.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE) {
      throw archiveError('Invalid ZIP central directory entry');
    }
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const nameBuffer = Buffer.alloc(nameLength);
    await readExactly(handle, nameBuffer, cursor + header.length);
    entries.push(parseCentralEntry(header, nameBuffer));
    cursor += header.length + nameLength + extraLength + commentLength;
    if (cursor > centralOffset + centralSize) {
      throw archiveError('ZIP central directory entry exceeds its declared size');
    }
  }
  if (cursor !== centralOffset + centralSize) {
    throw archiveError('ZIP central directory size does not match its entries');
  }
  return { centralOffset, entries };
}

function parseCentralEntry(header, nameBuffer) {
  const flags = header.readUInt16LE(8);
  if (flags & 0x1) throw archiveError('Encrypted ZIP entries are not supported');
  const method = header.readUInt16LE(10);
  if (![0, 8].includes(method)) {
    throw archiveError(`Unsupported ZIP compression method: ${method}`);
  }

  const name = decodeEntryName(nameBuffer, Boolean(flags & 0x800));
  const versionMadeBy = header.readUInt16LE(4);
  const externalAttributes = header.readUInt32LE(38);
  const unixMode = versionMadeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
  const entryType = unixMode & 0o170000;
  if (entryType === 0o120000) throw archiveError(`ZIP symlink entry is not allowed: ${safeName(name)}`);
  if (entryType && ![0o040000, 0o100000].includes(entryType)) {
    throw archiveError(`ZIP special file entry is not allowed: ${safeName(name)}`);
  }

  const directory = entryType === 0o040000 ||
    Boolean(externalAttributes & 0x10) ||
    name.endsWith('/');
  return {
    compressedSize: header.readUInt32LE(20),
    crc32: header.readUInt32LE(16),
    directory,
    flags,
    localOffset: header.readUInt32LE(42),
    method,
    nameBuffer,
    path: validateEntryPath(name, directory),
    permissions: unixMode ? unixMode & 0o777 : directory ? 0o755 : 0o644,
    uncompressedSize: header.readUInt32LE(24)
  };
}

async function validateOutputPaths(entries, destination, limits) {
  const outputTypes = new Map();
  for (const entry of entries) {
    entry.ignored = isMacPackagingJunk(entry.path);
    if (entry.ignored) continue;

    const segments = entry.path.split('/');
    const depth = entry.directory ? segments.length : segments.length - 1;
    if (depth > limits.maxDepth) {
      throw archiveError(`ZIP directory depth exceeds limit ${limits.maxDepth}: ${safeName(entry.path)}`);
    }
    const resolved = path.resolve(destination, ...segments);
    const relative = path.relative(path.resolve(destination), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw archiveError(`ZIP destination escape is not allowed: ${safeName(entry.path)}`);
    }

    if (outputTypes.has(entry.path)) {
      throw archiveError(`Duplicate ZIP output path: ${safeName(entry.path)}`);
    }
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (outputTypes.get(ancestor) === 'file') {
        throw archiveError(`ZIP output path crosses a file: ${safeName(entry.path)}`);
      }
    }
    if (!entry.directory) {
      for (const knownPath of outputTypes.keys()) {
        if (knownPath.startsWith(`${entry.path}/`)) {
          throw archiveError(`ZIP file conflicts with a directory: ${safeName(entry.path)}`);
        }
      }
    }
    outputTypes.set(entry.path, entry.directory ? 'directory' : 'file');
  }
}

async function extractFile(handle, entry, targetPath, centralOffset, limits, totals) {
  const localHeader = Buffer.alloc(30);
  await readExactly(handle, localHeader, entry.localOffset);
  if (localHeader.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
    throw archiveError(`Invalid ZIP local header: ${safeName(entry.path)}`);
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const localName = Buffer.alloc(nameLength);
  await readExactly(handle, localName, entry.localOffset + localHeader.length);
  if (!localName.equals(entry.nameBuffer)) {
    throw archiveError(`ZIP local and central names differ: ${safeName(entry.path)}`);
  }
  if (
    localHeader.readUInt16LE(6) !== entry.flags ||
    localHeader.readUInt16LE(8) !== entry.method
  ) {
    throw archiveError(`ZIP local and central metadata differ: ${safeName(entry.path)}`);
  }

  const dataStart = entry.localOffset + localHeader.length + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > centralOffset) {
    throw archiveError(`ZIP entry data escapes the content region: ${safeName(entry.path)}`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const verifier = new ContentVerifier(entry, limits, totals);
  const compressedStream = entry.compressedSize === 0
    ? Readable.from([])
    : createReadStream(null, {
        fd: handle.fd,
        start: dataStart,
        end: dataEnd - 1,
        autoClose: false
      });
  const output = createWriteStream(targetPath, {
    flags: 'wx',
    mode: entry.permissions
  });
  const streams = entry.method === 8
    ? [compressedStream, createInflateRaw(), verifier, output]
    : [compressedStream, verifier, output];
  try {
    await pipeline(...streams);
  } catch (error) {
    await rm(targetPath, { force: true });
    if (error instanceof SourceAcquisitionError) throw error;
    throw archiveError(`Could not extract ZIP entry ${safeName(entry.path)}: ${error.message}`);
  }
  verifier.assertComplete();
}

class ContentVerifier extends Transform {
  constructor(entry, limits, totals) {
    super();
    this.entry = entry;
    this.limits = limits;
    this.totals = totals;
    this.bytes = 0;
    this.crc = 0xffffffff;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    this.totals.expandedBytes += chunk.length;
    if (this.bytes > this.limits.maxFileBytes) {
      callback(archiveError(`ZIP individual file exceeds limit ${this.limits.maxFileBytes}: ${safeName(this.entry.path)}`));
      return;
    }
    if (this.totals.expandedBytes > this.limits.maxExpandedBytes) {
      callback(archiveError(`ZIP expanded content exceeds limit ${this.limits.maxExpandedBytes}`));
      return;
    }
    this.crc = updateCrc32(this.crc, chunk);
    callback(null, chunk);
  }

  assertComplete() {
    if (this.bytes !== this.entry.uncompressedSize) {
      throw archiveError(`ZIP written size does not match metadata: ${safeName(this.entry.path)}`);
    }
    if (((this.crc ^ 0xffffffff) >>> 0) !== this.entry.crc32) {
      throw archiveError(`ZIP checksum does not match content: ${safeName(this.entry.path)}`);
    }
  }
}

function validateEntryPath(name, directory) {
  if (name.includes('\0')) throw archiveError('ZIP entry name contains NUL');
  if (name.includes('\\')) throw archiveError(`ZIP entry name contains a backslash: ${safeName(name)}`);
  if (/^[A-Za-z]:\//.test(name)) throw archiveError(`ZIP drive-letter path is not allowed: ${safeName(name)}`);
  if (name.startsWith('/')) throw archiveError(`ZIP absolute path is not allowed: ${safeName(name)}`);

  const withoutTrailingSlash = directory ? name.replace(/\/+$/, '') : name;
  const segments = withoutTrailingSlash.split('/');
  if (
    !withoutTrailingSlash ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    const reason = segments.includes('..') ? 'path traversal' : 'invalid path';
    throw archiveError(`ZIP ${reason} is not allowed: ${safeName(name)}`);
  }
  return segments.join('/');
}

function decodeEntryName(buffer, utf8) {
  if (!utf8 && buffer.some((byte) => byte > 0x7f)) {
    throw archiveError('Non-UTF-8 ZIP entry names are not supported');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw archiveError('ZIP entry name is not valid UTF-8');
  }
}

function findEndRecord(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw archiveError('ZIP end record was not found');
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytesRead === 0) throw archiveError('ZIP file is truncated');
    offset += bytesRead;
  }
}

function resolveLimits(overrides) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid archive limit ${name}`);
    }
  }
  return limits;
}

function isMacPackagingJunk(entryPath) {
  const segments = entryPath.split('/');
  const basename = segments.at(-1);
  return segments[0] === '__MACOSX' || basename === '.DS_Store' || basename.startsWith('._');
}

function updateCrc32(initial, buffer) {
  let crc = initial;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return crc >>> 0;
}

function safeName(name) {
  return name.replace(/\0/g, '\\0');
}

function archiveError(message) {
  return new SourceAcquisitionError('archive-safety', message);
}
