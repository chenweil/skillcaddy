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
import { homedir } from 'node:os';
import path from 'node:path';
import { getClaudeStatus } from './claudeStore.js';
import { normalizeProjectPath, requirePath } from './projectPath.js';
import { readSkillMetadata } from './skillMetadata.js';
import {
  assertInsideAllowedSkillSources,
  isInsideAllowedSkillSources,
  REPOSITORY_SKILLS_FOLDER,
  REPOSITORY_SKILLS_SOURCE,
  SOURCE_FOLDERS
} from './sourcePolicy.js';

export async function ensureSourceFolders(rootDir) {
  await Promise.all(
    [...SOURCE_FOLDERS, REPOSITORY_SKILLS_FOLDER].map((source) => mkdir(path.join(rootDir, source), { recursive: true }))
  );
}

export async function getState(rootDir, projectPath) {
  const safeProjectPath = normalizeProjectPath(projectPath);
  await ensureSourceFolders(rootDir);
  const skills = await scanSkills(rootDir);
  const enabled = await scanEnabledSkills(safeProjectPath);
  const global = await scanGlobalSkills();
  const advice = buildSkillAdvice(rootDir, { skills, enabled, global });

  return {
    rootDir,
    projectPath: safeProjectPath,
    skills,
    enabled,
    global,
    advice,
    claude: await getClaudeStatus(safeProjectPath),
    stats: { total: skills.length, enabled: enabled.length, available: skills.filter((skill) => skill.source !== 'archived').length }
  };
}

export async function scanSkills(rootDir) {
  const groups = await Promise.all([
    scanRepositorySkills(rootDir),
    ...SOURCE_FOLDERS.map((source) => scanSourceFolder(rootDir, source))
  ]);

  return groups.flat().sort(compareSkills);
}

function compareSkills(left, right) {
  return left.collection.localeCompare(right.collection) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

async function scanRepositorySkills(rootDir) {
  return scanSourceFolder(rootDir, REPOSITORY_SKILLS_FOLDER, REPOSITORY_SKILLS_SOURCE);
}

async function scanSourceFolder(rootDir, sourceFolder, source = sourceFolder) {
  const sourceDir = path.join(rootDir, sourceFolder);
  const entries = await safeReaddir(sourceDir);
  const skillGroups = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => scanSourceEntry(rootDir, source, sourceDir, entry.name))
  );
  return skillGroups.flat();
}

export async function scanEnabledSkills(projectPath) {
  return scanSkillLinks(getAgentsSkillsDir(normalizeProjectPath(projectPath)));
}

export async function scanGlobalSkills() {
  const dirs = [
    { agent: 'Codex', scope: 'global', directory: path.join(homedir(), '.agents', 'skills') },
    { agent: 'Claude Code', scope: 'global', directory: path.join(homedir(), '.claude', 'skills') }
  ];
  const groups = await Promise.all(
    dirs.map(async (dir) => {
      const skills = await scanSkillLinks(dir.directory);
      return skills.map((skill) => ({ ...skill, agent: dir.agent, scope: dir.scope, directory: dir.directory }));
    })
  );

  return groups.flat().sort((left, right) => left.agent.localeCompare(right.agent) || left.alias.localeCompare(right.alias));
}

