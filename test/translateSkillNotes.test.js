import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  createTranslationManifest,
  executePlan,
  needsTranslation,
  parseArgs,
  parseManifest,
  preflightManifest
} = require('../skills/skillcaddy-manager/scripts/translate-skill-notes.cjs');

test('lists only meaningful non-Chinese descriptions without notes', () => {
  assert.equal(needsTranslation(skill({ description: 'Review code changes safely.' })), true);
  assert.equal(needsTranslation(skill({ description: '用于安全审查代码改动。' })), false);
  assert.equal(needsTranslation(skill({ description: '|' })), false);
  assert.equal(needsTranslation(skill({ description: 'Review code.', note: '代码审查。' })), false);
  assert.equal(needsTranslation(skill({ description: 'Review code.', source: 'archived' })), false);
});

test('creates a root-scoped manifest that preserves translation context', () => {
  const manifest = createTranslationManifest({
    rootDir: '/tmp/library',
    skills: [skill({ id: 'official/review', description: 'Review code changes safely.' })]
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.libraryRoot, '/tmp/library');
  assert.deepEqual(manifest.entries[0], {
    id: 'official/review',
    source: 'official',
    collection: 'tools',
    name: 'review',
    description: 'Review code changes safely.',
    note: ''
  });
});

test('rejects stale manifests before any metadata write', async () => {
  const state = stateWithSkills([
    skill({ id: 'official/review', note: '人工维护的介绍。' }),
    skill({ id: 'official/missing' })
  ]);
  const manifest = parseManifest(JSON.stringify({
    schemaVersion: 1,
    libraryRoot: '/tmp/library',
    entries: [
      { id: 'official/review', note: '新的翻译。' },
      { id: 'official/not-found', note: '不存在。' }
    ]
  }));

  assert.throws(
    () => preflightManifest(manifest, state),
    /已有 note.*找不到对应 skill/s
  );

  let calls = 0;
  const result = await executePlan({ changes: [] }, {
    yes: false,
    postMetadata: async () => { calls += 1; }
  });
  assert.equal(result.dryRun, true);
  assert.equal(calls, 0);
});

test('requires matching library root and explicit force for rewrites', () => {
  const state = stateWithSkills([skill({ id: 'official/review', note: '旧介绍。' })]);
  const entry = { id: 'official/review', note: '新介绍。' };

  assert.throws(
    () => preflightManifest({ libraryRoot: '/tmp/other', entries: [entry] }, state),
    /libraryRoot 不匹配/
  );

  const plan = preflightManifest({ libraryRoot: '/tmp/library', entries: [entry] }, state, {
    forceRewrite: true
  });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].payload.note, '新介绍。');
});

test('apply remains a dry run until --yes is supplied', async () => {
  const plan = {
    changes: [{ id: 'official/review', payload: { note: '代码审查。' } }]
  };
  let calls = 0;
  const dryRun = await executePlan(plan, {
    yes: false,
    postMetadata: async () => { calls += 1; }
  });
  const applied = await executePlan(plan, {
    yes: true,
    port: 4173,
    postMetadata: async () => { calls += 1; }
  });

  assert.equal(dryRun.dryRun, true);
  assert.equal(applied.updated, 1);
  assert.equal(calls, 1);
});

test('parses repository-root command options strictly', () => {
  assert.deepEqual(parseArgs(['apply', 'manifest.json', '--yes', '--force-rewrite', '--port=4180']), {
    command: 'apply',
    file: 'manifest.json',
    port: 4180,
    project: '.',
    yes: true,
    forceRewrite: true
  });
  assert.throws(() => parseArgs(['list', '--port=nope']), /无效端口/);
});

function stateWithSkills(skills) {
  return { rootDir: '/tmp/library', skills };
}

function skill(overrides = {}) {
  return {
    id: 'official/review',
    source: 'official',
    collection: 'tools',
    name: 'review',
    path: '/tmp/library/official/review',
    description: 'Review code changes safely.',
    note: '',
    tags: ['Quality'],
    autoEnable: true,
    ...overrides
  };
}
