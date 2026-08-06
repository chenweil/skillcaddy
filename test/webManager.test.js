import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
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
      probe: async () => ready,
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
    port: 45175,
    runtimeDir,
    open: false,
    dependencies: fake.dependencies
  });

  assert.equal(result.status, 'started');
  assert.notEqual(result.pid, 99999);
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
      probe: async () => true,
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
      dependencies: { probe: async () => true }
    }),
    /refusing to restart an unmanaged Web process/
  );
});
