import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads name and version from the project's package.json.
 * @param {string} rootDir directory containing package.json
 * @returns {Promise<{ name: string, version: string }>}
 */
export async function readVersion(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  return { name: pkg.name, version: pkg.version };
}