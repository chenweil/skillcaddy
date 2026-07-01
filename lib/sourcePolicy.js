import path from 'node:path';

export const SOURCE_FOLDERS = ['official', 'github', 'personal', 'archived'];
export const REPOSITORY_SKILLS_SOURCE = 'local';
export const REPOSITORY_SKILLS_FOLDER = 'skills';

export function assertInsideAllowedSkillSources(rootDir, skillPath) {
  if (isInsideAllowedSkillSources(rootDir, skillPath)) return;
  throw new Error('skillPath 必须位于当前 AISkills 的来源目录或仓库 skills 目录内');
}

export function isInsideAllowedSkillSources(rootDir, skillPath) {
  return Boolean(resolveAllowedSkillSource(rootDir, skillPath));
}

export function resolveAllowedSkillSource(rootDir, skillPath) {
  const allowed = [...SOURCE_FOLDERS, REPOSITORY_SKILLS_FOLDER].map((source) => path.join(rootDir, source));
  for (const sourcePath of allowed) {
    const relative = path.relative(sourcePath, skillPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return {
        sourceFolder: path.basename(sourcePath),
        sourcePath,
        relativePath: relative
      };
    }
  }

  return null;
}
