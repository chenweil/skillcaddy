import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = 'skillcaddy';
const COMMAND_ENTRY = 'scripts/tui.js';

export async function getSkillcaddyInstallPaths(rootDir, options = {}) {
  const sourcePath = path.resolve(rootDir);
  const globalRoot = options.globalRoot || await getNpmGlobalRoot(options);
  return {
    sourcePath,
    targetPath: path.join(path.resolve(globalRoot), PACKAGE_NAME)
  };
}

export async function checkSkillcaddyInstall(rootDir, options = {}) {
  const paths = await getSkillcaddyInstallPaths(rootDir, options);
  if (!await isSkillcaddyPackage(paths.sourcePath)) {
    return {
      ok: false,
      status: 'source-invalid',
      ...paths,
      message: `Skillcaddy clone does not expose the CLI/TUI command: ${paths.sourcePath}`
    };
  }

  const target = await safeLstat(paths.targetPath);
  if (!target) {
    return {
      ok: false,
      status: 'missing',
      ...paths,
      message: `Skillcaddy CLI/TUI command is not linked: ${paths.targetPath}`
    };
  }

  let linkTarget;
  try {
    linkTarget = await realpath(paths.targetPath);
  } catch {
    return {
      ok: false,
      status: 'conflict',
      ...paths,
      message: `global Skillcaddy package link is broken: ${paths.targetPath}`
    };
  }

  const sourceTarget = await realpath(paths.sourcePath);
  if (linkTarget !== sourceTarget) {
    return {
      ok: false,
      status: 'conflict',
      ...paths,
      linkTarget,
      message: `global Skillcaddy package points elsewhere: ${linkTarget}`
    };
  }

  return {
    ok: true,
    status: 'installed',
    ...paths,
    linkTarget,
    command: 'skillcaddy',
    message: 'Skillcaddy CLI/TUI command is linked to this clone'
  };
}

export async function installTuiCommand(rootDir, options = {}) {
  const current = await checkSkillcaddyInstall(rootDir, options);
  if (current.status === 'installed') {
    return { ...current, unchanged: true };
  }
  if (current.status !== 'missing') {
    throw new Error(current.message);
  }

  const linkPackage = options.linkPackage || linkCurrentPackage;
  await linkPackage(current.sourcePath, options);

  const installed = await checkSkillcaddyInstall(rootDir, options);
  if (!installed.ok) {
    throw new Error(installed.message);
  }
  return { ...installed, unchanged: false };
}

export const getCliInstallPaths = getSkillcaddyInstallPaths;
export const checkCliInstall = checkSkillcaddyInstall;
export const installCliCommand = installTuiCommand;
export const getTuiInstallPaths = getSkillcaddyInstallPaths;
export const checkTuiInstall = checkSkillcaddyInstall;
export const installSkillcaddyCommand = installTuiCommand;

async function getNpmGlobalRoot(options) {
  const npmCommand = options.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const { stdout } = await execFileAsync(npmCommand, ['root', '--global'], {
    encoding: 'utf8'
  });
  return stdout.trim();
}

async function linkCurrentPackage(rootDir, options) {
  const npmCommand = options.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await execFileAsync(npmCommand, ['link', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
}

async function isSkillcaddyPackage(rootDir) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
    if (packageJson.name !== PACKAGE_NAME || packageJson.bin?.skillcaddy !== COMMAND_ENTRY) return false;
    await access(path.join(rootDir, COMMAND_ENTRY));
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
