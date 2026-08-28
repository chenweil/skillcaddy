// Minimal ustar tar fixture builder for tests. Generates byte-faithful USTAR
// archives with arbitrary entry paths and types. Used for adversarial fixtures
// where the system `tar` may refuse to construct the entry (e.g. `..` paths on
// bsdtar) or where the fixture must declare a non-regular-file typeflag.
//
// Limitations:
// - Entry paths must fit in the 100-byte USTAR name field (< 100 UTF-8 bytes).
//   For longer names, callers should shard or extend with PAX 'L' entries.
// - Supported typeflags: '0' (regular file, default), '1' (hardlink, requires
//   linkname), '2' (symlink, requires linkname), '5' (directory), '6' (fifo),
//   '3' (character device), '4' (block device). T3 will extend as needed.

const HEADER_SIZE = 512;

function padNul(str, length) {
  const truncated = str.length > length ? str.slice(0, length) : str;
  return truncated + '\0'.repeat(length - truncated.length);
}

function octalString(value, length) {
  const digits = value.toString(8);
  const buffer = length - 1;
  const padded = digits.padStart(buffer - 1, '0');
  return (padded + ' ').slice(-buffer) + '\0';
}

function buildHeader(name, size, { mode = 0o644, typeflag = '0', linkname = '' } = {}) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(padNul(name, 100), 0, 100, 'utf8');
  header.write(octalString(mode, 8), 100, 8, 'ascii');
  header.write(octalString(0, 8), 108, 8, 'ascii'); // uid
  header.write(octalString(0, 8), 116, 8, 'ascii'); // gid
  header.write(octalString(size, 12), 124, 12, 'ascii');
  header.write(octalString(0, 12), 136, 12, 'ascii'); // mtime
  header.write(' '.repeat(8), 148, 8, 'ascii'); // checksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write(padNul(linkname, 100), 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(padNul('', 32), 265, 32, 'utf8'); // uname
  header.write(padNul('', 32), 297, 32, 'utf8'); // gname
  header.write(octalString(0, 8), 329, 8, 'ascii'); // devmajor
  header.write(octalString(0, 8), 337, 8, 'ascii'); // devminor
  header.write(padNul('', 155), 345, 155, 'utf8'); // prefix

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
    const header = buildHeader(entry.name, content.length, {
      mode: entry.mode,
      typeflag: entry.typeflag,
      linkname: entry.linkname
    });
    blocks.push(header);
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(HEADER_SIZE));
  blocks.push(Buffer.alloc(HEADER_SIZE));
  return Buffer.concat(blocks);
}
