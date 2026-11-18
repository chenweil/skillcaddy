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

function requestWeb({ host, port, timeoutMs, pathname, readBody = false }) {
  return new Promise((resolve) => {
    const request = http.get({
      host,
      port,
      path: pathname,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const result = { status: response.statusCode, contentType: response.headers['content-type'] };
      response.on('error', () => resolve(result));
      if (!readBody || result.status !== 200) {
        resolve(result);
        response.destroy();
        return;
      }

      // 只读取小体积的版本信息，避免被其他服务的大响应拖住。
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          resolve(result);
          response.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve({ ...result, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', (error) => resolve({ refused: error.code === 'ECONNREFUSED' }));
  });
}

async function defaultProbe({ expectedApp, ...address }) {
  const version = await requestWeb({ ...address, pathname: '/api/version', readBody: Boolean(expectedApp) });
  // 只有连接明确被拒绝才视为端口空闲；占用不等于就绪。
  if (version.refused) return null;
  if (!expectedApp) return { ready: false };
  if (!version.status) return { ready: false, reason: 'no valid HTTP response from the port' };

  let app;
  if (version.body) {
    try {
      app = JSON.parse(version.body);
    } catch {
      // 非 JSON 响应不符合 Skillcaddy 版本接口约定。
    }
  }
  if (app?.name !== expectedApp.name || typeof app?.version !== 'string') {
    return { ready: false, reason: 'the listener is not a Skillcaddy Web service' };
  }
  if (app.version !== expectedApp.version) {
    return { ready: false, reason: `Web version mismatch (expected Skillcaddy v${expectedApp.version})` };
  }

  const home = await requestWeb({ ...address, pathname: '/' });
  if (!home.status) return { ready: false, reason: 'the home page did not respond' };
  if (home.status !== 200) return { ready: false, reason: `the home page returned HTTP ${home.status}` };
  if (!/^text\/html(?:\s*;|$)/i.test(home.contentType)) {
    return { ready: false, reason: 'the home page did not return HTML' };
  }
  return { ready: true };
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

/**
 * 子进程环境。原件库根通过 SKILLCADDY_ROOT 传给 server.js，
 * 让 Web 侧的原件库与 CLI 侧解析到同一个目录。
 */
function buildChildEnv(libraryRoot, port) {
  const env = { ...process.env, PORT: String(port) };
  if (libraryRoot) env.SKILLCADDY_ROOT = path.resolve(libraryRoot);
  return env;
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

async function waitForProbe(dependencies, { host, port, expectedApp, timeoutMs = DEFAULT_START_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const probe = await dependencies.probe({ host, port, expectedApp, timeoutMs: 500 });
    if (probe?.ready) return true;
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
  codeRoot,
  libraryRoot,
  expectedApp,
  projectPath = process.cwd(),
  port = DEFAULT_WEB_PORT,
  open = true,
  runtimeDir = tmpdir(),
  runtimePath,
  serverEntry,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  dependencies: dependencyOverrides,
} = {}) {
  if (!rootDir && !codeRoot) throw new Error('rootDir is required');

  if (!expectedApp?.name || !expectedApp?.version) throw new Error('expected Web name and version are required');

  // Web 进程跑的是代码根里的 server.js；原件库根通过环境变量传给子进程，
  // 两者解耦之后 Web 才能在任意安装形态下指向同一个原件库。
  const resolvedCodeRoot = path.resolve(codeRoot || rootDir);
  const resolvedServerEntry = serverEntry ? path.resolve(serverEntry) : path.join(resolvedCodeRoot, 'server.js');

  const dependencies = makeDependencies(dependencyOverrides);
  const normalizedPort = normalizePort(port);
  const host = DEFAULT_WEB_HOST;
  const pidPath = runtimePath ?? getRuntimePath(resolvedCodeRoot, normalizedPort, runtimeDir);
  const url = buildWebUrl({ host, port: normalizedPort, projectPath });
  const probeOptions = { host, port: normalizedPort, expectedApp };
  const readyOptions = { ...probeOptions, timeoutMs: startTimeoutMs };
  const existing = await readRecord(pidPath, dependencies);

  if (existing) {
    if (existing.rootDir !== resolvedCodeRoot || existing.port !== normalizedPort) {
      throw new Error(`Web PID record does not belong to ${resolvedCodeRoot}:${normalizedPort}`);
    }

    if (await dependencies.isAlive(existing.pid) && await dependencies.isOwned(existing)) {
      const ready = await waitForProbe(dependencies, readyOptions);
      if (!ready) throw new Error(`managed Web process ${existing.pid} did not become ready; try skillcaddy restart --port ${normalizedPort}`);
      await openIfRequested(dependencies, url, open);
      return { status: 'already-running', managed: true, pid: existing.pid, port: normalizedPort, url };
    }

    await removeRecord(pidPath, dependencies, existing.pid);
  }

  const listener = await dependencies.probe({ ...probeOptions, timeoutMs: 500 });
  if (listener) {
    if (!listener.ready) {
      throw new Error(`port ${normalizedPort} is occupied: ${listener.reason}. Stop the service if you own it, or use --port <other-port>.`);
    }
    await openIfRequested(dependencies, url, open);
    return { status: 'already-running', managed: false, port: normalizedPort, url };
  }

  const child = dependencies.spawn(process.execPath, [resolvedServerEntry], {
    cwd: resolvedCodeRoot,
    env: buildChildEnv(libraryRoot, normalizedPort),
    detached: true,
    stdio: 'ignore',
  });
  const record = makeRecord({
    rootDir: resolvedCodeRoot,
    port: normalizedPort,
    serverEntry: resolvedServerEntry,
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
      await terminateBestEffort(dependencies, child.pid);
    }
    if (error?.code === 'EEXIST') {
      const concurrent = await readRecord(pidPath, dependencies);
      if (concurrent && await dependencies.isAlive(concurrent.pid) && await waitForProbe(dependencies, readyOptions)) {
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
  const ready = await waitForProbe(dependencies, readyOptions);
  if (!ready) {
    await terminateBestEffort(dependencies, child.pid);
    await removeRecord(pidPath, dependencies, child.pid);
    throw new Error(`Web process ${child.pid} did not become ready on port ${normalizedPort}`);
  }

  await openIfRequested(dependencies, url, open);
  return { status: 'started', managed: true, pid: child.pid, port: normalizedPort, url };
}

async function terminateBestEffort(dependencies, pid) {
  try {
    await dependencies.terminate(pid);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export async function stopWeb({
  rootDir,
  codeRoot,
  port = DEFAULT_WEB_PORT,
  runtimeDir = tmpdir(),
  runtimePath,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  dependencies: dependencyOverrides,
} = {}) {
  if (!rootDir && !codeRoot) throw new Error('rootDir is required');

  const resolvedCodeRoot = path.resolve(codeRoot || rootDir);
  const dependencies = makeDependencies(dependencyOverrides);
  const normalizedPort = normalizePort(port);
  const host = DEFAULT_WEB_HOST;
  const pidPath = runtimePath ?? getRuntimePath(resolvedCodeRoot, normalizedPort, runtimeDir);
  const url = buildWebUrl({ host, port: normalizedPort });
  const record = await readRecord(pidPath, dependencies);

  if (!record) {
    const external = await dependencies.probe({ host, port: normalizedPort, timeoutMs: 500 });
    return { status: external ? 'not-managed' : 'not-running', managed: false, port: normalizedPort, url };
  }

  if (record.rootDir !== resolvedCodeRoot || record.port !== normalizedPort) {
    throw new Error(`Web PID record does not belong to ${resolvedCodeRoot}:${normalizedPort}`);
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
