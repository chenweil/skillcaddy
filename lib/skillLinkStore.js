import { constants } from 'node:fs';
import { access, lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

export async function scanSkillLinks(skillsDir) {
  const entries = await safeReaddir(skillsDir);
  const records = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry) => {
        const linkPath = path.join(skillsDir, entry.name);
        const stat = await lstat(linkPath);

        if (!stat.isSymbolicLink()) {
          if (!stat.isDirectory()) return null;
          return {
            alias: entry.name,
            linkPath,
            targetPath: null,
            isSymlink: false,
            exists: true
          };
        }

        const targetPath = await resolveLinkTarget(linkPath);
        return {
          alias: entry.name,
          linkPath,
          targetPath,
          isSymlink: true,
          exists: await pathExists(targetPath)
        };
      })
  );

  return records.filter(Boolean).sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function resolveLinkTarget(linkPath) {
  const target = await readlink(linkPath);
  return path.resolve(path.dirname(linkPath), target);
}

export async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function linkPathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
