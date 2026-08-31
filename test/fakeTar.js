import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Spawnable Node-as-tar test double. The script logs each invocation's argv and
// emits configurable stdout/stderr/exit codes. Used by tests that need to assert
// which flags the libraryImage spawn passes to system tar, or to simulate
// tar-side failure modes (exit code, stderr, hang-for-timeout) without touching
// the host tar.
//
// Configuration comes from the `buildFakeTar` options, baked into a JSON file
// next to the script. Environment variables of the same name override it, so a
// single built script can be re-pointed per invocation:
//
//   argvLogPath   / FAKE_TAR_ARGV_LOG    — the fake appends JSON.stringify(argv) + '\n'
//   versionOutput / FAKE_TAR_VERSION     — stdout for `--version` (default 'tar (unknown)\n')
//   versionExit   / FAKE_TAR_VERSION_EXIT— exit code for `--version` (default 0)
//   stdout        / FAKE_TAR_STDOUT      — stdout for non-`--version` invocations
//   stderr        / FAKE_TAR_STDERR      — stderr for non-`--version` invocations
//   exitCode      / FAKE_TAR_EXIT        — exit code for non-`--version` invocations
//   hang          / FAKE_TAR_HANG        — never exit, to exercise the timeout gate
//   hangVersion   / FAKE_TAR_HANG_VERSION— hang on `--version` too (default: false)
//
// The generated script is written as `.mjs`: it uses ESM syntax and lives in a
// temp directory with no package.json, so a bare `.js` extension would only run
// on Node versions with module detection enabled (Node 22+). The package
// supports Node >= 20.
const SCRIPT_BODY = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const configPath = new URL('./fake-tar.config.json', import.meta.url);
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  config = {};
}

const pick = (envName, key) =>
  process.env[envName] !== undefined ? process.env[envName] : config[key];

const argv = process.argv.slice(2);
const argvLogPath = pick('FAKE_TAR_ARGV_LOG', 'argvLogPath');
if (argvLogPath) appendFileSync(argvLogPath, JSON.stringify(argv) + '\\n');

const isVersionProbe = argv[0] === '--version';
const toExitCode = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

let stdoutPayload = '';
let stderrPayload = '';
let exitCode;

if (isVersionProbe) {
  stdoutPayload = pick('FAKE_TAR_VERSION', 'versionOutput') ?? 'tar (unknown)\\n';
  exitCode = toExitCode(pick('FAKE_TAR_VERSION_EXIT', 'versionExit'), 0);
} else {
  stdoutPayload = pick('FAKE_TAR_STDOUT', 'stdout') ?? '';
  stderrPayload = pick('FAKE_TAR_STDERR', 'stderr') ?? '';
  exitCode = toExitCode(pick('FAKE_TAR_EXIT', 'exitCode'), 0);
}

const hang = pick('FAKE_TAR_HANG', 'hang');
const hangVersion = pick('FAKE_TAR_HANG_VERSION', 'hangVersion');
if (hang && (!isVersionProbe || hangVersion)) {
  setInterval(() => {}, 1000);
} else {
  let pending = 0;
  const finish = () => {
    if (pending === 0) process.exit(exitCode);
  };
  if (stdoutPayload) {
    pending += 1;
    process.stdout.write(stdoutPayload, () => {
      pending -= 1;
      finish();
    });
  }
  if (stderrPayload) {
    pending += 1;
    process.stderr.write(stderrPayload, () => {
      pending -= 1;
      finish();
    });
  }
  finish();
}
`;

const CONFIG_KEYS = [
  'argvLogPath',
  'versionOutput',
  'versionExit',
  'stdout',
  'stderr',
  'exitCode',
  'hang',
  'hangVersion'
];

/**
 * @param {{
 *   argvLogPath?: string,
 *   versionOutput?: string,
 *   versionExit?: number,
 *   stdout?: string,
 *   stderr?: string,
 *   exitCode?: number,
 *   hang?: boolean,
 *   hangVersion?: boolean
 * }} [options]
 * @returns {Promise<string>} path to the spawnable fake tar script
 */
export async function buildFakeTar(options = {}) {
  const unknown = Object.keys(options).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    // Silently ignoring options made every caller's configuration dead code.
    throw new Error(`buildFakeTar received unknown options: ${unknown.join(', ')}`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'fake-tar-'));
  const scriptPath = path.join(dir, 'fake-tar.mjs');
  await writeFile(path.join(dir, 'fake-tar.config.json'), JSON.stringify(options, null, 2));
  await writeFile(scriptPath, SCRIPT_BODY, { mode: 0o755 });
  return scriptPath;
}
