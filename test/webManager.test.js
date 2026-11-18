import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import path from 'node:path';
import {
  buildWebUrl,
  getRuntimePath,
  restartWeb,
  startWeb,
  stopWeb
} from '../lib/webManager.js';
import { makeTempDir } from './testHelpers.js';

const appInfo = { name: 'skillcaddy', version: '0.29.0' };

function makeFakeProcess(dependencies = {}) {
  const live = new Set();
  let nextPid = 42000;
  let ready = false;
  const terminated = [];

  return {
    terminated,
    dependencies: {
      spawn: (_command, _args, _options) => {
        const pid = nextPid++;
        live.add(pid);
        ready = true;
        return { pid, unref() {} };
      },
      probe: async () => ready ? { ready: true } : null,
      isAlive: async (pid) => live.has(pid),
      isOwned: async () => true,
      terminate: async (pid) => {
        terminated.push(pid);
        live.delete(pid);
        ready = false;
      },
      wait: async () => {},
      now: () => '2026-08-06T00:00:00.000Z',
      ...dependencies
    }
  };
}

test('Web URL keeps the selected project path encoded', () => {
  assert.equal(
    buildWebUrl({ port: 4173, projectPath: '/tmp/a project' }),
    'http://127.0.0.1:4173/?projectPath=%2Ftmp%2Fa+project'
  );
});

test('startWeb records its child and reuses the managed process', async () => {
  const root = await makeTempDir('web-manager-root-');
  const runtimeDir = await makeTempDir('web-manager-runtime-');
  const fake = makeFakeProcess();
  const options = {
    rootDir: root,
    projectPath: root,
    expectedApp: appInfo,
    port: 45174,
    runtimeDir,
    open: false,
    dependencies: fake.dependencies
  };

  const started = await startWeb(options);
  assert.equal(started.status, 'started');
  assert.equal(started.managed, true);
  const runtimePath = getRuntimePath(root, options.port, runtimeDir);
  const record = JSON.parse(await readFile(runtimePath, 'utf8'));
  assert.equal(record.pid, started.pid);
  assert.equal(record.port, options.port);

  const reused = await startWeb(options);
  assert.equal(reused.status, 'already-running');
  assert.equal(reused.pid, started.pid);
  assert.deepEqual(fake.terminated, []);

  const stopped = await stopWeb(options);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(fake.terminated, [started.pid]);
});

test('startWeb removes a stale PID record before starting', async () => {
  const root = await makeTempDir('web-manager-stale-root-');
  const runtimeDir = await makeTempDir('web-manager-stale-runtime-');
  const fake = makeFakeProcess();
  const runtimePath = getRuntimePath(root, 45175, runtimeDir);
  await writeFile(runtimePath, `${JSON.stringify({
    pid: 99999,
    host: '127.0.0.1',
    port: 45175,
    rootDir: path.resolve(root),
    serverEntry: path.join(root, 'server.js'),
    startedAt: 'stale'
  })}\n`);

  const result = await startWeb({
    rootDir: root,
    expectedApp: appInfo,
    port: 45175,
    runtimeDir,
    open: false,
    dependencies: fake.dependencies
  });

  assert.equal(result.status, 'started');
  assert.notEqual(result.pid, 99999);
});

test('startWeb reports readiness failure when its child exits before cleanup', async () => {
  const root = await makeTempDir('web-manager-exit-root-');
  const runtimeDir = await makeTempDir('web-manager-exit-runtime-');
  const fake = makeFakeProcess({
    probe: async () => null,
    terminate: () => {
      const error = new Error('kill ESRCH');
      error.code = 'ESRCH';
      throw error;
    },
    wait: async () => {}
  });

  await assert.rejects(
    () => startWeb({
      rootDir: root,
      expectedApp: appInfo,
      port: 45177,
      runtimeDir,
      open: false,
      startTimeoutMs: 0,
      dependencies: fake.dependencies
    }),
    /Web process .* did not become ready on port 45177/
  );
});

