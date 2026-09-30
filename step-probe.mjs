import { readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checksumDirectory, checksumDirectoryNormalized } from './lib/sourceTree.js';
import { writeSourceRecord } from './lib/sourceRegistry.js';
import { libraryFixture } from './test/libraryImageFixtures.js';
import * as imageWorkflow from './lib/libraryImage.js';

const NFD = 'café.md'.normalize('NFD');
async function describe(label, root) {
  const sub = path.join(root, 'personal', 'alpha');
  let names;
  try { names = await readdir(sub); } catch (e) { return `${label}: (unreadable ${e.code})`; }
  const cafe = names.find((n) => n.normalize('NFC') === 'café.md');
  let cs = 'checksum n/a';
  try { cs = `plain=${(await checksumDirectory(sub)).slice(0,12)} norm=${(await checksumDirectoryNormalized(sub)).slice(0,12)}`; } catch (e) { cs = e.code; }
  return `${label}:\n  isNFD=${cafe === NFD} isNFC=${cafe === 'café.md'}  ${cs}`;
}
const fixture = await libraryFixture();
const source = path.join(fixture.rootDir, fixture.record.installPath);
await writeFile(path.join(source, NFD), 'body');
fixture.record.integrity.value = await checksumDirectory(source);
await writeSourceRecord(fixture.rootDir, fixture.record);
console.log('platform:', process.platform);
console.log('BASELINE (producer source):');
console.log('  isNFD=true  plain=' + fixture.record.integrity.value.slice(0,12));
globalThis.__STEP = async (label, dir) => { console.log(await describe(label, dir)); };
await imageWorkflow.exportLibraryImage(fixture, fixture.imagePath);
const receiver = path.join(fixture.base, 'receiver'); await mkdir(receiver);
try {
  const r = await imageWorkflow.importLibraryImage({ ...fixture, rootDir: receiver }, fixture.imagePath, { yes: true });
  console.log('\nIMPORT OK:', JSON.stringify(r.sources.map(s => s.status)));
} catch (e) {
  console.log('\nIMPORT FAILED: ' + e.message);
}
console.log(await describe('FINAL receiver', receiver));
