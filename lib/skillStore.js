import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink
} from 'node:fs/promises';
import path from 'node:path';
import { getClaudeStatus } from './claudeStore.js';

export const SOURCE_FOLDERS = ['official', 'github', 'personal', 'archived'];

export async function ensureSourceFolders(rootDir) {
  await Promise.all(SOURCE_FOLDERS.map((source) => mkdir(path.join(rootDir, source), { recursive: true })));
}

export async function getState(rootDir, projectPath) {
  await ensureSourceFolders(rootDir);
  const skills = await scanSkills(rootDir);
  const enabled = await scanEnabledSkills(projectPath);

  return {
    rootDir,
    projectPath,
    skills,
    enabled,
    claude: await getClaudeStatus(projectPath),
    stats: { total: skills.length, enabled: enabled.length, available: skills.filter((skill) => skill.source !== 'archived').length }
  };
}

export async function scanSkills(rootDir) {
  const groups = await Promise.all(SOURCE_FOLDERS.map((source) => scanSourceFolder(rootDir, source)));

  return groups.flat().sort(compareSkills);
}

function compareSkills(left, right) {
  return left.collection.localeCompare(right.collection) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

async function scanSourceFolder(rootDir, source) {
  const sourceDir = path.join(rootDir, source);
  const entries = await safeReaddir(sourceDir);
  const skillGroups = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => scanSourceEntry(source, sourceDir, entry.name))
  );
  return skillGroups.flat();
}

export async function scanEnabledSkills(projectPath) {
  const skillsDir = getAgentsSkillsDir(projectPath);
  const entries = await safeReaddir(skillsDir);
  const records = await Promise.all(
    entries.map(async (entry) => {
      const linkPath = path.join(skillsDir, entry.name);
      const stat = await lstat(linkPath);

      if (!stat.isSymbolicLink()) {
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

  return records.sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function enableSkill(rootDir, input) {
  const projectPath = requirePath(input.projectPath, 'projectPath');
  const skillPath = requirePath(input.skillPath, 'skillPath');
  const alias = normalizeAlias(input.alias || path.basename(skillPath));
  const resolvedSkillPath = path.resolve(skillPath);

  assertInsideSources(rootDir, resolvedSkillPath);
  await assertDirectory(resolvedSkillPath, 'skillPath');

  const skillsDir = getAgentsSkillsDir(projectPath);
  await mkdir(skillsDir, { recursive: true });

  const linkPath = path.join(skillsDir, alias);
  if (await linkPathExists(linkPath)) {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`目标已存在且不是软链接：${linkPath}`);
    }

    const existingTarget = await resolveLinkTarget(linkPath);
    if (existingTarget !== resolvedSkillPath) {
      throw new Error(`别名已指向其他 skill：${existingTarget}`);
    }

    return { ok: true, alias, linkPath, targetPath: resolvedSkillPath, unchanged: true };
  }

  await symlink(resolvedSkillPath, linkPath, 'dir');
  return { ok: true, alias, linkPath, targetPath: resolvedSkillPath, unchanged: false };
}

export async function disableSkill(input) {
  const projectPath = requirePath(input.projectPath, 'projectPath');
  const alias = normalizeAlias(input.alias);
  const linkPath = path.join(getAgentsSkillsDir(projectPath), alias);

  if (!(await linkPathExists(linkPath))) {
    return { ok: true, alias, linkPath, removed: false };
  }

  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(`拒绝删除非软链接：${linkPath}`);
  }

  await rm(linkPath);
  return { ok: true, alias, linkPath, removed: true };
}

function getAgentsSkillsDir(projectPath) {
  return path.join(requirePath(projectPath, 'projectPath'), '.agents', 'skills');
}

async function scanSourceEntry(source, sourceDir, entryName) {
  const entryPath = path.join(sourceDir, entryName);
  const directSkillFile = path.join(entryPath, 'SKILL.md');

  if (await pathExists(directSkillFile)) {
    return [await buildSkillRecord(source, sourceDir, entryPath, entryName, entryName)];
  }

  const skillsRoot = path.join(entryPath, 'skills');
  if (!(await pathExists(skillsRoot))) {
    return [];
  }

  const skillDirs = await findSkillDirs(skillsRoot, 4);
  return Promise.all(
    skillDirs.map((skillPath) => {
      const relative = path.relative(sourceDir, skillPath);
      const name = relative === `${entryName}/skills` ? entryName : path.basename(skillPath);
      return buildSkillRecord(source, sourceDir, skillPath, name, entryName);
    })
  );
}

async function findSkillDirs(dir, depth) {
  if (depth < 0) return [];
  if (await pathExists(path.join(dir, 'SKILL.md'))) return [dir];

  const entries = await safeReaddir(dir);
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  const groups = await Promise.all(folders.map((entry) => findSkillDirs(path.join(dir, entry.name), depth - 1)));

  return groups.flat();
}

async function buildSkillRecord(source, sourceDir, skillPath, name, collection) {
  const skillFile = path.join(skillPath, 'SKILL.md');
  const relativePath = path.relative(sourceDir, skillPath);
  const description = await readSkillDescription(skillFile);
  const collectionPath = path.join(sourceDir, collection);

  return {
    id: `${source}/${relativePath}`,
    source,
    collection,
    collectionPath,
    name,
    path: skillPath,
    relativePath,
    hasSkillFile: true,
    description
  };
}

async function readSkillDescription(skillFile) {
  const content = await readFile(skillFile, 'utf8');
  const match = content.match(/^description:\s*(.+)$/m);
  return match ? match[1].replace(/^["']|["']$/g, '') : firstMarkdownLine(content);
}

function firstMarkdownLine(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('---') && !line.startsWith('#')) || '';
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function resolveLinkTarget(linkPath) {
  const target = await readlink(linkPath);
  return path.resolve(path.dirname(linkPath), target);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function linkPathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(targetPath, label) {
  const stat = await lstat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} 必须是目录：${targetPath}`);
  }
}

function assertInsideSources(rootDir, skillPath) {
  const allowed = SOURCE_FOLDERS.map((source) => path.join(rootDir, source));
  const inside = allowed.some((sourcePath) => {
    const relative = path.relative(sourcePath, skillPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });

  if (!inside) {
    throw new Error('skillPath 必须位于当前 AISkills 的来源目录内');
  }
}

function requirePath(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} 不能为空`);
  }

  return path.resolve(value);
}

function normalizeAlias(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('alias 不能为空');
  }

  const alias = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    throw new Error('alias 只能包含字母、数字、点、下划线和短横线');
  }

  return alias;
}
