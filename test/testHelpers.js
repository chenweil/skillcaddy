import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix) {
  return mkdir(path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });
}
