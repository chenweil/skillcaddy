import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { SourceMigrationIssue } from './sourceMigrationIssue.js';
import { sanitizeGitRemote } from './sourceRecord.js';

const execFile = promisify(execFileCallback);

export async function inspectGitSource(sourcePath) {
  const remotes = await readOriginRemotes(sourcePath);
  if (remotes.length !== 1) {
    throw new SourceMigrationIssue(
      'ambiguous-remote',
      'Git source must have one unambiguous origin remote'
    );
  }

  let remote;
  let repositoryPath;
  try {
    remote = sanitizeGitRemote(remotes[0]);
    repositoryPath = parseRepositoryPath(remote);
  } catch (error) {
    throw new SourceMigrationIssue('ambiguous-remote', error.message);
  }

  const { stdout: commitOutput } = await execFile('git', ['-C', sourcePath, 'rev-parse', 'HEAD']);
  const ref = await readGitRef(sourcePath);
  return {
    sourceId: `github/${repositoryPath}`,
    origin: {
      kind: 'git',
      remote,
      ...(ref ? { ref } : {}),
      commit: commitOutput.trim()
    }
  };
}

async function readOriginRemotes(sourcePath) {
  let remoteOutput;
  try {
    ({ stdout: remoteOutput } = await execFile('git', [
      '-C',
      sourcePath,
      'remote',
      'get-url',
      '--all',
      'origin'
    ]));
  } catch {
    throw new SourceMigrationIssue('ambiguous-remote', 'Git source has no readable origin remote');
  }
  return [...new Set(
    remoteOutput.split('\n').map((remote) => remote.trim()).filter(Boolean)
  )];
}

function parseRepositoryPath(remote) {
  const repositoryPath = remote.includes('://')
    ? new URL(remote).pathname
    : remote.slice(remote.indexOf(':') + 1);
  const normalized = repositoryPath
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (normalized.split('/').length < 2) {
    throw new Error('Git origin does not identify an owner and repository');
  }
  return normalized;
}

async function readGitRef(sourcePath) {
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
    return null;
  }
}
