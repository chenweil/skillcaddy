import { access, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MANAGER_SKILL_NAME = 'skillcaddy-manager';

export function getManagerInstallPaths(rootDir, options = {}) {
  const homeDir = options.homeDir || homedir();
  return {
    sourcePath: path.join(path.resolve(rootDir), 'skills', MANAGER_SKILL_NAME),
    targetPath: path.join(path.resolve(homeDir), '.agents', 'skills', MANAGER_SKILL_NAME)
  };
}

export async function checkManagerInstall(rootDir, options = {}) {
  const paths = getManagerInstallPaths(rootDir, options);
  const sourceOk = await isSkillDirectory(paths.sourcePath);
  if (!sourceOk) {
    return {
      ok: false,
      status: 'source-missing',
      ...paths,
      message: `manager skill source is missing: ${paths.sourcePath}`
    };
  }

  const target = await safeLstat(paths.targetPath);
  if (!target) {
    return {
      ok: false,
      status: 'missing',
      ...paths,
      message: `manager skill is not installed: ${paths.targetPath}`
    };
  }

  if (!target.isSymbolicLink()) {
    return {
      ok: false,
      status: 'conflict',
      ...paths,
      message: `target exists but is not a symlink: ${paths.targetPath}`
    };
  }

  const linkTarget = await readlink(paths.targetPath);
  const resolvedTarget = path.resolve(path.dirname(paths.targetPath), linkTarget);
  if (resolvedTarget !== paths.sourcePath) {
    return {
      ok: false,
      status: 'conflict',
      ...paths,
      linkTarget: resolvedTarget,
      message: `target symlink points elsewhere: ${resolvedTarget}`
    };
  }

  return {
    ok: true,
    status: 'installed',
    ...paths,
    linkTarget: resolvedTarget,
    message: `manager skill is installed: ${paths.targetPath}`
  };
}

export async function installManagerSkill(rootDir, options = {}) {
  const current = await checkManagerInstall(rootDir, options);
  if (current.status === 'installed') {
    return { ...current, unchanged: true };
  }

  if (current.status !== 'missing') {
    throw new Error(current.message);
  }

  await mkdir(path.dirname(current.targetPath), { recursive: true });
  await symlink(current.sourcePath, current.targetPath, 'dir');

  const installed = await checkManagerInstall(rootDir, options);
  if (!installed.ok) {
    throw new Error(installed.message);
  }

  return { ...installed, unchanged: false };
}

async function isSkillDirectory(skillPath) {
  const stat = await safeLstat(skillPath);
  if (!stat?.isDirectory()) return false;

  try {
    await access(path.join(skillPath, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}

async function safeLstat(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
