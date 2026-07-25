import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { validateSourceTree } from './sourceTree.js';
import { validateStagedSource } from './sourceValidation.js';

const execFile = promisify(execFileCallback);

export async function cloneAndInspectGitSource(stagingRoot, parsed) {
  const contentRoot = path.join(stagingRoot, 'repository');
  const cloneArguments = ['clone', '--', parsed.cloneRemote, contentRoot];

  try {
    await execFile('git', cloneArguments);
  } catch (error) {
    throw gitError(`Could not clone Git source: ${safeGitError(error)}`);
  }

  try {
    const focus = parsed.treeSegments
      ? await checkoutGitHubTreeRef(contentRoot, parsed.treeSegments)
      : undefined;
    await validateSourceTree(stagingRoot, contentRoot);
    const validated = await validateStagedSource(contentRoot);
    assertFocusContainsSkill(validated.skills, focus);
    const [{ stdout: commitOutput }, ref] = await Promise.all([
      execFile('git', ['-C', contentRoot, 'rev-parse', 'HEAD']),
      readCheckedOutRef(contentRoot)
    ]);
    return {
      contentRoot,
      commit: commitOutput.trim(),
      ref,
      ...(focus ? { focus } : {}),
      skills: validated.skills,
      warnings: validated.warnings
    };
  } catch (error) {
    if (error instanceof SourceAcquisitionError) throw error;
    throw gitError(error.message);
  }
}

async function checkoutGitHubTreeRef(sourcePath, treeSegments) {
  const { stdout } = await execFile('git', [
    '-C',
    sourcePath,
    'for-each-ref',
    '--format=%(refname:strip=3)',
    'refs/remotes/origin'
  ]);
  const branches = stdout
    .split('\n')
    .map((branch) => branch.trim())
    .filter((branch) => branch && branch !== 'HEAD')
    .filter((branch) => {
      const branchSegments = branch.split('/');
      return branchSegments.every((segment, index) => treeSegments[index] === segment);
    })
    .sort((left, right) => right.split('/').length - left.split('/').length);
  const ref = branches[0];
  if (!ref) {
    throw gitError('GitHub tree URL does not match a repository branch');
  }

  await execFile('git', [
    '-C',
    sourcePath,
    'checkout',
    '--quiet',
    '-B',
    ref,
    `origin/${ref}`
  ]);
  const focusSegments = treeSegments.slice(ref.split('/').length);
  return {
    ref,
    ...(focusSegments.length > 0 ? { path: focusSegments.join('/') } : {})
  };
}

export function prioritizeFocusedSkills(skills, focus) {
  if (!focus?.path) return skills;
  return [...skills].sort((left, right) => {
    const leftFocused = left === focus.path || left.startsWith(`${focus.path}/`);
    const rightFocused = right === focus.path || right.startsWith(`${focus.path}/`);
    return Number(rightFocused) - Number(leftFocused) || left.localeCompare(right);
  });
}

async function readCheckedOutRef(sourcePath) {
  try {
    const { stdout } = await execFile('git', [
      '-C',
      sourcePath,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD'
    ]);
    return stdout.trim();
  } catch {
    throw gitError('Git source must check out a branch');
  }
}

function assertFocusContainsSkill(skills, focus) {
  if (!focus?.path) return;
  const containsSkill = skills.some(
    (skillPath) => skillPath === focus.path || skillPath.startsWith(`${focus.path}/`)
  );
  if (!containsSkill) {
    throw new SourceAcquisitionError(
      'source-validation',
      `GitHub source focus contains no scanner-visible skill: ${focus.path}`
    );
  }
}

function safeGitError(error) {
  const message = typeof error?.stderr === 'string' && error.stderr.trim()
    ? error.stderr.trim()
    : error.message;
  return String(message)
    .replace(/(?:https|ssh):\/\/[^\s'"]+/gi, '[sanitized Git URL]')
    .replace(/(?:[^\s@'"]+@)?[^\s:/'"]+:[^\s'"]+/g, '[sanitized Git URL]');
}

function gitError(message) {
  return new SourceAcquisitionError('git-acquisition', message);
}
