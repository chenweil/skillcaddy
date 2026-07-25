import { deflateRawSync } from 'node:zlib';

export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const fixture of entries) {
    const name = Buffer.isBuffer(fixture.name)
      ? fixture.name
      : Buffer.from(fixture.name, 'utf8');
    const content = Buffer.from(fixture.content || '');
    const method = fixture.method === 'store' ? 0 : 8;
    const compressed = method === 0 ? content : deflateRawSync(content);
    const crc = crc32(content);
    const flags = fixture.utf8 === false ? 0 : 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(fixture.compressedSize ?? compressed.length, 18);
    local.writeUInt32LE(fixture.uncompressedSize ?? content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(fixture.compressedSize ?? compressed.length, 20);
    central.writeUInt32LE(fixture.uncompressedSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = fixture.mode ?? (String(fixture.name).endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
