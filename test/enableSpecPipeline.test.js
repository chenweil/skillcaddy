import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readlink, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/*
 * scripts/enable-spec-pipeline.js recreates the project enablement links that
 * ADR 0011 Decision 4 deliberately keeps out of the library image.
 *
 * The property that matters is idempotence: a fresh clone has no links, an
 * existing checkout has correct ones, and running the script in either state
 * must converge on the same result without disturbing anything else. Both
 * directions are exercised here, against the real project, because a script
 * that only works on an already-set-up machine is exactly the script that
 * fails on the machine that needed it.
 *
 * The test restores the original state on the way out, so running the suite
 * leaves the working checkout as it found it.
 */

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'enable-spec-pipeline.js');
const linksDir = path.join(repoRoot, '.agents', 'skills');

const ALIASES = ['spec-direction-gate', 'spec-draft-intake', 'spec-role-contract'];

async function enable(...args) {
  try {
    const { stdout } = await run('node', [script, ...args], { cwd: repoRoot });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function isSymlink(alias) {
  try {
    const stat = await lstat(path.join(linksDir, alias));
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

test('--dry-run reports every skill and exits 0', async () => {
  const result = await enable('--dry-run');
  assert.equal(result.code, 0);
  for (const alias of ALIASES) {
    assert.match(result.stdout, new RegExp(alias));
  }
  assert.doesNotMatch(result.stdout, /已创建/, 'dry-run must not create anything');
});

test('recreating from an empty state produces working links, and re-running is a no-op', async (t) => {
  // Capture the live state so the checkout is restored even on failure.
  const original = new Map();
  for (const alias of ALIASES) {
    const full = path.join(linksDir, alias);
    try {
      original.set(alias, await readlink(full));
    } catch {
      original.set(alias, null);
    }
  }

  t.after(async () => {
    for (const [alias, target] of original) {
      const full = path.join(linksDir, alias);
      await rm(full, { force: true });
      if (target) await symlink(target, full, 'dir');
    }
  });

  // Simulate a fresh clone: no links at all.
  for (const alias of ALIASES) {
    await rm(path.join(linksDir, alias), { force: true });
  }
  for (const alias of ALIASES) {
    assert.equal(await isSymlink(alias), false, `${alias} should be absent before the run`);
  }

  const first = await enable();
  assert.equal(first.code, 0);
  assert.match(first.stdout, /已创建/);

  for (const alias of ALIASES) {
    assert.equal(await isSymlink(alias), true, `${alias} should be a symlink after the run`);
    const target = await readlink(path.join(linksDir, alias));
    assert.ok(
      target.includes(`skills/spec-pipeline/${alias}`),
      `${alias} should point into skills/spec-pipeline, got ${target}`
    );
  }

  // Second run must converge, not churn.
  const second = await enable();
  assert.equal(second.code, 0);
  assert.match(second.stdout, /已就位/);
  assert.doesNotMatch(second.stdout, /已创建/, 'a second run must not recreate links');
});

test('an unknown argument is a usage error, not a silent success', async () => {
  const result = await enable('--nope');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown argument/);
});
