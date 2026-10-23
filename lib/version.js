import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRoots } from './roots.js';

/**
 * Reads name and version from the project's package.json.
 * @param {string|{ libraryRoot?: string, codeRoot?: string }} roots code root, or a legacy single root
 * @returns {Promise<{ name: string, version: string }>}
 */
export async function readVersion(roots) {
  const { codeRoot } = normalizeRoots(roots);
  const pkgPath = path.join(codeRoot, 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  return { name: pkg.name, version: pkg.version };
}