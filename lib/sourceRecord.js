import path from 'node:path';
import { SOURCE_FOLDERS } from './sourcePolicy.js';

const SUPPORTED_SCHEMA_VERSION = 1;
const SOURCE_BUCKET_BY_TYPE = {
  git: 'github',
  archive: 'official',
  local: 'personal'
};
const SOURCE_TYPES = new Set([...Object.keys(SOURCE_BUCKET_BY_TYPE), 'legacy-local']);
const SOURCE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export function validateSourceId(sourceId) {
  if (typeof sourceId !== 'string') throw new Error('Invalid sourceId');
  const segments = sourceId.split('/');
  if (
    segments.length < 2 ||
    !SOURCE_FOLDERS.includes(segments[0]) ||
    segments.some((segment) => !SOURCE_SEGMENT.test(segment))
  ) {
    throw new Error(`Invalid sourceId: ${sourceId}`);
  }
  return sourceId;
}

export function validateSourceRecord(rootDir, record, expectedSourceId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Source record must be an object');
  }
  if (record.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported source record schemaVersion: ${record.schemaVersion}`);
  }

  const sourceId = validateSourceId(record.sourceId);
  if (expectedSourceId && sourceId !== expectedSourceId) {
    throw new Error(`Source record path does not match sourceId: ${sourceId}`);
  }
  if (!SOURCE_FOLDERS.includes(record.bucket) || !sourceId.startsWith(`${record.bucket}/`)) {
    throw new Error(`Invalid source bucket for ${sourceId}`);
  }
  if (!SOURCE_TYPES.has(record.type)) {
    throw new Error(`Unsupported source type: ${record.type}`);
  }
  if (SOURCE_BUCKET_BY_TYPE[record.type] && SOURCE_BUCKET_BY_TYPE[record.type] !== record.bucket) {
    throw new Error(`Source type ${record.type} must use the ${SOURCE_BUCKET_BY_TYPE[record.type]} bucket`);
  }

  const integrity = validateIntegrity(record.integrity);
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    sourceId,
    bucket: record.bucket,
    type: record.type,
    installPath: validateInstallPath(rootDir, record.installPath, record.bucket),
    origin: validateOrigin(record.type, record.origin),
    ...(integrity ? { integrity } : {}),
    skills: validateSkillPaths(record.skills)
  };
}

function validateInstallPath(rootDir, installPath, bucket) {
  if (
    typeof installPath !== 'string' ||
    path.isAbsolute(installPath) ||
    installPath.includes('\\') ||
    hasControlCharacters(installPath)
  ) {
    throw new Error('installPath must stay inside the central-library root');
  }

  const normalized = path.posix.normalize(installPath);
  const segments = normalized.split('/');
  const resolvedRoot = path.resolve(rootDir);
  const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, normalized));
  if (
    normalized !== installPath ||
    segments.length < 2 ||
    segments[0] !== bucket ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('installPath must stay inside the central-library root');
  }
  return normalized;
}

function validateOrigin(type, origin) {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    throw new Error(`Invalid origin for source type: ${type}`);
  }

  if (type === 'git') {
    if (origin.kind !== 'git' || typeof origin.remote !== 'string' || !origin.remote.trim()) {
      throw new Error('Git source origin requires a remote');
    }
    return compactObject({
      kind: 'git',
      remote: sanitizeRemote(origin.remote),
      ref: optionalString(origin.ref, 'origin.ref'),
      commit: optionalCommit(origin.commit)
    });
  }

  if (type === 'archive') {
    if (origin.kind !== 'https' || typeof origin.display !== 'string' || !origin.display.trim()) {
      throw new Error('Archive source origin requires an HTTPS display URL');
    }
    const display = sanitizeUrl(origin.display, ['https:']);
    return { kind: 'https', display };
  }

  if (type === 'local') {
    if (
      origin.kind !== 'local' ||
      typeof origin.name !== 'string' ||
      !origin.name ||
      path.basename(origin.name) !== origin.name ||
      hasControlCharacters(origin.name)
    ) {
      throw new Error('Local source origin requires a basename');
    }
    return { kind: 'local', name: origin.name };
  }

  if (origin.kind !== 'unknown') {
    throw new Error('Legacy Local source origin must be unknown');
  }
  return { kind: 'unknown' };
}

function validateIntegrity(integrity) {
  if (integrity === undefined) return null;
  if (
    !integrity ||
    typeof integrity !== 'object' ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.value !== 'string' ||
    !SHA256.test(integrity.value)
  ) {
    throw new Error('Invalid source integrity');
  }
  return { algorithm: 'sha256', value: integrity.value.toLowerCase() };
}

function validateSkillPaths(skills) {
  if (!Array.isArray(skills)) throw new Error('Source record skills must be an array');
  const validated = skills.map((skillPath) => {
    if (
      typeof skillPath !== 'string' ||
      !skillPath ||
      path.posix.normalize(skillPath) !== skillPath ||
      path.posix.isAbsolute(skillPath) ||
      skillPath.includes('\\') ||
      hasControlCharacters(skillPath) ||
      skillPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`Invalid discovered skill path: ${skillPath}`);
    }
    return skillPath;
  });
  if (new Set(validated).size !== validated.length) {
    throw new Error('Source record contains duplicate skill paths');
  }
  return validated;
}

function sanitizeRemote(remote) {
  const trimmed = remote.trim();
  if (hasControlCharacters(trimmed)) throw new Error('Invalid Git source origin');
  if (trimmed.includes('://')) return sanitizeUrl(trimmed, ['http:', 'https:', 'ssh:', 'git:']);
  return trimmed.replace(/^[^@\s]+@(?=[^:\s]+:)/, '').replace(/#.*$/, '');
}

function sanitizeUrl(value, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid source origin URL');
  }
  if (!protocols.includes(url.protocol)) throw new Error('Invalid source origin URL');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || hasControlCharacters(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalCommit(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)) {
    throw new Error('Invalid origin.commit');
  }
  return value.toLowerCase();
}

function hasControlCharacters(value) {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
