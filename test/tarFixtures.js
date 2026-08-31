// Minimal ustar/PAX tar fixture builder for tests. Generates byte-faithful
// archives with arbitrary entry paths, types, and header encodings. Used for
// adversarial fixtures where the system `tar` refuses to construct the entry
// (e.g. `..` paths on bsdtar), where the fixture must declare a non-regular
// typeflag, or where the fixture must exercise a header encoding that a
// simplified parser would read differently from real tar.
//
// Entry options:
//   name        — entry path written to the 100-byte name field
//   content     — file payload (string or Buffer)
//   typeflag    — '0' file (default), '1' hardlink, '2' symlink, '5' directory,
//                 '6' fifo, '3' char device, '4' block device, '7' contiguous
//   mode        — permission bits; defaults to 0755 for directories, 0644 otherwise
//   linkname    — link target for typeflag '1' / '2'
//   prefix      — USTAR prefix field (offset 345); real tar prepends it to name
//   base256Size — encode the size field in base-256 instead of octal
//   sizeOverride— write this size into the header while emitting `content` as-is
//   badChecksum — write a deliberately wrong header checksum
//
// Limitations:
// - `name` must fit in 100 bytes and `prefix` in 155 bytes. Longer paths need a
//   PAX 'x' record (see `paxRecordBlocks`) or a GNU 'L' block.

const HEADER_SIZE = 512;

function padNul(str, length) {
  const buffer = Buffer.alloc(length);
  Buffer.from(String(str), 'utf8').copy(buffer, 0, 0, length);
  return buffer;
}

function octalField(value, length) {
  // ustar numeric fields are `<octal digits><space><NUL>` for 8-byte fields and
  // `<octal digits><space>` for 12-byte fields; both forms are widely accepted.
  const digits = value.toString(8);
  const width = length - 2;
  const field = Buffer.alloc(length);
  field.write(digits.padStart(width, '0'), 0, width, 'ascii');
  field.write('\0 ', width, 2, 'ascii');
  return field;
}

function base256Field(value, length) {
  const field = Buffer.alloc(length);
  let remaining = BigInt(value);
  for (let index = length - 1; index > 0; index -= 1) {
    field[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  field[0] = 0x80;
  return field;
}

function buildHeader(name, size, options = {}) {
  const {
    mode = 0o644,
    typeflag = '0',
    linkname = '',
    prefix = '',
    base256Size = false,
    badChecksum = false
  } = options;

  const header = Buffer.alloc(HEADER_SIZE);
  padNul(name, 100).copy(header, 0);
  octalField(mode, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  (base256Size ? base256Field(size, 12) : octalField(size, 12)).copy(header, 124);
  octalField(0, 12).copy(header, 136); // mtime
  header.write(' '.repeat(8), 148, 8, 'ascii'); // checksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  padNul(linkname, 100).copy(header, 157);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  padNul('', 32).copy(header, 265); // uname
  padNul('', 32).copy(header, 297); // gname
  octalField(0, 8).copy(header, 329); // devmajor
  octalField(0, 8).copy(header, 337); // devminor
  padNul(prefix, 155).copy(header, 345);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  if (badChecksum) checksum += 1;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function payloadBlocks(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
  const padding = (HEADER_SIZE - (body.length % HEADER_SIZE)) % HEADER_SIZE;
  return padding > 0 ? [body, Buffer.alloc(padding)] : [body];
}

function entryBlocks(entry) {
  const content = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content || '');
  const declaredSize = entry.sizeOverride ?? content.length;
  // Real tar records 0755 for directories; 0644 would produce a staged tree the
  // extractor cannot descend into, which is a fixture artifact rather than a
  // property under test.
  const defaultMode = entry.typeflag === '5' ? 0o755 : 0o644;
  const header = buildHeader(entry.name, declaredSize, {
    mode: entry.mode ?? defaultMode,
    typeflag: entry.typeflag,
    linkname: entry.linkname,
    prefix: entry.prefix,
    base256Size: entry.base256Size,
    badChecksum: entry.badChecksum
  });
  return [header, ...payloadBlocks(content)];
}

/**
 * PAX 元数据块（typeflag 'x' 或 'g'）。`records` 是 key -> value；
 * 每条记录按 `<len> <key>=<value>\n` 编码，len 含自身长度。
 */
export function paxRecordBlocks(records, { global = false, name = 'PaxHeader' } = {}) {
  const chunks = [];
  for (const [key, value] of Object.entries(records)) {
    const body = `${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (Buffer.byteLength(`${length} ${body}`) !== length) {
      length = Buffer.byteLength(`${length} ${body}`);
    }
    chunks.push(Buffer.from(`${length} ${body}`, 'utf8'));
  }
  const payload = Buffer.concat(chunks);
  const header = buildHeader(name, payload.length, { typeflag: global ? 'g' : 'x' });
  return [header, ...payloadBlocks(payload)];
}

/**
 * GNU 长文件名块（typeflag 'L'）。
 */
export function gnuLongNameBlocks(longPath) {
  const payload = Buffer.from(`${longPath}\0`, 'utf8');
  const header = buildHeader('././@LongLink', payload.length, { typeflag: 'L' });
  return [header, ...payloadBlocks(payload)];
}

/**
 * 单个 header 块，不带 payload。供需要精确控制块布局的 fixture 使用。
 */
export function rawHeaderBlock(name, size, options = {}) {
  return buildHeader(name, size, options);
}

export const TAR_END_OF_ARCHIVE = Buffer.alloc(HEADER_SIZE * 2);

/**
 * 由条目描述构造归档。
 *
 * @param {Array<object>} entries
 * @param {{ trailer?: Buffer, omitTrailer?: boolean }} [options]
 *   trailer     — 覆盖默认的双零块结束标记（用于「结束标记后藏数据」类 fixture）
 *   omitTrailer — 完全不写结束标记
 */
export function buildTar(entries, options = {}) {
  const blocks = [];
  for (const entry of entries) {
    if (Buffer.isBuffer(entry)) {
      blocks.push(entry);
      continue;
    }
    blocks.push(...entryBlocks(entry));
  }
  if (!options.omitTrailer) {
    blocks.push(options.trailer ?? TAR_END_OF_ARCHIVE);
  }
  return Buffer.concat(blocks);
}
