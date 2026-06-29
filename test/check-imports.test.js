import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, checkImports } from '../scripts/check-imports.js';

async function makeTempDir(prefix) {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('detects illegal internal import', async () => {
  const root = await makeTempDir('import-check-');

  try {
    await mkdir(path.join(root, 'lib'), { recursive: true });

    await writeFile(path.join(root, '.import-rules.json'), JSON.stringify({
      rules: [
        {
          from: 'lib/projectPath.js',
          allow: [],
          reason: 'Leaf — no internal deps'
        }
      ]
    }));

    await writeFile(path.join(root, 'lib/projectPath.js'), `
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getState } from './skillStore.js';
`);

    await writeFile(path.join(root, 'lib/skillStore.js'), `
export function getState() { return {}; }
`);

    const rules = loadRules(path.join(root, '.import-rules.json'));
    const violations = checkImports(rules, root);

    assert.equal(violations.length, 1, 'should detect 1 violation');
    assert.equal(violations[0].file, 'lib/projectPath.js');
    assert.ok(violations[0].specifier.includes('skillStore'));
    assert.ok(violations[0].resolved.includes('lib/skillStore.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('passes clean code with no violations', async () => {
  const root = await makeTempDir('import-clean-');

  try {
    await mkdir(path.join(root, 'lib'), { recursive: true });

    await writeFile(path.join(root, '.import-rules.json'), JSON.stringify({
      rules: [
        {
          from: 'lib/claudeStore.js',
          allow: ['lib/projectPath.js'],
          reason: 'Store — can import leaf only'
        }
      ]
    }));

    await writeFile(path.join(root, 'lib/claudeStore.js'), `
import { normalizeProjectPath } from './projectPath.js';
export function sync() {}
`);

    await writeFile(path.join(root, 'lib/projectPath.js'), `
import { homedir } from 'node:os';
export function normalizeProjectPath(p) { return p; }
`);

    const rules = loadRules(path.join(root, '.import-rules.json'));
    const violations = checkImports(rules, root);

    assert.equal(violations.length, 0, 'should have no violations');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects multiple violations across different rules', async () => {
  const root = await makeTempDir('import-multi-');

  try {
    await mkdir(path.join(root, 'lib'), { recursive: true });

    await writeFile(path.join(root, '.import-rules.json'), JSON.stringify({
      rules: [
        {
          from: 'lib/leaf.js',
          allow: [],
          reason: 'Leaf'
        },
        {
          from: 'lib/store.js',
          allow: ['lib/leaf.js'],
          reason: 'Store — can import leaf only'
        }
      ]
    }));

    await writeFile(path.join(root, 'lib/leaf.js'), `
import { helper } from './store.js';
`);

    await writeFile(path.join(root, 'lib/store.js'), `
import { leafFn } from './leaf.js';
import { other } from './other.js';
`);

    await writeFile(path.join(root, 'lib/other.js'), `
export function other() {}
`);

    const rules = loadRules(path.join(root, '.import-rules.json'));
    const violations = checkImports(rules, root);

    assert.equal(violations.length, 2, 'should detect 2 violations');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects files that are not covered by required import rules', async () => {
  const root = await makeTempDir('import-missing-rule-');

  try {
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib/covered.js'), 'export function covered() {}\n');
    await writeFile(path.join(root, 'lib/uncovered.js'), 'export function uncovered() {}\n');

    const violations = checkImports(
      [
        {
          from: 'lib/covered.js',
          allow: [],
          reason: 'Leaf'
        }
      ],
      root,
      { requireRulesFor: ['lib/*.js'] }
    );

    assert.equal(violations.length, 1, 'should detect 1 missing rule');
    assert.equal(violations[0].type, 'missing-rule');
    assert.equal(violations[0].file, 'lib/uncovered.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
