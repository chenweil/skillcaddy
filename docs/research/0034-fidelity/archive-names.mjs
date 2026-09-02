#!/usr/bin/env node
// 打印 tar 归档内真实存储的条目名字节。
//
// 存在理由：`tar -tf` 打印的是经过本机 tar 与本机 locale 处理后的名字，
// 不是归档里的字节。判定 unicode 规范化差异的归属时，必须直接读 header。
//
// 只读 header 的 100 字节 name 字段与 PAX `path` 记录，不解压内容。

import { readFile } from 'node:fs/promises';

const BLOCK = 512;

function isAscii(buffer) {
  for (const byte of buffer) {
    if (byte > 0x7f) return false;
  }
  return true;
}

function readNameField(buffer, offset) {
  const field = buffer.subarray(offset, offset + 100);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? 100 : end);
}

function readOctal(buffer, offset, length) {
  const raw = buffer.subarray(offset, offset + length).toString('ascii');
  const trimmed = raw.replace(/\0/g, ' ').trim();
  if (!/^[0-7]+$/.test(trimmed)) return 0;
  return Number.parseInt(trimmed, 8);
}

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: archive-names.mjs <archive.tar>\n');
  process.exit(2);
}

const buffer = await readFile(file);
const rows = [];

for (let offset = 0; offset + BLOCK <= buffer.length; ) {
  const name = readNameField(buffer, offset);
  if (name.length === 0) {
    offset += BLOCK;
    continue;
  }

  const typeflag = String.fromCharCode(buffer[offset + 156]);
  const size = readOctal(buffer, offset + 124, 12);
  const dataOffset = offset + BLOCK;

  // PAX 扩展头里的 path 记录会覆盖 header name，必须一并读出。
  if (typeflag === 'x' || typeflag === 'g') {
    const payload = buffer.subarray(dataOffset, dataOffset + size);
    const text = payload.toString('utf8');
    const match = /\d+ path=([^\n]*)\n/.exec(text);
    if (match && !isAscii(Buffer.from(match[1], 'utf8'))) {
      const bytes = Buffer.from(match[1], 'utf8');
      rows.push({
        source: `PAX ${typeflag}`,
        utf8: match[1],
        hex: bytes.toString('hex'),
        form: bytes.equals(Buffer.from(match[1].normalize('NFC'))) ? 'NFC' : 'NFD/other'
      });
    }
  } else if (!isAscii(name)) {
    const text = name.toString('utf8');
    rows.push({
      source: `header '${typeflag}'`,
      utf8: text,
      hex: name.toString('hex'),
      form: name.equals(Buffer.from(text.normalize('NFC'))) ? 'NFC' : 'NFD/other'
    });
  }

  offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
}

if (rows.length === 0) {
  process.stdout.write('  归档内没有非 ASCII 条目名。\n');
} else {
  for (const row of rows) {
    process.stdout.write(`  [${row.source}] ${JSON.stringify(row.utf8)}\n`);
    process.stdout.write(`      hex=${row.hex} form=${row.form}\n`);
  }
}