async function makeWebFixture(t, { info = appInfo, versionStatus = 200, homeStatus = 200 } = {}) {
  const root = await makeTempDir('web-manager-http-root-');
  const runtimeDir = await makeTempDir('web-manager-http-runtime-');
  const server = createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(versionStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(info));
    } else {
      res.writeHead(homeStatus, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Skillcaddy</h1>');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const opened = [];
  const options = {
    rootDir: root,
    expectedApp: appInfo,
    port: server.address().port,
    runtimeDir,
    dependencies: {
      openBrowser: async (url) => { opened.push(url); return true; },
      spawn: () => assert.fail('must not spawn on an occupied port'),
      terminate: () => assert.fail('must not terminate an external service')
    }
  };
  return { options, opened };
}

for (const [scenario, fixture, message] of [
  ['an older Skillcaddy version', { info: { ...appInfo, version: '0.28.0' }, homeStatus: 404 }, /expected Skillcaddy v0\.29\.0/],
  ['a matching version without a home page', { homeStatus: 404 }, /home page returned HTTP 404/],
  ['an unrelated HTTP service', { versionStatus: 404 }, /not a Skillcaddy Web service/]
]) {
  test(`startWeb refuses to open ${scenario}`, async (t) => {
    const { options, opened } = await makeWebFixture(t, fixture);
    await assert.rejects(() => startWeb(options), message);
    assert.deepEqual(opened, []);
    assert.equal((await stopWeb(options)).status, 'not-managed');
  });
}

test('startWeb opens a healthy external Skillcaddy of the same version', async (t) => {
  const { options, opened } = await makeWebFixture(t);
  const result = await startWeb(options);
  assert.equal(result.status, 'already-running');
  assert.equal(result.managed, false);
  assert.deepEqual(opened, [result.url]);
});

test('stopWeb refuses to kill an external process on the port', async () => {
  const root = await makeTempDir('web-manager-external-root-');
  const runtimeDir = await makeTempDir('web-manager-external-runtime-');
  let terminateCount = 0;
  const result = await stopWeb({
    rootDir: root,
    port: 45176,
    runtimeDir,
    dependencies: {
      probe: async () => ({ ready: false }),
      terminate: async () => { terminateCount += 1; }
    }
  });

  assert.equal(result.status, 'not-managed');
  assert.equal(terminateCount, 0);
});

test('stopWeb does not remove ownership evidence when shutdown times out', async () => {
  const root = await makeTempDir('web-manager-timeout-root-');
  const runtimeDir = await makeTempDir('web-manager-timeout-runtime-');
  const runtimePath = getRuntimePath(root, 45177, runtimeDir);
  const record = {
    pid: 43000,
    host: '127.0.0.1',
    port: 45177,
    rootDir: path.resolve(root),
    serverEntry: path.join(root, 'server.js'),
    startedAt: '2026-08-06T00:00:00.000Z'
  };
  await writeFile(runtimePath, `${JSON.stringify(record)}\n`);

  await assert.rejects(
    () => stopWeb({
      rootDir: root,
      port: 45177,
      runtimeDir,
      stopTimeoutMs: 0,
      dependencies: {
        isAlive: async () => true,
        isOwned: async () => true,
        terminate: async () => {},
        wait: async () => {}
      }
    }),
    /did not stop within 0ms/
  );
  assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).pid, record.pid);
});

test('restartWeb refuses an unmanaged service instead of replacing it', async () => {
  const root = await makeTempDir('web-manager-restart-root-');
  const runtimeDir = await makeTempDir('web-manager-restart-runtime-');
  await assert.rejects(
    () => restartWeb({
      rootDir: root,
      port: 45178,
      runtimeDir,
      dependencies: { probe: async () => ({ ready: false }) }
    }),
    /refusing to restart an unmanaged Web process/
  );
});
