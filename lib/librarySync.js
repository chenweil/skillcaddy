import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGitSourceRequest } from './sourceGitUrl.js';
import { sanitizeGitRemote, validateSourceRecord } from './sourceRecord.js';
import { readSourceRecords, writeSourceRecord } from './sourceRegistry.js';
import { extractGzipLibraryArchive } from './libraryImage.js';
import { isPathInsideOrEqual } from './sourcePath.js';
import { checksumDirectoryNormalized, sourcePathExists, validateSourceTree } from './sourceTree.js';
import { scanSkillLinks } from './skillLinkStore.js';
import { getGlobalSkillsDir } from './skillStore.js';
import { getHermesSkillsDir } from './hermesStore.js';
import { SOURCE_FOLDERS } from './sourcePolicy.js';

const execFile = promisify(execFileCallback);
const DEFAULT_SNAPSHOT_RETENTION = 10;
const SYNC_SCHEMA_VERSION = 1;

function isSshGitInput(input) {
  return /^ssh:\/\//i.test(input) ||
    (!input.includes('://') && /^(?:[^@\s]+@)?[^:/\s]+:[^/\s][^\s]*$/.test(input));
}

export class LibrarySyncError extends Error {
  constructor(category, message, exitCode = 1) {
    super(message);
    this.name = 'LibrarySyncError';
    this.category = category;
    this.exitCode = exitCode;
  }
}

/**
 * 将 owner/name、HTTPS 和 SSH 远端统一成可用于 Git 的地址。
 * file:// 仅用于本地测试，不作为公开 CLI 的推荐形式。
 */
