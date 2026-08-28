import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Spawnable Node-as-tar test double. The script logs each invocation's argv
// (via FAKE_TAR_ARGV_LOG) and emits configurable stdout/stderr/exit per env.
// Used by tests that need to assert which flags the libraryImage spawn passes
// to system tar, or to simulate tar-side failure modes (exit code, stderr,
// hang-for-timeout) without modifying the host tar.
//
// Behavior of the produced fake-tar script:
//   FAKE_TAR_ARGV_LOG  — file path; the fake appends `JSON.stringify(argv) + '\n'`
//   FAKE_TAR_VERSION   — text written to stdout when argv[0] === '--version'.
//                          If absent, the fake prints `tar (unknown)\n`.
//   FAKE_TAR_STDOUT    — text written to stdout for non-`--version` invocations.
//   FAKE_TAR_STDERR    — text written to stderr for non-`--version` invocations.
//   FAKE_TAR_EXIT      — integer exit code.
//   FAKE_TAR_HANG      — when set, the script never exits (tests the timeout gate).

function makeFakeTarScriptBody() {
  return [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "if (process.env.FAKE_TAR_ARGV_LOG) {",
    "  appendFileSync(process.env.FAKE_TAR_ARGV_LOG, JSON.stringify(argv) + '\\n');",
    "}",
    "let stdoutPayload;",
    "let stderrPayload;",
    "let exitCode;",
    "if (argv[0] === '--version') {",
    "  stdoutPayload = process.env.FAKE_TAR_VERSION || 'tar (unknown)\\n';",
    "  exitCode = parseInt(process.env.FAKE_TAR_VERSION_EXIT || process.env.FAKE_TAR_EXIT || '0', 10);",
    "} else {",
    "  if (process.env.FAKE_TAR_STDOUT) stdoutPayload = process.env.FAKE_TAR_STDOUT;",
    "  if (process.env.FAKE_TAR_STDERR) stderrPayload = process.env.FAKE_TAR_STDERR;",
    "  exitCode = parseInt(process.env.FAKE_TAR_EXIT || '0', 10);",
    "}",
    "if (process.env.FAKE_TAR_HANG) {",
    "  setInterval(() => {}, 1000);",
    "} else if (stdoutPayload || stderrPayload) {",
    "  let pending = 0;",
    "  let errored = false;",
    "  const finish = () => { if (!errored && pending === 0) process.exit(exitCode); };",
    "  if (stdoutPayload) {",
    "    pending += 1;",
    "    process.stdout.write(stdoutPayload, (err) => { if (err) errored = true; pending -= 1; finish(); });",
    "  }",
    "  if (stderrPayload) {",
    "    pending += 1;",
    "    process.stderr.write(stderrPayload, (err) => { if (err) errored = true; pending -= 1; finish(); });",
    "  }",
    "  if (!stdoutPayload && !stderrPayload) process.exit(exitCode);",
    "} else {",
    "  process.exit(exitCode);",
    "}"
  ].join('\n') + '\n';
}

export async function buildFakeTar() {
  const dir = await mkdir(
    path.join(tmpdir(), `fake-tar-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    { recursive: true }
  );
  const scriptPath = path.join(dir, 'fake-tar.js');
  await writeFile(scriptPath, makeFakeTarScriptBody(), { mode: 0o755 });
  return scriptPath;
}
