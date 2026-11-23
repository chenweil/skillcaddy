import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix) {
  // `mkdir({ recursive: true })` resolves to `undefined` on Node 22, so the
  // caller cannot use the return value as a path. Build the path first.
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
