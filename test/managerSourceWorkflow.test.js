import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyManagerSourceWorkflow,
  planManagerSourceWorkflow
} from '../lib/managerSourceWorkflow.js';
import { makeTempDir } from './testHelpers.js';

test('acquisition-only Manager requests change only the central library', async () => {
  const root = await makeTempDir('manager-source-root-');
  const project = await makeTempDir('manager-source-project-');
  const input = await makeSource('manager-source-input-', ['review']);

  const plan = await planManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    { acquisition: { input, name: 'review-pack' } }
  );

  assert.equal(plan.acquisition.action, 'add');
  assert.equal(plan.enablement, null);

  const result = await applyManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    plan
  );

  assert.equal(result.acquisition.status, 'added');
  await access(path.join(root, 'personal', 'review-pack', 'skills', 'review', 'SKILL.md'));
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );
});

test('registry identity routes Manager acquisition to update', async () => {
  const root = await makeTempDir('manager-update-root-');
  const original = await makeSource('manager-update-original-', ['review']);
  const replacement = await makeSource('manager-update-replacement-', ['review'], 'Updated');

  const addPlan = await planManagerSourceWorkflow(
    { rootDir: root },
    { acquisition: { input: original, name: 'review-pack' } }
  );
  await applyManagerSourceWorkflow({ rootDir: root }, addPlan);

  const updatePlan = await planManagerSourceWorkflow(
    { rootDir: root },
    {
      acquisition: {
        input: replacement,
        name: 'review-pack'
      }
    }
  );

  assert.equal(updatePlan.acquisition.action, 'update');
  await applyManagerSourceWorkflow({ rootDir: root }, updatePlan);
  assert.equal(
    await readFile(
      path.join(root, 'personal', 'review-pack', 'skills', 'review', 'SKILL.md'),
      'utf8'
    ),
    '# Updated review\n'
  );
});

test('a destination collision does not give Manager replacement authority', async () => {
  const root = await makeTempDir('manager-collision-root-');
  const input = await makeSource('manager-collision-input-', ['review']);
  const destination = path.join(root, 'personal', 'review-pack');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'SKILL.md'), '# Existing\n');

  await assert.rejects(
    () => planManagerSourceWorkflow(
      { rootDir: root },
      { acquisition: { input, name: 'review-pack' } }
    ),
    /Source destination collision/
  );
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Existing\n');
});

test('enablement preflight rejects an occupied alias before mutation', async () => {
  const root = await makeTempDir('manager-alias-root-');
  const project = await makeTempDir('manager-alias-project-');
  const input = await makeSource('manager-alias-input-', ['review']);
  const addPlan = await planManagerSourceWorkflow(
    { rootDir: root },
    { acquisition: { input, name: 'review-pack' } }
  );
  await applyManagerSourceWorkflow({ rootDir: root }, addPlan);
  const aliasPath = path.join(project, '.agents', 'skills', 'review');
  await mkdir(aliasPath, { recursive: true });

  await assert.rejects(
    () => planManagerSourceWorkflow(
      { rootDir: root, projectPath: project },
      { enablement: { skillId: 'personal/review-pack/skills/review' } }
    ),
    /alias is occupied/
  );
  await access(aliasPath);
});

test('enablement-only Manager requests use an acquired skill', async () => {
  const root = await makeTempDir('manager-enable-root-');
  const project = await makeTempDir('manager-enable-project-');
  const input = await makeSource('manager-enable-input-', ['review']);
  const addPlan = await planManagerSourceWorkflow(
    { rootDir: root },
    { acquisition: { input, name: 'review-pack' } }
  );
  await applyManagerSourceWorkflow({ rootDir: root }, addPlan);

  const plan = await planManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    { enablement: { skillId: 'personal/review-pack/skills/review' } }
  );
  const result = await applyManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    plan
  );

  assert.equal(result.acquisition, null);
  assert.equal(result.enablement.alias, 'review');
  assert.equal(result.enablement.unchanged, false);
  assert.deepEqual(result.enablement.reminders, []);
  await access(path.join(project, '.agents', 'skills', 'review'));
});

test('combined Manager requests rescan and enable only the selected acquired skill', async () => {
  const root = await makeTempDir('manager-combined-root-');
  const project = await makeTempDir('manager-combined-project-');
  const input = await makeSource('manager-combined-input-', ['notes', 'review']);

  const plan = await planManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    {
      acquisition: { input, name: 'team-pack' },
      enablement: { sourceSkillPath: 'skills/review', alias: 'team-review' }
    }
  );
  const result = await applyManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    plan
  );

  assert.equal(result.acquisition.status, 'added');
  assert.equal(result.enablement.alias, 'team-review');
  await access(path.join(project, '.agents', 'skills', 'team-review'));
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills', 'notes')),
    /ENOENT/
  );
});

test('combined selection errors show full acquired skill identities', async () => {
  const root = await makeTempDir('manager-selection-root-');
  const project = await makeTempDir('manager-selection-project-');
  const input = await makeSource('manager-selection-input-', ['notes', 'review']);

  await assert.rejects(
    () => planManagerSourceWorkflow(
      { rootDir: root, projectPath: project },
      {
        acquisition: { input, name: 'team-pack' },
        enablement: {}
      }
    ),
    /personal\/team-pack\/skills\/notes, personal\/team-pack\/skills\/review/
  );
});

test('declared setup reminders remain non-blocking Manager results', async () => {
  const root = await makeTempDir('manager-setup-root-');
  const project = await makeTempDir('manager-setup-project-');
  const input = await makeSource('manager-setup-input-', ['review', 'setup']);
  await writeSetupContract(root, 'personal', 'review-pack', {
    schemaVersion: 1,
    setup: {
      requirement: 'recommended',
      scope: 'project',
      mode: 'interactive',
      skillId: 'personal/review-pack/skills/setup',
      appliesTo: ['personal/review-pack/skills/review'],
      requiredArtifacts: ['.review/config.json']
    }
  });

  const plan = await planManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    {
      acquisition: { input, name: 'review-pack' },
      enablement: { sourceSkillPath: 'skills/review' }
    }
  );
  const result = await applyManagerSourceWorkflow(
    { rootDir: root, projectPath: project },
    plan
  );

  assert.equal(result.enablement.ok, true);
  assert.equal(result.enablement.reminders.length, 1);
  assert.equal(
    result.enablement.reminders[0].type,
    'collection-setup-recommended'
  );
  await access(path.join(project, '.agents', 'skills', 'review'));
});

async function makeSource(prefix, skillNames, heading = 'Original') {
  const source = await makeTempDir(prefix);
  for (const skillName of skillNames) {
    const skillPath = path.join(source, 'skills', skillName);
    await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(skillPath, 'SKILL.md'), `# ${heading} ${skillName}\n`);
  }
  return source;
}

async function writeSetupContract(root, source, collection, contract) {
  const contractPath = path.join(
    root,
    'collection-metadata',
    source,
    `${collection}.json`
  );
  await mkdir(path.dirname(contractPath), { recursive: true });
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
}
