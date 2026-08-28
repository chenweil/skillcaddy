// Minimal ustar tar fixture builder for tests. Generates byte-faithful USTAR
// archives with arbitrary entry paths. Use for adversarial fixtures where the
// system `tar` may refuse to construct the entry (e.g. `..` paths on bsdtar).
//
// Limitations:
// - Entry paths must fit in the 100-byte USTAR name field (< 100 UTF-8 bytes).
//   For longer names, callers should shard or extend with PAX 'L' entries.
// - Only file entries are supported (no directories, symlinks, hardlinks).
//   T3 will extend with symlink/hardlink types.
// - Permissions default to 0o644 and the build does not preserve size beyond
//   `content.length`.

const HEADER_SIZE = 512;
const BLOCK_SIZE = 512;

function padNul(str, length) {
  // NUL-pad short strings to fixed length, matching what bsdtar emits.
  const truncated = str.length > length ? str.slice(0, length) : str;
  return truncated + '\0'.repeat(length - truncated.length);
}

function padSpaces(str, length) {
  // Space-pad the variable regions; bsdtar treats them as column-aligned context.
  const truncated = str.length > length ? str.slice(0, length) : str;
  return truncated + ' '.repeat(length - truncated.length);
}

function octalString(value, length) {
  // Octal as NUL-terminated ASCII digits with trailing-space padding before the terminator.
  const digits = value.toString(8);
  const buffer = length - 1; // Reserve the last byte for the NUL terminator.
  const padded = digits.padStart(buffer - 1, '0');
  return (padded + ' ').slice(-buffer) + '\0';
}

function buildHeader(name, size, mode = 0o644) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(padNul(name, 100), 0, 100, 'utf8');
  header.write(octalString(mode, 8), 100, 8, 'ascii');
  header.write(octalString(0, 8), 108, 8, 'ascii'); // uid
  header.write(octalString(0, 8), 116, 8, 'ascii'); // gid
  header.write(octalString(size, 12), 124, 12, 'ascii');
  header.write(octalString(0, 12), 136, 12, 'ascii'); // mtime
  // Checksum placeholder: spaces during compute, then actual digits.
  header.write(' '.repeat(8), 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
  header.write(padNul('', 100), 157, 100, 'utf8'); // linkname
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(padNul('', 32), 265, 32, 'utf8'); // uname
  header.write(padNul('', 32), 297, 32, 'utf8'); // gname
  header.write(octalString(0, 8), 329, 8, 'ascii'); // devmajor
  header.write(octalString(0, 8), 337, 8, 'ascii'); // devminor
  header.write(padNul('', 155), 345, 155, 'utf8'); // prefix

  // Compute checksum over header bytes (with the checksum field as spaces).
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumString = checksum.toString(8).padStart(6, '0');
  header.write(checksumString + '\0 ', 148, 8, 'ascii');
  return header;
}

export function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content || '');
    const header = buildHeader(entry.name, content.length, entry.mode);
    blocks.push(header);
    blocks.push(content);
    const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  // End-of-archive marker: two zero blocks.
  blocks.push(Buffer.alloc(HEADER_SIZE));
  blocks.push(Buffer.alloc(HEADER_SIZE));
  return Buffer.concat(blocks);
}
