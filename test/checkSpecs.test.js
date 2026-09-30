import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/*
 * Behavioural tests for scripts/check-specs.js, run as a subprocess so the
 * exit code — the thing a pre-commit hook or CI job would actually read — is
 * what gets asserted, not just the printed message.
 *
 * The point of the suite is discrimination, not coverage. A gate that fails
 * everything is as useless as one that fails nothing, so there are
 * must-pass fixtures here for the same reason specGate.test.js keeps
 * English column headers and placeholder fixtures: a suite made only of
 * violation cases would pass against a script that just always exits 1.
 */

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'check-specs.js');

async function check(dir, extraArgs = []) {
  const args = [script, ...(dir ? ['--dir', dir] : []), ...extraArgs];
  try {
    const { stdout, stderr } = await run('node', args, { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function withSpecs(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'checkspecs-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

const UNAPPROVED = '# TECH\n\n## Context\n\n这是一个尚未确认方向的技术方案草稿。\n';
const STUB = '# TECH\n\n## Context\n\nTODO\n';
const APPROVED = '# TECH\n\n## Context\n\n方向已确认的方案。\n\n## Approval\n\n- 方向确认：通过（时间：2026-09-30 16:20 CST，确认人：along）\n';
const GOOD_ROLES = [
  '# Roles', '',
  '| 位置 | 谁 | 会话 | 状态 |',
  '| --- | --- | --- | --- |',
  '| author | along | s-001 | x |',
  '| implementer | opus | s-002 | x |',
  '| verifier | fable | s-003 | x |',
  '', '## Boundaries', '', '- verifier 不得与 author 同会话。', ''
].join('\n');
const SHARED_SESSION_ROLES = GOOD_ROLES.replace('| verifier | fable | s-003 |', '| verifier | fable | s-001 |');

test('exits 0 when the repository has no specs directory', async () => {
  const result = await check(path.join(tmpdir(), 'checkspecs-does-not-exist-xyz'));
  assert.equal(result.code, 0);
});

test('--strict fails when the specs directory is absent', async () => {
  const result = await check(path.join(tmpdir(), 'checkspecs-does-not-exist-xyz'), ['--strict']);
  assert.equal(result.code, 1);
});

test('blocks an unapproved spec', async () => {
  const { root, cleanup } = await withSpecs({ 'DEMO-1/TECH.md': UNAPPROVED });
  try {
    const result = await check(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /DEMO-1\/TECH\.md/);
    assert.match(result.stderr, /Approval/);
  } finally {
    await cleanup();
  }
});

test('skips a stub spec instead of blocking it', async () => {
  const { root, cleanup } = await withSpecs({ 'EMPTY-1/TECH.md': STUB });
  try {
    const result = await check(root);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /EMPTY-1\/TECH\.md/);
  } finally {
    await cleanup();
  }
});

test('a short unapproved draft is blocked, not mistaken for a stub', async () => {
  // Regression: the stub test used to be a character count, so a brief
  // unapproved draft fell under the threshold and silently passed. That is
  // the exact document the gate exists to catch.
  const brief = '# TECH\n\n## Context\n\n未确认方向。\n';
  const { root, cleanup } = await withSpecs({ 'BRIEF-1/TECH.md': brief });
  try {
    const result = await check(root);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /BRIEF-1/);
  } finally {
    await cleanup();
  }
});

test('passes when every spec is approved and role contracts are valid', async () => {
  const { root, cleanup } = await withSpecs({
    'OK-1/TECH.md': APPROVED,
    'OK-2/ROLE.md': GOOD_ROLES
  });
  try {
    const result = await check(root);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /关卡检查通过/);
  } finally {
    await cleanup();
  }
});

test('blocks a role contract whose verifier shares the author session', async () => {
  const { root, cleanup } = await withSpecs({ 'BADSESS-1/ROLE.md': SHARED_SESSION_ROLES });
  try {
    const result = await check(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /同为会话/);
  } finally {
    await cleanup();
  }
});

test('an approved spec does not excuse a missing role contract', async () => {
  // ROLE.md is checked independently. If a single combined gate were used,
  // approval would imply the roles were declared.
  const { root, cleanup } = await withSpecs({ 'OK-1/TECH.md': APPROVED });
  try {
    const result = await check(root);
    assert.equal(result.code, 0, 'a missing ROLE.md is skipped, not blocked');
  } finally {
    await cleanup();
  }
});

test('reports every failing document in one run', async () => {
  const { root, cleanup } = await withSpecs({
    'DEMO-1/TECH.md': UNAPPROVED,
    'BADSESS-1/ROLE.md': SHARED_SESSION_ROLES
  });
  try {
    const result = await check(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /DEMO-1\/TECH\.md/);
    assert.match(result.stderr, /BADSESS-1\/ROLE\.md/);
  } finally {
    await cleanup();
  }
});
