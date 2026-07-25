import path from 'node:path';

export function isPathInsideOrEqual(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
