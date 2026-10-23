import path from 'node:path';
import { normalizeRoots } from './roots.js';

export const SOURCE_FOLDERS = ['official', 'github', 'personal', 'archived'];
export const SOURCE_INSTALLING_MARKER = '.skillcaddy-installing';
export const SOURCE_INSTALLING_MARKER_CONTENT = 'skillcaddy-source-publication-v1\n';
export const REPOSITORY_SKILLS_SOURCE = 'local';
export const REPOSITORY_SKILLS_FOLDER = 'skills';

/**
 * 允许的 skill 来源目录。
 *
 * 四个 source bucket 位于原件库根；仓库自带 skills 桶位于代码根。
 * 两者解耦之后，`npx skillcaddy` 形态下仓库自带 skills 仍然可被识别、可被启用。
 */
function allowedSourcePaths(roots) {
  const { libraryRoot, codeRoot } = normalizeRoots(roots);

  return [
    ...SOURCE_FOLDERS.map((sourceFolder) => ({
      sourceFolder,
      sourcePath: path.join(libraryRoot, sourceFolder)
    })),
    {
      sourceFolder: REPOSITORY_SKILLS_FOLDER,
      sourcePath: path.join(codeRoot, REPOSITORY_SKILLS_FOLDER)
    }
  ];
}

export function assertInsideAllowedSkillSources(roots, skillPath) {
  if (isInsideAllowedSkillSources(roots, skillPath)) return;
  throw new Error('skillPath 必须位于当前 AISkills 的来源目录或仓库 skills 目录内');
}

export function isInsideAllowedSkillSources(roots, skillPath) {
  return Boolean(resolveAllowedSkillSource(roots, skillPath));
}

export function resolveAllowedSkillSource(roots, skillPath) {
  for (const { sourceFolder, sourcePath } of allowedSourcePaths(roots)) {
    const relative = path.relative(sourcePath, skillPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return {
        sourceFolder,
        sourcePath,
        relativePath: relative
      };
    }
  }

  return null;
}
