import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSourceSkillDirectories } from '../lib/sourceSkillDiscovery.js';
import { makeTempDir } from './testHelpers.js';

test('discovers repositories with skills in direct root children', async () => {
  const source = await makeTempDir('source-discovery-root-children-');
  await writeSkill(source, 'agent-dx-cli-scale');
  await writeSkill(source, 'another-skill');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['agent-dx-cli-scale', 'another-skill']
  );
});

test('discovers skills in the .agents/skills agent standard container', async () => {
  const source = await makeTempDir('source-discovery-agents-container-');
  await writeSkill(source, '.agents/skills/alpha');
  await writeSkill(source, '.agents/skills/beta');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['.agents/skills/alpha', '.agents/skills/beta']
  );
});

test('prefers the skills container over .agents/skills when both exist', async () => {
  const source = await makeTempDir('source-discovery-agents-vs-skills-');
  await writeSkill(source, 'skills/primary');
  await writeSkill(source, '.agents/skills/mirror');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['skills/primary']
  );
});

test('excludes support directories inside the .agents/skills container', async () => {
  const source = await makeTempDir('source-discovery-agents-support-');
  await writeSkill(source, '.agents/skills/valid');
  await writeSkill(source, '.agents/skills/references');
  await writeSkill(source, '.agents/skills/docs');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['.agents/skills/valid']
  );
});

test('discovers repositories using a singular skill container', async () => {
  const source = await makeTempDir('source-discovery-singular-container-');
  await writeSkill(source, 'skill/opentui');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['skill/opentui']
  );
});

test('keeps the standard skills container authoritative when it has skills', async () => {
  const source = await makeTempDir('source-discovery-standard-container-');
  await writeSkill(source, 'skills/standard');
  await writeSkill(source, 'plugin/skills/ignored');
  await writeSkill(source, 'example');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['skills/standard']
  );
});

test('discovers skills in multiple plugin skills containers', async () => {
  const source = await makeTempDir('source-discovery-plugin-containers-');
  await writeSkill(source, 'teaching/skills/create-learning-path');
  await writeSkill(source, 'teaching/skills/run-learning-retrospective');
  await writeSkill(source, 'create-plugin/skills/review-plugin-submission');
  await writeSkill(source, 'create-plugin/skills/docs');
  await writeSkill(source, 'create-plugin/skills/group/references');
  await writeSkill(source, 'create-plugin/skills/tests/fixture');
  await writeSkill(source, 'nested/plugin/skills/not-a-plugin-skill');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    [
      'create-plugin/skills/review-plugin-submission',
      'teaching/skills/create-learning-path',
      'teaching/skills/run-learning-retrospective'
    ]
  );
});

test('excludes support directories inside a standard skills container', async () => {
  const source = await makeTempDir('source-discovery-standard-support-');
  await writeSkill(source, 'skills/valid');
  await writeSkill(source, 'skills/docs');
  await writeSkill(source, 'skills/group/references');
  await writeSkill(source, 'skills/tests/fixture');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['skills/valid']
  );
});

test('excludes support directories from fallback layouts', async () => {
  const source = await makeTempDir('source-discovery-fallback-support-');
  await writeSkill(source, 'skill/opentui');
  await writeSkill(source, 'skill/references');
  await writeSkill(source, 'docs');
  await writeSkill(source, 'references');
  await writeSkill(source, 'tests');

  assert.deepEqual(
    relativePaths(source, await discoverSourceSkillDirectories(source)),
    ['skill/opentui']
  );
});

async function writeSkill(source, relativePath) {
  const skillDirectory = path.join(source, relativePath);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), `# ${path.basename(relativePath)}\n`);
}

function relativePaths(source, directories) {
  return directories.map((directory) => path.relative(source, directory).split(path.sep).join('/'));
}
