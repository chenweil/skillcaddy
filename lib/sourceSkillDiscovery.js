import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED_SKILL_DIRECTORIES = new Set(['docs', 'references', 'tests']);
const MAX_SKILL_DISCOVERY_DEPTH = 4;

export async function discoverSourceSkillDirectories(sourceRoot) {
  if (await pathEntryExists(path.join(sourceRoot, 'SKILL.md'))) return [sourceRoot];

  const skillsRoot = path.join(sourceRoot, 'skills');
  if (await directoryExists(skillsRoot)) {
    const standardSkills = await findNestedSkillDirectories(
      skillsRoot,
      MAX_SKILL_DISCOVERY_DEPTH
    );
    if (standardSkills.length > 0) return standardSkills;
  }

  // Agent Skills 标准容器: `.agents/skills/`
  // 这是 Anthropic 等多 agent 工具约定的官方位置；当仓库既没有 `skills/`
  // 也没有 plugin-style `<name>/skills/` 集合，但仍然遵循该约定时，识别
  // 这里的 skill。该位置优先级低于 `skills/`，仅作为第二标准容器。
  const agentSkillsRoot = path.join(sourceRoot, '.agents', 'skills');
  if (await directoryExists(agentSkillsRoot)) {
    const agentSkills = await findNestedSkillDirectories(
      agentSkillsRoot,
      MAX_SKILL_DISCOVERY_DEPTH
    );
    if (agentSkills.length > 0) return agentSkills;
  }

  const collectionSkills = await findCollectionSkillDirectories(sourceRoot);
  if (collectionSkills.length > 0) return collectionSkills;

  const fallbackSkills = [];
  const singularSkillRoot = path.join(sourceRoot, 'skill');
  if (await directoryExists(singularSkillRoot)) {
    fallbackSkills.push(...await findNestedSkillDirectories(
      singularSkillRoot,
      MAX_SKILL_DISCOVERY_DEPTH
    ));
  }
  fallbackSkills.push(...await findDirectSkillDirectories(sourceRoot));

  return [...new Set(fallbackSkills)].sort((left, right) => left.localeCompare(right));
}

async function findCollectionSkillDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const skills = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      EXCLUDED_SKILL_DIRECTORIES.has(entry.name) ||
      ['skill', 'skills'].includes(entry.name)
    ) continue;
    const collectionSkillsRoot = path.join(directory, entry.name, 'skills');
    if (!await directoryExists(collectionSkillsRoot)) continue;
    skills.push(...await findNestedSkillDirectories(
      collectionSkillsRoot,
      MAX_SKILL_DISCOVERY_DEPTH
    ));
  }
  return skills;
}

async function findNestedSkillDirectories(directory, depth) {
  if (depth < 0) return [];
  if (await pathEntryExists(path.join(directory, 'SKILL.md'))) return [directory];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      EXCLUDED_SKILL_DIRECTORIES.has(entry.name)
    ) continue;
    nested.push(...await findNestedSkillDirectories(path.join(directory, entry.name), depth - 1));
  }
  return nested;
}

async function findDirectSkillDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const skills = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      EXCLUDED_SKILL_DIRECTORIES.has(entry.name)
    ) continue;
    const candidate = path.join(directory, entry.name);
    if (await pathEntryExists(path.join(candidate, 'SKILL.md'))) skills.push(candidate);
  }
  return skills;
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