async function scanSkillLinks(skillsDir) {
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

function buildSkillAdvice(rootDir, { skills, enabled, global }) {
  const advice = [];
  const availableByName = groupBy(skills.filter((skill) => skill.source !== 'archived'), (skill) => skill.name);
  const projectByAlias = new Map(enabled.map((skill) => [skill.alias, skill]));
  const globalByAlias = groupBy(global, (skill) => skill.alias);
  const legacyMetadataSkills = skills.filter((skill) => skill.metadataStorage === 'legacy');

  if (legacyMetadataSkills.length > 0) {
    advice.push({
      severity: 'warning',
      type: 'legacy-metadata-deprecated',
      title: `发现 ${legacyMetadataSkills.length} 个 legacy metadata 文件`,
      detail: 'v0.15.0 将停止运行时读取 legacy 路径。请先运行 npm run migrate:metadata 预检，再加 -- --yes 执行迁移。',
      skills: legacyMetadataSkills.map((skill) => ({ id: skill.id, path: skill.metadataPath })),
      actions: [{
        type: 'migrate-metadata',
        previewCommand: 'npm run migrate:metadata',
        applyCommand: 'npm run migrate:metadata -- --yes'
      }]
    });
  }

  for (const skill of enabled) {
    if (!skill.isSymlink) {
      advice.push({
        severity: 'warning',
        type: 'project-unmanaged-entry',
        title: `项目存在非软链接 skill：${skill.alias}`,
        detail: `${skill.linkPath} 不是 Skillcaddy 可安全清理的软链接。启用同名 skill 前请先确认该目录用途。`,
        alias: skill.alias,
        path: skill.linkPath
      });
      continue;
    }

    if (!skill.exists) {
      advice.push({
        severity: 'warning',
        type: 'project-broken-link',
        title: `项目 skill 断链：${skill.alias}`,
        detail: `${skill.linkPath} 指向不存在的目标：${skill.targetPath}`,
        alias: skill.alias,
        path: skill.linkPath,
        targetPath: skill.targetPath
      });
      continue;
    }

    if (!isInsideAllowedSkillSources(rootDir, skill.targetPath)) {
      advice.push({
        severity: 'info',
        type: 'project-unmanaged-symlink',
        title: `项目存在不纳管 skill：${skill.alias}`,
        detail: `${skill.alias} 指向 Skillcaddy 来源目录之外：${skill.targetPath}`,
        alias: skill.alias,
        path: skill.linkPath,
        targetPath: skill.targetPath
      });
    }
  }

  for (const [alias, globalMatches] of globalByAlias) {
    const projectSkill = projectByAlias.get(alias);
    if (projectSkill) {
      advice.push({
        severity: 'info',
        type: 'global-shadowed-by-project',
        title: `项目 skill 会遮蔽全局 skill：${alias}`,
        detail: `${alias} 同时存在于项目和全局目录。通常项目级优先，若行为异常请确认 agent 的加载顺序。`,
        alias,
        global: globalMatches.map(formatSkillLocation),
        project: formatSkillLocation(projectSkill)
      });
    }

    const availableMatches = availableByName.get(alias) || [];
    for (const availableSkill of availableMatches) {
      if (projectSkill?.targetPath === availableSkill.path) continue;
      if (globalMatches.some((skill) => skill.targetPath === availableSkill.path)) continue;
      advice.push({
        severity: 'info',
        type: 'global-alias-conflict',
        title: `全局已存在同名 skill：${alias}`,
        detail: `启用 ${availableSkill.source}/${availableSkill.collection}/${availableSkill.name} 到项目后，会与全局 ${alias} 同名。`,
        alias,
        skillId: availableSkill.id,
        global: globalMatches.map(formatSkillLocation)
      });
    }
  }

  for (const [name, matches] of availableByName) {
    if (matches.length <= 1) continue;
    const reservedAliases = new Set([...projectByAlias.keys(), ...globalByAlias.keys()]);
    const skillsWithAliases = matches.map((skill) => ({
      id: skill.id,
      source: skill.source,
      collection: skill.collection,
      path: skill.path,
      suggestedAlias: suggestUniqueAlias(skill, reservedAliases)
    }));
    advice.push({
      severity: 'info',
      type: 'library-duplicate-name',
      title: `原件库存在同名 skill：${name}`,
      detail: `启用时需要按来源确认；可在 skill 详情中使用建议名称，避免默认 alias ${name} 指向非预期 skill。`,
      alias: name,
      skills: skillsWithAliases,
      actions: skillsWithAliases.map((skill) => ({
        type: 'enable-with-alias',
        skillId: skill.id,
        alias: skill.suggestedAlias
      }))
    });
  }

  return advice.sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.title.localeCompare(right.title));
}

function suggestUniqueAlias(skill, reservedAliases) {
  const prefix = skill.collection === skill.name ? skill.source : skill.collection;
  const base = normalizeSuggestedAlias(`${prefix}-${skill.name}`) || normalizeSuggestedAlias(`${skill.source}-${skill.name}`) || 'skill';
  let alias = base;
  let suffix = 2;
  while (reservedAliases.has(alias)) {
    alias = `${base}-${suffix}`;
    suffix += 1;
  }
  reservedAliases.add(alias);
  return alias;
}

function normalizeSuggestedAlias(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function formatSkillLocation(skill) {
  return {
    alias: skill.alias,
    path: skill.linkPath,
    targetPath: skill.targetPath,
    isSymlink: skill.isSymlink,
    exists: skill.exists,
    agent: skill.agent
  };
}

function severityRank(severity) {
  return { warning: 2, info: 1 }[severity] || 0;
}

export async function enableSkill(rootDir, input) {
  const projectPath = normalizeProjectPath(input.projectPath);
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
  const projectPath = normalizeProjectPath(input.projectPath);
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
  return path.join(normalizeProjectPath(projectPath), '.agents', 'skills');
}

async function scanSourceEntry(rootDir, source, sourceDir, entryName) {
  const entryPath = path.join(sourceDir, entryName);
  const directSkillFile = path.join(entryPath, 'SKILL.md');

  if (await pathExists(directSkillFile)) {
    return [await buildSkillRecord(rootDir, source, sourceDir, entryPath, entryName, entryName)];
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
      return buildSkillRecord(rootDir, source, sourceDir, skillPath, name, entryName);
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

async function buildSkillRecord(rootDir, source, sourceDir, skillPath, name, collection) {
  const skillFile = path.join(skillPath, 'SKILL.md');
  const relativePath = path.relative(sourceDir, skillPath);
  const [description, metadata] = await Promise.all([
    readSkillDescription(skillFile),
    readSkillMetadata(rootDir, skillPath)
  ]);
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
    description,
    note: metadata.note,
    tags: metadata.tags,
    autoEnable: metadata.autoEnable,
    metadataPath: metadata.metadataPath,
    metadataStorage: metadata.metadataStorage,
    hasMetadata: metadata.hasMetadata,
    metadataError: metadata.metadataError
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
  assertInsideAllowedSkillSources(rootDir, skillPath);
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
