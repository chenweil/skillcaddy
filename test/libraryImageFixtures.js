import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './testHelpers.js';
import { writeSourceRecord } from '../lib/sourceRegistry.js';
import { checksumDirectory } from '../lib/sourceTree.js';

const exec = promisify(execFile);
export async function git(root, ...args) {
  return (await exec('git', ['-C', root, ...args], { env: {
    ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
  } })).stdout.trim();
}
export async function libraryFixture() {
  const base = await makeTempDir('library-image-workflow-');
  const rootDir = path.join(base, 'library');
  const home = path.join(base, 'home');
  await mkdir(rootDir); await mkdir(home);
  await git(rootDir, 'init', '-b', 'main');
  await writeFile(path.join(rootDir, '.gitignore'), '.skillcaddy/\npersonal/\ngithub/\n');
  await git(rootDir, 'add', '.gitignore');
  await git(rootDir, 'commit', '-m', 'fixture');
  await git(rootDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(rootDir, 'config', 'remote.origin.url', path.join(base, 'unused-remote'));
  await git(rootDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await git(rootDir, 'config', 'branch.main.remote', 'origin');
  await git(rootDir, 'config', 'branch.main.merge', 'refs/heads/main');
  const record = await addImageSource(rootDir, 'alpha');
  return { base, rootDir, home, record, imagePath: path.join(base, 'library.tar.gz'),
    globalDir: path.join(home, '.agents/skills'), hermesDir: path.join(home, '.hermes/skills') };
}
export async function addImageSource(rootDir, name) {
  const installPath = `personal/${name}`;
  const source = path.join(rootDir, installPath);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}\n`);
  const record = { schemaVersion: 1, sourceId: installPath, installPath,
    bucket: 'personal', type: 'legacy-local', origin: { kind: 'unknown' },
    integrity: { algorithm: 'sha256', value: await checksumDirectory(source) }, skills: ['.'] };
  await writeSourceRecord(rootDir, record);
  return record;
}
