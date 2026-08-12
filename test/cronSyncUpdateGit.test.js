import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './testHelpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cronScript = path.join(repoRoot, 'scripts', 'cron-sync-update-git.sh');

test('cron sync leaves network failures for the next run without invoking repair', async () => {
  const result = await runCronScenario('network');

  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.calls.filter((call) => call.includes(' update-git ')).length, 1);
  assert.equal(result.calls.some((call) => call.includes(' repair ')), false);
  assert.match(result.stdout, /\[failed\] github\/example\/network \(git-network\)/);
  assert.match(result.stdout, /Could not resolve host/);
});

test('cron sync repairs only source collisions without pre-authorizing breaking changes', async () => {
  const result = await runCronScenario('collision');

  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.calls.filter((call) => call.includes(' update-git ')).length, 2);
  const repairCall = result.calls.find((call) => call.includes(' repair '));
  assert.ok(repairCall);
  assert.doesNotMatch(repairCall, /--allow-breaking/);
  assert.match(result.stdout, /repaired github\/example\/collision -> abc1234/);
  assert.match(result.stdout, /已最新 current: 1 个/);
});

test('cron sync reports a blocked collision repair without rerunning the batch', async () => {
  const result = await runCronScenario('breaking');

  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.calls.filter((call) => call.includes(' update-git ')).length, 1);
  const repairCall = result.calls.find((call) => call.includes(' repair '));
  assert.ok(repairCall);
  assert.doesNotMatch(repairCall, /--allow-breaking/);
  assert.match(
    result.stdout,
    /repair-blocked github\/example\/collision \(breaking-replacement\)/
  );
});

async function runCronScenario(scenario) {
  const fixtureRoot = await makeTempDir(`cron-sync-${scenario}-`);
  const binDir = path.join(fixtureRoot, 'bin');
  const npmPath = path.join(binDir, 'npm');
  const callsPath = path.join(fixtureRoot, 'calls.log');
  const repairedPath = path.join(fixtureRoot, 'repaired');
  await mkdir(binDir, { recursive: true });
  await writeFile(npmPath, fakeNpmScript(), { mode: 0o755 });
  await chmod(npmPath, 0o755);

  const result = await spawnResult('bash', [cronScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_SCENARIO: scenario,
      FAKE_CALLS_PATH: callsPath,
      FAKE_REPAIRED_PATH: repairedPath
    }
  });
  const calls = (await readFile(callsPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
  return { ...result, calls };
}

function fakeNpmScript() {
  return `#!/bin/bash
printf ' %s \n' "$*" >> "$FAKE_CALLS_PATH"

if [[ " $* " == *" update-git "* ]]; then
  if [[ "$FAKE_SCENARIO" == "network" ]]; then
    printf '%s\n' \
      '[failed] github/example/network (git-network)' \
      '  reason: Could not fetch Git source: github/example/network (Could not resolve host: github.com; attempts=3)' \
      'Git source summary: updated=0 current=0 dirty=0 breaking=0 failed=1'
    exit 1
  fi
  if [[ -f "$FAKE_REPAIRED_PATH" ]]; then
    printf '%s\n' \
      '[current] github/example/collision' \
      'Git source summary: updated=0 current=1 dirty=0 breaking=0 failed=0'
    exit 0
  fi
  printf '%s\n' \
    '[failed] github/example/collision (source-collision)' \
    '  reason: Registered Git source commit does not match its source record: github/example/collision' \
    'Git source summary: updated=0 current=0 dirty=0 breaking=0 failed=1'
  exit 1
fi

if [[ " $* " == *" repair "* ]]; then
  if [[ "$FAKE_SCENARIO" == "breaking" ]]; then
    printf '%s\n' 'Outcome: breaking-replacement' 'Re-run with --allow-breaking after review'
    exit 4
  fi
  : > "$FAKE_REPAIRED_PATH"
  printf '%s\n' 'Repair plan: ready' 'Outcome: repaired' 'commit: abc1234'
  exit 0
fi

exit 2
`;
}

function spawnResult(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: stdout.join(''),
      stderr: stderr.join('')
    }));
  });
}
