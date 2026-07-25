import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function discoverSourceSkillDirectories(sourceRoot) {
  if (await pathEntryExists(path.join(sourceRoot, 'SKILL.md'))) return [sourceRoot];

  const skillsRoot = path.join(sourceRoot, 'skills');
  if (!(await directoryExists(skillsRoot))) return [];
  return findNestedSkillDirectories(skillsRoot, 4);
}

async function findNestedSkillDirectories(directory, depth) {
  if (depth < 0) return [];
  if (await pathEntryExists(path.join(directory, 'SKILL.md'))) return [directory];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    nested.push(...await findNestedSkillDirectories(path.join(directory, entry.name), depth - 1));
  }
  return nested;
}

async function pathEntryExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function directoryExists(targetPath) {
  try {
    return (await lstat(targetPath)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
