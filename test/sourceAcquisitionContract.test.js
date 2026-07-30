import {
  access,
  readdir,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  inspectSource,
  planAddSource
} from '../lib/sourceManager.js';
import {
  applySourceAcquisition
} from '../lib/sourceAcquisition.js';
import {
  defineSourceAcquisitionAdapter
} from '../lib/sourceAcquisitionAdapter.js';
import { makeTempDir } from './testHelpers.js';

test('Source acquisition adapter contract rejects incomplete adapters', () => {
  assert.throws(
    () => defineSourceAcquisitionAdapter({
      stalePlanMessage: 'candidate changed'
    }),
    /inspect/
  );
});

test('Source acquisition retains the facts accepted in the original plan', async () => {
  const root = await makeTempDir('source-acquisition-consent-root-');
  const input = await makeTempDir('source-acquisition-consent-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Planned content\n');

  const acceptedPlan = await planAddSource({ rootDir: root }, { input });
  await writeFile(path.join(input, 'SKILL.md'), '# Unreviewed content\n');
  const unreviewedPlan = await planAddSource({ rootDir: root }, { input });
  Object.assign(acceptedPlan, structuredClone(unreviewedPlan));

  await assert.rejects(
    () => applyAddSource({ rootDir: root }, acceptedPlan),
    (error) => error.category === 'stale-plan'
  );
  await assert.rejects(
    () => access(path.join(root, acceptedPlan.installPath)),
    /ENOENT/
  );
});

test('Source acquisition plans stay process-local and replay as no-ops', async () => {
  const root = await makeTempDir('source-acquisition-session-root-');
  const input = await makeTempDir('source-acquisition-session-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Session content\n');
  const plan = await planAddSource({ rootDir: root }, { input });

  await assert.rejects(
    () => applyAddSource({ rootDir: root }, structuredClone(plan)),
    /must be applied by the process that created it/
  );
  assert.equal((await applyAddSource({ rootDir: root }, plan)).status, 'added');
  assert.equal(
    (await applyAddSource({ rootDir: root }, plan)).status,
    'already-installed'
  );
});

test('Source acquisition rolls content back when registry publication fails', async () => {
  const root = await makeTempDir('source-acquisition-rollback-root-');
  const input = await makeTempDir('source-acquisition-rollback-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Rollback content\n');
  const plan = await planAddSource({ rootDir: root }, { input });

  await assert.rejects(
    () => applySourceAcquisition({
      rootDir: root,
      createSourceRecord: async () => {
        throw new Error('injected registry publication failure');
      }
    }, plan),
    /injected registry publication failure/
  );

  await assert.rejects(
    () => access(path.join(root, plan.installPath)),
    /ENOENT/
  );
  await assert.rejects(
    () => inspectSource({ rootDir: root }, plan.sourceId),
    /not registered/
  );
  assert.deepEqual(await stagingEntries(root), []);
});

test('Source acquisition rejects the reserved in-progress marker before publication', async () => {
  const root = await makeTempDir('source-acquisition-marker-root-');
  const input = await makeTempDir('source-acquisition-marker-input-');
  await writeFile(path.join(input, 'SKILL.md'), '# Marker content\n');
  await writeFile(
    path.join(input, '.skillcaddy-installing'),
    'skillcaddy-source-publication-v1\n'
  );
  const plan = await planAddSource({ rootDir: root }, { input });

  await assert.rejects(
    () => applyAddSource({ rootDir: root }, plan),
    (error) => error.category === 'source-validation' &&
      /reserved publication marker/.test(error.message)
  );
  await assert.rejects(
    () => access(path.join(root, plan.installPath)),
    /ENOENT/
  );
});

async function stagingEntries(root) {
  const staging = path.join(root, '.skillcaddy', 'staging');
  try {
    return await readdir(staging);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
