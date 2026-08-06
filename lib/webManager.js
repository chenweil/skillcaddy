import { createHash } from 'node:crypto';
import { execFile, spawn as childSpawn } from 'node:child_process';
import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import http from 'node:http';

const execFileAsync = promisify(execFile);

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 4173;
export const DEFAULT_START_TIMEOUT_MS = 5000;
export const DEFAULT_STOP_TIMEOUT_MS = 2000;

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid Web port: ${port}`);
  }
  return value;
}

function runtimeFileName(rootDir, port) {
  const digest = createHash('sha256')
    .update(`${path.resolve(rootDir)}:${port}`)
    .digest('hex')
    .slice(0, 16);
  return `skillcaddy-web-${digest}.json`;
}

export function getRuntimePath(rootDir, port = DEFAULT_WEB_PORT, runtimeDir = tmpdir()) {
  return path.join(runtimeDir, runtimeFileName(rootDir, normalizePort(port)));
}

export function buildWebUrl({ host = DEFAULT_WEB_HOST, port = DEFAULT_WEB_PORT, projectPath } = {}) {
  const normalizedPort = normalizePort(port);
  const url = new URL(`http://${host}:${normalizedPort}/`);
  if (projectPath) {
    url.searchParams.set('projectPath', path.resolve(projectPath));
  }
  return url.toString();
}

function defaultProbe({ host, port, timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: '/api/version',
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function defaultIsOwned(record) {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(record.pid), '-o', 'command=']);
    const command = stdout.trim();
    return command.includes(record.serverEntry) && command.includes(record.rootDir);
  } catch {
    return false;
  }
}

function defaultTerminate(pid) {
  process.kill(pid, 'SIGTERM');
}

function defaultOpenBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  return new Promise((resolve) => {
    const child = childSpawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.unref();
    resolve(true);
  });
}

function makeDependencies(overrides = {}) {
  return {
    readFile: fsReadFile,
    writeFile: fsWriteFile,
    rm: fsRm,
    spawn: childSpawn,
    probe: defaultProbe,
    isAlive: defaultIsAlive,
    isOwned: defaultIsOwned,
    terminate: defaultTerminate,
    wait: sleep,
    openBrowser: defaultOpenBrowser,
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

async function readRecord(runtimePath, dependencies) {
  try {
    const content = await dependencies.readFile(runtimePath, 'utf8');
    const record = JSON.parse(content);
    if (!Number.isInteger(record.pid) || record.pid < 1) {
      throw new Error('invalid pid record');
    }
    return record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    await dependencies.rm(runtimePath, { force: true }).catch(() => {});
    return null;
  }
}

async function removeRecord(runtimePath, dependencies, expectedPid) {
  if (expectedPid !== undefined) {
    const current = await readRecord(runtimePath, dependencies);
    if (current && current.pid !== expectedPid) return false;
  }
  await dependencies.rm(runtimePath, { force: true });
  return true;
}

async function waitForProbe(dependencies, { host, port, timeoutMs = DEFAULT_START_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await dependencies.probe({ host, port, timeoutMs: 500 })) return true;
    if (Date.now() >= deadline) break;
    await dependencies.wait(100);
  } while (Date.now() < deadline);
  return false;
}

async function waitForExit(dependencies, pid, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await dependencies.isAlive(pid))) return true;
    if (Date.now() >= deadline) break;
    await dependencies.wait(100);
  } while (Date.now() < deadline);
  return false;
}

function makeRecord({ rootDir, port, serverEntry, pid, dependencies }) {
  return {
    pid,
    host: DEFAULT_WEB_HOST,
    port,
    rootDir: path.resolve(rootDir),
    serverEntry: path.resolve(serverEntry),
    startedAt: dependencies.now(),
  };
}

async function openIfRequested(dependencies, url, open) {
  if (!open) return false;
  try {
    return await dependencies.openBrowser(url);
  } catch {
    return false;
  }
}

