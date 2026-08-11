import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../lib/sourceManager.js';
import { loadTuiState } from '../lib/tuiActions.js';
import { makeTempDir } from './testHelpers.js';
import { buildZip } from './zipFixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('TUI adds a remote archive, refreshes state, and keeps the project untouched', async (t) => {
  const archive = buildZip([
    {
      name: 'bundle/skills/remote/SKILL.md',
      content: '---\ndescription: Remote skill\n---\n# Remote\n'
    }
  ]);
  const server = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/publisher-package?token=secret');
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': archive.length
    });
    response.end(archive);
  });

  const root = await makeTempDir('tui-source-root-');
  const project = await makeTempDir('tui-source-project-');
  const input =
    `http://user:password@127.0.0.1:${server.address().port}` +
    '/publisher-package?token=secret#fragment';
  const result = await runTui(root, project, `12\n${input}\n\n\ny\n\nq\n`);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Add plan: ready/);
  assert.match(result.stdout, /Outcome: added/);
  assert.match(result.stdout, /official\/publisher-package/);
  assert.match(result.stdout, /Skills: 1/);
  assert.doesNotMatch(result.stdout, /user|password|token|secret|fragment/);

  const record = await inspectSource({ rootDir: root }, 'official/publisher-package');
  assert.deepEqual(
    {
      schemaVersion: record.schemaVersion,
      sourceId: record.sourceId,
      bucket: record.bucket,
      type: record.type,
      installPath: record.installPath,
      origin: record.origin,
      skills: record.skills
    },
    {
      schemaVersion: 1,
      sourceId: 'official/publisher-package',
      bucket: 'official',
      type: 'archive',
      installPath: 'official/publisher-package',
      origin: {
        kind: 'http',
        display: `http://127.0.0.1:${server.address().port}/publisher-package`
      },
      skills: ['skills/remote']
    }
  );
  assert.equal(record.integrity.algorithm, 'sha256');
  assert.match(record.integrity.value, /^[a-f0-9]{64}$/);

  const state = await loadTuiState(root, project);
  assert.deepEqual(state.skills.map((skill) => skill.id), [
    'official/publisher-package/skills/remote'
  ]);
  assert.deepEqual(state.enabled, []);
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );

  const repeated = await runTui(root, project, `12\n${input}\n\n\n\nq\n`);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /Add plan: already-installed/);
  assert.match(repeated.stdout, /Outcome: already-installed/);
  assert.doesNotMatch(repeated.stdout, /确认添加\?/);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['official/publisher-package/skills/remote']
  );
});

test('TUI forwards explicit Archive name and namespace', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Named archive\n' }
  ]);
  const server = await startHttpFixture(t, (_request, response) => response.end(archive));
  const root = await makeTempDir('tui-source-identity-root-');
  const project = await makeTempDir('tui-source-identity-project-');
  const input = `http://127.0.0.1:${server.address().port}/download`;
  const result = await runTui(
    root,
    project,
    `12\n${input}\ncustom-package\ntrusted-team\ny\n\nq\n`
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /source: official\/trusted-team\/custom-package/);
  assert.match(result.stdout, /install: official\/trusted-team--custom-package/);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['official/trusted-team--custom-package']
  );
});

test('TUI cancellation does not apply a remote archive', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Cancelled\n' }
  ]);
  const server = await startHttpFixture(t, (_request, response) => response.end(archive));

  const root = await makeTempDir('tui-source-cancel-root-');
  const project = await makeTempDir('tui-source-cancel-project-');
  const input = `http://127.0.0.1:${server.address().port}/cancelled-package`;
  const result = await runTui(root, project, `12\n${input}\n\n\nn\n\nq\n`);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已取消添加/);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/cancelled-package'),
    /Source is not registered/
  );
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

test('TUI rejects Git and remote SKILL.md URLs in the archive-only slice', async () => {
  for (const input of [
    'https://github.com/example/repository',
    'https://example.test/skills/SKILL.md'
  ]) {
    const root = await makeTempDir('tui-source-unsupported-root-');
    const project = await makeTempDir('tui-source-unsupported-project-');
    const result = await runTui(root, project, `12\n${input}\n\nq\n`);

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /当前 TUI 仅支持公共 HTTP\(S\) Archive；Git 和 Remote file 暂不支持/
    );
    assert.deepEqual((await loadTuiState(root, project)).skills, []);
  }
});

test('TUI returns from the initial archive prompt without mutation', async () => {
  for (const address of ['', 'b']) {
    const root = await makeTempDir('tui-source-back-root-');
    const project = await makeTempDir('tui-source-back-project-');
    const result = await runTui(root, project, `12\n${address}\n\nq\n`);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Add plan:|Outcome: added/);
    assert.deepEqual((await loadTuiState(root, project)).skills, []);
  }
});

test('TUI reports remote archive validation failures with their stable category', async (t) => {
  const server = await startHttpFixture(t, (_request, response) => response.end('not a zip'));

  const root = await makeTempDir('tui-source-error-root-');
  const project = await makeTempDir('tui-source-error-project-');
  const input = `http://127.0.0.1:${server.address().port}/broken-package`;
  const result = await runTui(root, project, `12\n${input}\n\n\n\nq\n`);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /错误 \[invalid-input\]：/);
  assert.match(result.stdout, /Local file does not have a ZIP signature/);
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

function runTui(root, project, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/tui.js', '--root', root, project],
      { cwd: repoRoot }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: stdout.join(''),
      stderr: stderr.join('')
    }));

    const lines = input.split('\n');
    let index = 0;
    const timer = setInterval(() => {
      if (!stdout.join('').includes('q. 退出')) return;
      if (index === lines.length) {
        clearInterval(timer);
        child.stdin.end();
        return;
      }
      child.stdin.write(`${lines[index]}\n`);
      index += 1;
    }, 100);
    child.once('close', () => clearInterval(timer));
  });
}

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server;
}