export function resolveSyncRepository(value, username) {
  if (!value) {
    if (!username) throw new LibrarySyncError('authentication-required', '无法确定当前 GitHub 用户。请运行 gh auth login 或显式指定 --repo。', 3);
    return `https://github.com/${username}/skillcaddy-library.git`;
  }
  if (/^file:\/\//i.test(value)) return value;
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value) || isSshGitInput(value)) {
    try {
      return isSshGitInput(value)
        ? parseGitSourceRequest({ input: value }).cloneRemote
        : sanitizeGitRemote(value);
    } catch (error) {
      throw new LibrarySyncError('argument', error.message, 2);
    }
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/i, '')}.git`;
  }
  throw new LibrarySyncError('argument', '--repo 需要 owner/name、HTTPS 或 SSH Git URL。', 2);
}

async function readGhToken(run = execFile, { required = true } = {}) {
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 15_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh 未安装或未登录时继续尝试环境变量。
  }
  const token = process.env.SKILLCADDY_SYNC_TOKEN?.trim();
  if (token) return token;
  if (required) {
    throw new LibrarySyncError(
      'authentication-required',
      '同步需要 GitHub gh 认证或 SKILLCADDY_SYNC_TOKEN；请先运行 gh auth login，或设置 SKILLCADDY_SYNC_TOKEN。',
      3
    );
  }
  return null;
}

async function resolveGitHubUser(run = execFile) {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 });
    const username = stdout.trim();
    if (username) return username;
  } catch {
    // 由调用方报告可操作的认证提示。
  }
  throw new LibrarySyncError('authentication-required', '无法读取当前 GitHub 用户。请运行 gh auth login，或使用 --repo 指定远端。', 3);
}

async function buildGitOptions(remote, run = execFile) {
  if (/^file:\/\//i.test(remote)) return { args: [], env: process.env };
  const isGitHub = /^(?:https:\/\/|ssh:\/\/|git@)github\.com[:/]/i.test(remote);
  const token = isGitHub && /^https:\/\//i.test(remote) ? await readGhToken(run) : null;
  if (/^https:\/\//i.test(remote) && token) {
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    return { args: ['-c', `http.extraHeader=${header}`], env: process.env };
  }
  // SSH 认证由 ssh-agent / Git credential helper 完成；gh/token 仍作为
  // 未认证检查，避免在没有任何凭据时对远端进行写操作。
  return { args: [], env: process.env };
}

async function runGit(cwd, args, options = {}, run = execFile) {
  try {
    return await run('git', ['-C', cwd, ...options.gitArgs || [], ...args], {
      timeout: options.timeoutMs || 300_000,
      env: options.env || process.env,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new LibrarySyncError('remote', detail || 'Git remote operation failed.');
  }
}

async function cloneRemote(remote, directory, gitOptions, run) {
  try {
    await run('git', [...gitOptions.args, 'clone', remote, directory], {
      timeout: 300_000,
      env: gitOptions.env,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    if (/repository .* does not exist|not found|could not read from remote/i.test(detail)) {
      throw new LibrarySyncError('remote-not-found', `${detail}\n请先创建私有同步仓库并确认当前账号有访问权限。`);
    }
    throw new LibrarySyncError('remote', detail || '无法克隆同步远端。');
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

function payloadPath(sourceId) {
  return path.join('sources', `${sourceId}.tar.gz`);
}

function validatePayloadPath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (!normalized.startsWith('sources/') || normalized.includes('..') || path.posix.isAbsolute(normalized)) {
    throw new LibrarySyncError('remote-state', `远端 payload 路径不安全：${relativePath}`);
  }
}

function sourceState(record, checksum, head) {
  return record.type === 'git'
    ? { kind: 'git', value: head }
    : { kind: 'checksum', value: checksum };
}

function projectRecord(record, state) {
  const origin = record.type === 'git' && state.value
    ? { ...record.origin, commit: state.value }
    : record.origin;
  return {
    schemaVersion: 1,
    sourceId: record.sourceId,
    bucket: record.bucket,
    type: record.type,
    installPath: record.installPath,
    origin,
    ...(record.focus ? { focus: record.focus } : {}),
    ...(record.integrity ? { integrity: record.integrity } : {}),
    skills: record.skills,
    state
  };
}

async function collectEnablement(context, records) {
  const result = [];
  const scopes = {
    global: getGlobalSkillsDir(context.globalDir),
    hermes: getHermesSkillsDir(context.hermesDir)
  };
  for (const [scope, directory] of Object.entries(scopes)) {
    for (const item of await scanSkillLinks(directory)) {
      if (!item.isSymlink || item.alias === 'skillcaddy-manager' || !item.targetPath) continue;
      const relative = path.relative(context.rootDir, item.targetPath).split(path.sep).join('/');
      if (!SOURCE_FOLDERS.includes(relative.split('/')[0])) continue;
      if (records.some(record => record.skills.some(skill => `${record.installPath}/${skill}`.replace(/\/\.$/, '') === relative))) {
        result.push({ scope, libraryPath: relative, alias: item.alias });
      }
    }
  }
  return result.sort((left, right) => `${left.scope}/${left.alias}`.localeCompare(`${right.scope}/${right.alias}`));
}

async function readLocalManifest(context) {
  const records = await readSourceRecords(context.rootDir);
  const sources = [];
  for (const record of records) {
    const sourcePath = path.join(context.rootDir, record.installPath);
    if (!await sourcePathExists(sourcePath)) {
      throw new LibrarySyncError('local-state', `登记的 source 缺少安装目录：${record.sourceId}`);
    }
    const checksum = await checksumDirectoryNormalized(sourcePath);
    let head;
    let dirty = false;
    if (record.type === 'git') {
      try {
        head = (await runGit(sourcePath, ['rev-parse', 'HEAD'], {}, context.run)).stdout.trim();
        dirty = Boolean((await runGit(sourcePath, ['status', '--porcelain'], {}, context.run)).stdout.trim());
      } catch {
        throw new LibrarySyncError('local-state', `Git source 无法读取 HEAD：${record.sourceId}`);
      }
    }
    sources.push(projectRecord(record, { ...sourceState(record, checksum, head), dirty }));
  }
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    sources: sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    enablement: await collectEnablement(context, records)
  };
}

function manifestSourceMap(manifest) {
  return new Map((manifest?.sources || []).map(source => [source.sourceId, source]));
}

async function compareGitStates(local, remote, sourcePath, run, remoteArchive) {
  if (local.state?.value === remote.state?.value) return 'same';
  if (!sourcePath || local.state?.kind !== 'git' || remote.state?.kind !== 'git' || !remoteArchive) return 'conflict';
  const staging = await mkdtemp(path.join(tmpdir(), 'skillcaddy-sync-graph-'));
  const graph = path.join(staging, 'graph.git');
  try {
    await unpackSource(remoteArchive, staging, run);
    const remoteSource = path.join(staging, remote.installPath);
    await run('git', ['init', '--bare', graph], { timeout: 30_000 });
    await run('git', ['--git-dir', graph, 'fetch', '--no-tags', sourcePath], { timeout: 120_000 });
    await run('git', ['--git-dir', graph, 'fetch', '--no-tags', remoteSource], { timeout: 120_000 });
    const ancestor = async (from, to) => {
      try {
        await run('git', ['--git-dir', graph, 'merge-base', '--is-ancestor', from, to], { timeout: 30_000 });
        return true;
      } catch { return false; }
    };
    if (await ancestor(remote.state.value, local.state.value)) return 'local-ahead';
    if (await ancestor(local.state.value, remote.state.value)) return 'remote-ahead';
    return 'conflict';
  } catch {
    return 'conflict';
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function compareSyncState(context, localManifest, remoteManifest, run = context.run || execFile, options = {}) {
  const local = manifestSourceMap(localManifest);
  const remote = manifestSourceMap(remoteManifest);
  const sourceIds = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const changes = [];
  for (const sourceId of sourceIds) {
    const left = local.get(sourceId);
    const right = remote.get(sourceId);
    if (!left) {
      const collision = [...local.values()].find(candidate => candidate.installPath === right.installPath);
      changes.push(collision
        ? { sourceId, status: 'conflict', remote: right, local: collision, conflict: 'identity' }
        : { sourceId, status: 'remote-only', remote: right });
      continue;
    }
    if (!right) {
      const collision = [...remote.values()].find(candidate => candidate.installPath === left.installPath);
      changes.push(collision
        ? { sourceId, status: 'conflict', local: left, remote: collision, conflict: 'identity' }
        : { sourceId, status: 'local-only', local: left });
      continue;
    }
    if (left.installPath !== right.installPath || left.type !== right.type) {
      changes.push({ sourceId, status: 'conflict', local: left, remote: right, conflict: 'identity' });
      continue;
    }
    const remoteArchive = options.remoteWorkspace
      ? path.join(options.remoteWorkspace, payloadPath(sourceId))
      : null;
    const status = left.state?.dirty
      ? 'local-dirty'
      : await compareGitStates(left, right, path.join(context.rootDir, left.installPath), run, remoteArchive);
    changes.push({ sourceId, status, local: left, remote: right });
  }
  if (JSON.stringify(localManifest.enablement || []) !== JSON.stringify(remoteManifest.enablement || [])) {
    changes.push({ sourceId: '(enablement)', status: 'enablement-drift', local: localManifest.enablement || [], remote: remoteManifest.enablement || [] });
  }
  return changes;
}

async function validateArchiveEntries(archive, run = execFile) {
  let stdout;
  try {
    ({ stdout } = await run('tar', ['-tzf', archive], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    throw new LibrarySyncError('source-safety', `无法读取同步 source archive：${error.message}`);
  }
  for (const entry of stdout.split('\n').map(item => item.trim()).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new LibrarySyncError('source-safety', `同步 source archive 含有不安全路径：${entry}`);
    }
  }
}

async function packSource(context, source, destination, run = execFile) {
  const sourcePath = path.join(context.rootDir, source.installPath);
  await validateSourceTree(sourcePath, sourcePath);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await run('tar', ['-czf', destination, '-C', context.rootDir, '--', source.installPath], {
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    throw new LibrarySyncError('local-state', `打包 source 失败：${source.sourceId}：${error.message}`);
  }
}

async function unpackSource(archive, destination, run = execFile) {
  await validateArchiveEntries(archive, run);
  await mkdir(destination, { recursive: true });
  try {
    await extractGzipLibraryArchive(archive, destination, {
      tarPath: 'tar',
      timeoutMs: 120_000,
      imageLimits: {
        maxExpandedBytes: 500 * 1024 * 1024,
        maxEntries: 10_000,
        maxFileBytes: 100 * 1024 * 1024,
        maxDepth: 40
      }
    });
  } catch (error) {
    throw new LibrarySyncError('source-safety', `解包同步 source 失败：${error.message}`);
  }
}

async function writeManifest(workspace, manifest) {
  await writeFile(path.join(workspace, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function readRemoteManifest(workspace) {
  try {
    const manifest = JSON.parse(await readFile(path.join(workspace, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== SYNC_SCHEMA_VERSION || !Array.isArray(manifest.sources) || !Array.isArray(manifest.enablement)) {
      throw new Error('manifest schema');
    }
    const sourceIds = new Set();
    for (const source of manifest.sources) {
      if (typeof source.sourceId !== 'string' || typeof source.installPath !== 'string' || sourceIds.has(source.sourceId)) throw new Error('source shape');
      sourceIds.add(source.sourceId);
      validatePayloadPath(payloadPath(source.sourceId));
      if (!source.state || !['git', 'checksum'].includes(source.state.kind) ||
          typeof source.state.value !== 'string' || !/^[a-f0-9]{40,64}$/i.test(source.state.value) ||
          (source.type === 'git') !== (source.state.kind === 'git')) throw new Error('source state');
      if (!await sourcePathExists(path.join(workspace, payloadPath(source.sourceId)))) {
        throw new Error(`missing payload: ${source.sourceId}`);
      }
    }
    validateManifestEnablements(manifest.enablement);
    return manifest;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: SYNC_SCHEMA_VERSION, sources: [], enablement: [] };
    throw new LibrarySyncError('remote-state', `远端 manifest.json 无效：${error.message}`);
  }
}

async function copySnapshot(workspace, manifest, timestamp) {
  const snapshot = path.join(workspace, 'snapshots', timestamp);
  await mkdir(path.join(snapshot, 'sources'), { recursive: true });
  const manifestPath = path.join(workspace, 'manifest.json');
  if (await sourcePathExists(manifestPath)) {
    await cp(manifestPath, path.join(snapshot, 'manifest.json'));
  } else {
    await writeFile(path.join(snapshot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  for (const source of manifest.sources || []) {
    const sourceFile = path.join(workspace, payloadPath(source.sourceId));
    if (await sourcePathExists(sourceFile)) {
      const target = path.join(snapshot, payloadPath(source.sourceId));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(sourceFile, target);
    }
  }
  return snapshot;
}

async function pruneSnapshots(workspace, retention = DEFAULT_SNAPSHOT_RETENTION) {
  if (!Number.isSafeInteger(retention) || retention < 0) throw new LibrarySyncError('argument', 'snapshot retention 必须是非负整数。', 2);
  if (retention === 0) return;
  const root = path.join(workspace, 'snapshots');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const snapshots = entries.filter(entry => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of snapshots.slice(0, Math.max(0, snapshots.length - retention))) {
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

async function commitRemote(workspace, message, gitOptions, run) {
  await runGit(workspace, ['add', '-A'], { gitArgs: gitOptions.args }, run);
  try {
    await runGit(workspace, ['-c', 'user.name=skillcaddy', '-c', 'user.email=skillcaddy@localhost', 'commit', '-m', message], { gitArgs: gitOptions.args }, run);
  } catch (error) {
    if (!/nothing to commit/i.test(error.message)) throw error;
  }
  const branch = (await runGit(workspace, ['branch', '--show-current'], { gitArgs: gitOptions.args }, run)).stdout.trim() || 'main';
  try {
    await runGit(workspace, ['push', 'origin', `HEAD:${branch}`], { gitArgs: gitOptions.args }, run);
  } catch (error) {
    throw new LibrarySyncError('remote-concurrent-update', `${error.message}\n远端在同步期间发生变化，请重新运行 sync status 后再试。`);
  }
}

function timestamp() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

function archiveDirectoryName(sourceId, suffix) {
  return `${sourceId.replaceAll('/', '--')}--${suffix}`;
}

async function archiveRemoteCandidate(context, workspace, source, suffix, report) {
  const archive = path.join(workspace, payloadPath(source.sourceId));
  if (!await sourcePathExists(archive)) throw new LibrarySyncError('remote-state', `远端缺少 source payload：${source.sourceId}`);
  const target = path.join(context.rootDir, 'archived', archiveDirectoryName(source.sourceId, suffix));
  await rm(target, { recursive: true, force: true });
  const unpackRoot = await mkdtemp(path.join(tmpdir(), 'skillcaddy-sync-archive-'));
  try {
    await unpackSource(archive, unpackRoot, context.run);
    const extracted = path.join(unpackRoot, source.installPath);
    if (!await sourcePathExists(extracted)) throw new LibrarySyncError('source-safety', `远端候选路径与 manifest 不一致：${source.sourceId}`);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(extracted, target);
  } finally {
    await rm(unpackRoot, { recursive: true, force: true });
  }
  report.push({ sourceId: source.sourceId, type: 'remote', path: path.relative(context.rootDir, target), recommendation: '人工比较后决定是否保留或重新登记。' });
}

async function installRemoteSource(context, workspace, source, report) {
  const archive = path.join(workspace, payloadPath(source.sourceId));
  if (!await sourcePathExists(archive)) throw new LibrarySyncError('remote-state', `远端缺少 source payload：${source.sourceId}`);
  const staging = await mkdtemp(path.join(tmpdir(), 'skillcaddy-sync-source-'));
  const backup = path.join(tmpdir(), `skillcaddy-sync-backup-${Date.now()}-${randomBytes(3).toString('hex')}`);
  const target = path.join(context.rootDir, source.installPath);
  const stagedTarget = path.join(staging, source.installPath);
  try {
    await unpackSource(archive, staging, context.run);
    if (!await sourcePathExists(stagedTarget)) throw new LibrarySyncError('source-safety', `远端 payload 路径与 manifest 不一致：${source.sourceId}`);
    await validateSourceTree(stagedTarget, stagedTarget);
    const expected = source.state?.kind === 'checksum'
      ? source.state.value
      : source.state?.value;
    const actual = source.state?.kind === 'checksum'
      ? await checksumDirectoryNormalized(stagedTarget)
      : (await runGit(stagedTarget, ['rev-parse', 'HEAD'], {}, context.run)).stdout.trim();
    if (actual !== expected) throw new LibrarySyncError('source-validation', `远端 source 完整性校验失败：${source.sourceId}`);
    await mkdir(path.dirname(target), { recursive: true });
    const targetExists = await sourcePathExists(target);
    if (targetExists && source.type === 'git') {
      const current = (await runGit(target, ['rev-parse', 'HEAD'], {}, context.run)).stdout.trim();
      const incoming = source.state?.value;
      await runGit(target, ['fetch', '--no-tags', stagedTarget], {}, context.run);
      try {
        await runGit(target, ['merge-base', '--is-ancestor', current, incoming], {}, context.run);
      } catch {
        throw new LibrarySyncError('non-fast-forward', `Git source 不是快进方向：${source.sourceId}`);
      }
      await runGit(target, ['merge', '--ff-only', '--no-edit', incoming], {}, context.run);
    } else {
      if (targetExists) await rename(target, backup);
      await rename(stagedTarget, target);
    }
    const record = validateSourceRecord(context.rootDir, source);
    await writeSourceRecord(context.rootDir, record);
    if (targetExists) await rm(backup, { recursive: true, force: true });
    report.push({ sourceId: source.sourceId, type: 'applied', path: source.installPath });
  } catch (error) {
    if (await sourcePathExists(target) && await sourcePathExists(backup)) await rm(target, { recursive: true, force: true });
    if (await sourcePathExists(backup)) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

async function applyEnablement(context, manifest, records, report) {
  const scopes = { global: getGlobalSkillsDir(context.globalDir), hermes: getHermesSkillsDir(context.hermesDir) };
  for (const triple of manifest.enablement || []) {
    if (!scopes[triple.scope] || triple.alias === 'skillcaddy-manager') continue;
    const target = path.resolve(context.rootDir, triple.libraryPath);
    const root = await realpath(context.rootDir);
    if (!isPathInsideOrEqual(root, target)) continue;
    if (!await sourcePathExists(target) || !isPathInsideOrEqual(root, await realpath(target).catch(() => target))) continue;
    const directory = scopes[triple.scope];
    await mkdir(directory, { recursive: true });
    const linkPath = path.join(directory, triple.alias);
    try {
      const existing = await readlink(linkPath);
      if (path.resolve(path.dirname(linkPath), existing) === path.resolve(target)) continue;
      report.push({ sourceId: triple.libraryPath, type: 'enablement-conflict', path: `${triple.scope}/${triple.alias}`, recommendation: '保留现有 alias，人工处理冲突。' });
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
      await symlink(target, linkPath);
      report.push({ sourceId: triple.libraryPath, type: 'enablement-applied', path: `${triple.scope}/${triple.alias}` });
    }
  }
}

function validateManifestEnablements(enablement) {
  const aliases = new Set();
  for (const triple of enablement) {
    if (!triple || typeof triple !== 'object' || Array.isArray(triple) ||
        !['global', 'hermes'].includes(triple.scope) || typeof triple.alias !== 'string' ||
        !triple.alias || triple.alias === '.' || triple.alias === '..' ||
        /[\\/\u0000-\u001f\u007f]/.test(triple.alias) || typeof triple.libraryPath !== 'string' ||
        path.posix.isAbsolute(triple.libraryPath) || triple.libraryPath.includes('\\') ||
        path.posix.normalize(triple.libraryPath) !== triple.libraryPath ||
        triple.libraryPath.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
        !SOURCE_FOLDERS.includes(triple.libraryPath.split('/')[0])) {
      throw new LibrarySyncError('remote-state', '远端 manifest 含有无效的 enablement triple。');
    }
    const key = `${triple.scope}\0${triple.alias}`;
    if (aliases.has(key)) throw new LibrarySyncError('remote-state', `远端 manifest 重复 enablement alias：${key.replace('\\0', '/')}`);
    aliases.add(key);
  }
}

function ensureManifestSources(manifest) {
  for (const source of manifest.sources || []) {
    try { validateSourceRecord('/tmp/skillcaddy-sync-validation', source); } catch (error) {
      throw new LibrarySyncError('remote-state', `远端 source 记录无效：${source.sourceId || '(unknown)'}：${error.message}`);
    }
  }
}

export async function syncLibrary(context, operation, options = {}) {
  if (!['status', 'push', 'pull'].includes(operation)) throw new LibrarySyncError('argument', 'sync 需要 status、push 或 pull。', 2);
  const run = options.run || context.run || execFile;
  const username = options.repo ? null : await resolveGitHubUser(run);
  const remote = resolveSyncRepository(options.repo, username);
  const gitOptions = await buildGitOptions(remote, run);
  const workspace = await mkdtemp(path.join(tmpdir(), 'skillcaddy-sync-'));
  const clonePath = path.join(workspace, 'remote');
  const result = { operation, repository: remote, changes: [], applied: [], conflicts: [], snapshots: [] };
  try {
    await cloneRemote(remote, clonePath, gitOptions, run);
    const localManifest = await readLocalManifest({ ...context, run });
    const remoteManifest = await readRemoteManifest(clonePath);
    ensureManifestSources(remoteManifest);
    result.changes = await compareSyncState({ ...context, run }, localManifest, remoteManifest, run, { remoteWorkspace: clonePath });
    if (operation === 'status') return result;

    const snapshotId = timestamp();
    await copySnapshot(clonePath, remoteManifest, snapshotId);
    result.snapshots.push(`snapshots/${snapshotId}`);

    const merged = new Map(remoteManifest.sources.map(source => [source.sourceId, source]));
    const conflictReports = [];
    for (const change of result.changes) {
      if (change.sourceId === '(enablement)') continue;
      if (operation === 'push') {
        if (['local-only', 'local-ahead'].includes(change.status)) {
          const source = change.local;
          const destination = path.join(clonePath, payloadPath(source.sourceId));
          await packSource(context, source, destination, run);
          merged.set(source.sourceId, source);
        } else if (change.status === 'conflict' || change.status === 'local-dirty') {
          if (change.remote) {
            await archiveRemoteCandidate(context, clonePath, change.remote, 'remote', conflictReports);
          }
          if (change.status === 'local-dirty') {
            conflictReports.push({ sourceId: change.sourceId, type: 'local-dirty', path: change.local.installPath, recommendation: '先提交或清理本地 Git 工作区，再执行同步。' });
          }
        }
      } else if (['remote-only', 'remote-ahead'].includes(change.status)) {
        await installRemoteSource(context, clonePath, change.remote, result.applied);
      } else if (change.status === 'conflict' || change.status === 'local-dirty') {
        if (change.remote) await archiveRemoteCandidate(context, clonePath, change.remote, 'remote', conflictReports);
      }
    }

    if (operation === 'push') {
      const enablementChanged = result.changes.some(change => change.sourceId === '(enablement)');
      const manifest = { schemaVersion: SYNC_SCHEMA_VERSION, generatedAt: new Date().toISOString(), sources: [...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)), enablement: enablementChanged ? localManifest.enablement : remoteManifest.enablement };
      await writeManifest(clonePath, manifest);
      await pruneSnapshots(clonePath, options.snapshotRetention ?? context.snapshotRetention ?? DEFAULT_SNAPSHOT_RETENTION);
      await commitRemote(clonePath, `sync: push library ${snapshotId}`, gitOptions, run);
    } else {
      await applyEnablement(context, remoteManifest, await readSourceRecords(context.rootDir), result.applied);
      await pruneSnapshots(clonePath, options.snapshotRetention ?? context.snapshotRetention ?? DEFAULT_SNAPSHOT_RETENTION);
      await commitRemote(clonePath, `sync: pull library ${snapshotId}`, gitOptions, run);
    }
    result.conflicts = conflictReports;
    result.changes = result.changes.concat(conflictReports.map(item => ({ sourceId: item.sourceId, status: 'conflict-archived', ...item })));
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function formatSyncReport(result) {
  const lines = [`Sync ${result.operation}: ${result.repository}`];
  if (result.changes.length === 0) lines.push('  no changes');
  for (const change of result.changes) {
    lines.push(`  [${change.status}] ${change.sourceId}`);
    if (change.path) lines.push(`    path: ${change.path}`);
    if (change.recommendation) lines.push(`    action: ${change.recommendation}`);
  }
  for (const item of result.applied || []) lines.push(`  [${item.type}] ${item.sourceId} (${item.path})`);
  for (const item of result.conflicts || []) {
    lines.push(`  [conflict] ${item.sourceId} (${item.type})`);
    lines.push(`    archived: ${item.path}`);
    lines.push(`    action: ${item.recommendation}`);
  }
  for (const snapshot of result.snapshots || []) lines.push(`  snapshot: ${snapshot}`);
  return `${lines.join('\n')}\n`;
}

export { DEFAULT_SNAPSHOT_RETENTION, payloadPath };