export async function startWeb({
  rootDir,
  projectPath = process.cwd(),
  port = DEFAULT_WEB_PORT,
  open = true,
  runtimeDir = tmpdir(),
  runtimePath,
  serverEntry = path.join(rootDir, 'server.js'),
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  dependencies: dependencyOverrides,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');

  const dependencies = makeDependencies(dependencyOverrides);
  const normalizedPort = normalizePort(port);
  const host = DEFAULT_WEB_HOST;
  const pidPath = runtimePath ?? getRuntimePath(rootDir, normalizedPort, runtimeDir);
  const url = buildWebUrl({ host, port: normalizedPort, projectPath });
  const existing = await readRecord(pidPath, dependencies);

  if (existing) {
    if (existing.rootDir !== path.resolve(rootDir) || existing.port !== normalizedPort) {
      throw new Error(`Web PID record does not belong to ${path.resolve(rootDir)}:${normalizedPort}`);
    }

    if (await dependencies.isAlive(existing.pid) && await dependencies.isOwned(existing)) {
      const ready = await waitForProbe(dependencies, {
        host,
        port: normalizedPort,
        timeoutMs: startTimeoutMs,
      });
      if (!ready) throw new Error(`managed Web process ${existing.pid} did not become ready`);
      await openIfRequested(dependencies, url, open);
      return { status: 'already-running', managed: true, pid: existing.pid, port: normalizedPort, url };
    }

    await removeRecord(pidPath, dependencies, existing.pid);
  }

  if (await dependencies.probe({ host, port: normalizedPort, timeoutMs: 500 })) {
    await openIfRequested(dependencies, url, open);
    return { status: 'already-running', managed: false, port: normalizedPort, url };
  }

  const child = dependencies.spawn(process.execPath, [serverEntry], {
    cwd: path.resolve(rootDir),
    env: { ...process.env, PORT: String(normalizedPort) },
    detached: true,
    stdio: 'ignore',
  });
  const record = makeRecord({
    rootDir,
    port: normalizedPort,
    serverEntry,
    pid: child.pid,
    dependencies,
  });

  try {
    await dependencies.writeFile(pidPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (child.pid && typeof dependencies.terminate === 'function') {
      await Promise.resolve(dependencies.terminate(child.pid)).catch(() => {});
    }
    if (error?.code === 'EEXIST') {
      const concurrent = await readRecord(pidPath, dependencies);
      if (concurrent && await dependencies.isAlive(concurrent.pid)) {
        return {
          status: 'already-running',
          managed: true,
          pid: concurrent.pid,
          port: normalizedPort,
          url,
        };
      }
    }
    throw error;
  }

  if (typeof child.unref === 'function') child.unref();
  const ready = await waitForProbe(dependencies, {
    host,
    port: normalizedPort,
    timeoutMs: startTimeoutMs,
  });
  if (!ready) {
    await Promise.resolve(dependencies.terminate(child.pid)).catch(() => {});
    await removeRecord(pidPath, dependencies, child.pid);
    throw new Error(`Web process ${child.pid} did not become ready on port ${normalizedPort}`);
  }

  await openIfRequested(dependencies, url, open);
  return { status: 'started', managed: true, pid: child.pid, port: normalizedPort, url };
}

export async function stopWeb({
  rootDir,
  port = DEFAULT_WEB_PORT,
  runtimeDir = tmpdir(),
  runtimePath,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  dependencies: dependencyOverrides,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');

  const dependencies = makeDependencies(dependencyOverrides);
  const normalizedPort = normalizePort(port);
  const host = DEFAULT_WEB_HOST;
  const pidPath = runtimePath ?? getRuntimePath(rootDir, normalizedPort, runtimeDir);
  const url = buildWebUrl({ host, port: normalizedPort });
  const record = await readRecord(pidPath, dependencies);

  if (!record) {
    const external = await dependencies.probe({ host, port: normalizedPort, timeoutMs: 500 });
    return { status: external ? 'not-managed' : 'not-running', managed: false, port: normalizedPort, url };
  }

  if (record.rootDir !== path.resolve(rootDir) || record.port !== normalizedPort) {
    throw new Error(`Web PID record does not belong to ${path.resolve(rootDir)}:${normalizedPort}`);
  }

  if (!(await dependencies.isAlive(record.pid))) {
    await removeRecord(pidPath, dependencies, record.pid);
    const external = await dependencies.probe({ host, port: normalizedPort, timeoutMs: 500 });
    return { status: external ? 'not-managed' : 'not-running', managed: !external, port: normalizedPort, url };
  }

  if (!(await dependencies.isOwned(record))) {
    throw new Error(`refusing to stop PID ${record.pid}: process ownership could not be verified`);
  }

  await dependencies.terminate(record.pid);
  if (!(await waitForExit(dependencies, record.pid, stopTimeoutMs))) {
    throw new Error(`Web process ${record.pid} did not stop within ${stopTimeoutMs}ms`);
  }
  await removeRecord(pidPath, dependencies, record.pid);
  return { status: 'stopped', managed: true, pid: record.pid, port: normalizedPort, url };
}

export async function restartWeb(options = {}) {
  const stopped = await stopWeb(options);
  if (stopped.status === 'not-managed') {
    throw new Error(`refusing to restart an unmanaged Web process on port ${stopped.port}`);
  }
  const started = await startWeb(options);
  return { status: 'restarted', stopped, started };
}
