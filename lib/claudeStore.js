import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

export async function syncClaudeSkills(projectPath) {
  const resolvedProjectPath = requirePath(projectPath, 'projectPath');
  const agentsSkills = getAgentsSkillsDir(resolvedProjectPath);
  const claudeSkills = getClaudeSkillsPath(resolvedProjectPath);

  await mkdir(agentsSkills, { recursive: true });
  await mkdir(path.dirname(claudeSkills), { recursive: true });

  if (await linkPathExists(claudeSkills)) {
    const stat = await lstat(claudeSkills);
    if (stat.isSymbolicLink()) {
      const target = await readlink(claudeSkills);
      const resolvedTarget = path.resolve(path.dirname(claudeSkills), target);
      if (resolvedTarget === path.resolve(agentsSkills)) {
        // 旧版：.claude/skills 是指向 .agents/skills 的目录级软链接。迁移为真实目录 + per-skill 软链接。
        await rm(claudeSkills);
      } else {
        // 指向其他位置的自定义软链接，不动
        return { ok: true, linkPath: claudeSkills, targetPath: target, unchanged: true };
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`Claude skills 入口已存在但不是目录：${claudeSkills}`);
    }
  }

  await mkdir(claudeSkills, { recursive: true });

  const agentsEntries = await safeReaddir(agentsSkills);
  let changed = false;

  for (const entry of agentsEntries) {
    const alias = entry.name;
    const linkPath = path.join(claudeSkills, alias);
    if (await linkPathExists(linkPath)) continue;
    await symlink(path.join('..', '..', '.agents', 'skills', alias), linkPath, 'dir');
    changed = true;
  }

  return { ok: true, linkPath: claudeSkills, targetPath: agentsSkills, unchanged: !changed };
}

export async function getClaudeStatus(projectPath) {
  const claudeSkills = getClaudeSkillsPath(projectPath);
  if (!(await linkPathExists(claudeSkills))) {
    return { exists: false, isSymlink: false, linkPath: claudeSkills, targetPath: null, skills: [] };
  }

  const stat = await lstat(claudeSkills);
  const isSymlink = stat.isSymbolicLink();
  return {
    exists: true,
    isSymlink,
    linkPath: claudeSkills,
    targetPath: isSymlink ? await readlink(claudeSkills) : null,
    skills: await scanClaudeSkills(claudeSkills)
  };
}

export async function unlinkClaudeSkills(projectPath) {
  const status = await getClaudeStatus(projectPath);
  if (!status.exists) return { ok: true, ...status, removed: false };

  if (status.isSymlink) {
    await rm(status.linkPath);
    return { ok: true, ...status, removed: true };
  }

  const entries = await safeReaddir(status.linkPath);
  if (entries.length === 0) return { ok: true, ...status, removed: false };
  await Promise.all(entries.map((entry) => rm(path.join(status.linkPath, entry.name))));
  return { ok: true, ...status, removed: true };
}

export async function unlinkClaudeSkill(input) {
  const projectPath = requirePath(input.projectPath, 'projectPath');
  const alias = normalizeAlias(input.alias);
  const linkPath = path.join(getClaudeSkillsPath(projectPath), alias);

  if (!(await linkPathExists(linkPath))) return { ok: true, alias, linkPath, removed: false };
  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink()) throw new Error(`拒绝删除非软链接：${linkPath}`);

  await rm(linkPath);
  return { ok: true, alias, linkPath, removed: true };
}

async function scanClaudeSkills(claudeSkills) {
  const entries = (await safeReaddir(claudeSkills)).sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map((entry) => buildClaudeSkill(claudeSkills, entry.name)));
}

async function buildClaudeSkill(claudeSkills, alias) {
  const linkPath = path.join(claudeSkills, alias);
  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink()) return { alias, linkPath, targetPath: null, isSymlink: false, exists: true };

  const targetPath = path.resolve(path.dirname(linkPath), await readlink(linkPath));
  return { alias, linkPath, targetPath, isSymlink: true, exists: await linkPathExists(targetPath) };
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function getAgentsSkillsDir(projectPath) {
  return path.join(requirePath(projectPath, 'projectPath'), '.agents', 'skills');
}

function getClaudeSkillsPath(projectPath) {
  return path.join(requirePath(projectPath, 'projectPath'), '.claude', 'skills');
}

async function linkPathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function requirePath(value, label) {
  if (!value || typeof value !== 'string') throw new Error(`${label} 不能为空`);
  return path.resolve(value);
}

function normalizeAlias(value) {
  if (!value || typeof value !== 'string') throw new Error('alias 不能为空');
  const alias = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) throw new Error('alias 只能包含字母、数字、点、下划线和短横线');
  return alias;
}
