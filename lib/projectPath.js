import { homedir } from 'node:os';
import path from 'node:path';

const SYSTEM_PROJECT_PATHS = new Set([
  path.parse(process.cwd()).root,
  '/Applications',
  '/Library',
  '/System',
  '/bin',
  '/etc',
  '/opt',
  '/private',
  '/sbin',
  '/tmp',
  '/usr',
  '/var'
]);

export function normalizeProjectPath(value) {
  const projectPath = requirePath(value, 'projectPath');
  assertSafeProjectPath(projectPath);
  return projectPath;
}

export function requirePath(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} 不能为空`);
  }

  return path.resolve(value);
}

function assertSafeProjectPath(projectPath) {
  if (SYSTEM_PROJECT_PATHS.has(projectPath)) {
    throw new Error(`projectPath 不能是系统目录：${projectPath}`);
  }

  const homePath = path.resolve(homedir());
  if (projectPath === homePath) {
    throw new Error(`projectPath 不能是用户主目录：${projectPath}`);
  }

  if (isAncestor(projectPath, homePath)) {
    throw new Error(`projectPath 不能是用户主目录的父目录：${projectPath}`);
  }
}

function isAncestor(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
