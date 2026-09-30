/**
 * Reports, at each instrumented export step, the raw entry names and both
 * checksums. Run on macOS and on Linux; the difference between the two
 * outputs is the answer to where the Unicode form changes.
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checksumDirectory, checksumDirectoryNormalized } from './lib/sourceTree.js';
import { writeSourceRecord } from './lib/sourceRegistry.js';
import { libraryFixture } from './test/libraryImageFixtures.js';
import * as imageWorkflow from './lib/libraryImage.js';

const NFD = 'café.md'.normalize('NFD');

async function describe(label, root) {
  const sub = path.join(root, 'personal', 'alpha');
  let names;
  try {
    names = await readdir(sub);
  } catch (e) {
    return `${label}: (unreadable ${e.code})`;
  }
  const cafe = names.find((n) => n.normalize('NFC') === 'café.md');
  const out = [
    `${label}:`,
    `  listed   = ${JSON.stringify(names)}`,
    `  isNFD=${cafe === NFD} isNFC=${cafe === 'café.md'} hex=${cafe ? Buffer.from(cafe, 'utf8').toString('hex') : 'n/a'}`
  ];
  try {
    out.push(`  plain=${(await checksumDirectory(sub)).slice(0, 12)} norm=${(await checksumDirectoryNormalized(sub)).slice(0, 12)}`);
  } catch (e) {
    out.push(`  checksum failed: ${e.code}`);
  }
  return out.join('\n');
}

const fixture = await libraryFixture();
const source = path.join(fixture.rootDir, fixture.record.installPath);
await writeFile(path.join(source, NFD), 'body');
fixture.record.integrity.value = await checksumDirectory(source);
await writeSourceRecord(fixture.rootDir, fixture.record);

console.log('platform:', process.platform);
console.log(await describe('0 BASELINE', fixture.rootDir));

globalThis.__STEP = async (label, dir) => {
  // packing and roundtrip are workspace siblings of 'personal'
  const text = await describe(label, dir);
  console.log(text);
};

try {
  await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
  console.log('\nEXPORT SUCCEEDED');
} catch (e) {
  console.log('\nEXPORT FAILED: ' + e.message);
}
