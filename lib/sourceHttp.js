import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { getDomain } from 'tldts';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  isRemoteSkillFilePathInput,
  validateRemoteSkillFileUrl
} from './sourceRemoteFilePolicy.js';

const DEFAULT_HTTP_LIMITS = {
  maxDownloadBytes: 100 * 1024 * 1024,
  maxRedirects: 5,
  connectionTimeoutMs: 15_000,
  completeTimeoutMs: 120_000
};
const DEFAULT_REMOTE_SKILL_FILE_LIMITS = {
  ...DEFAULT_HTTP_LIMITS,
  maxDownloadBytes: 1024 * 1024
};

export function isRemoteArchiveInput(input) {
  if (typeof input !== 'string') return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input.trim());
}

export function isRemoteSkillFileInput(input) {
  return isRemoteSkillFilePathInput(input);
}

export function parseRemoteSkillFileRequest(request) {
  if (!request || typeof request.input !== 'string' || !request.input.trim()) {
    throw new Error('Source add requires request.input');
  }
  if (typeof request.name !== 'string' || !request.name) {
    throw identityError('Remote file source requires an explicit non-empty name');
  }
  if (request.namespace !== undefined) {
    throw identityError('Remote file source does not accept a namespace');
  }
  const parsedInput = parseRemoteSkillFileInput(request.input);
  return {
    ...parsedInput,
    name: request.name
  };
}

export function parseRemoteSkillFileInput(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Remote file source input is required');
  }
  let parsed;
  try {
    parsed = validateRemoteSkillFileUrl(input, { allowFragment: true });
  } catch (error) {
    throw downloadError(error.message);
  }
  return {
    input: parsed.display,
    ...parsed
  };
}

export function parseRemoteArchiveRequest(request) {
  if (!request || typeof request.input !== 'string' || !request.input.trim()) {
    throw new Error('Source add requires request.input');
  }
  const parsedInput = parseRemoteArchiveInput(request.input);
  const url = parsedInput.url;
  const name = request.name === undefined ? inferArchiveName(url) : request.name;
  if (typeof name !== 'string' || !name) {
    throw identityError('Remote Archive name must be a non-empty identity segment');
  }
  if (
    request.namespace !== undefined &&
    (typeof request.namespace !== 'string' || !request.namespace)
  ) {
    throw identityError('Remote Archive namespace must be a non-empty identity segment');
  }
  return {
    ...parsedInput,
    name,
    namespace: request.namespace,
    registrableDomain: getDomain(url.hostname, { allowPrivateDomains: true }) ||
      url.hostname.toLowerCase()
  };
}

export function parseRemoteArchiveInput(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Remote Archive input is required');
  }
  const url = requireHttpUrl(input);
  return {
    input: input.trim(),
    url,
    display: sanitizeRemoteArchiveUrl(url),
    protocol: url.protocol.slice(0, -1)
  };
}

export async function downloadRemoteArchive(input, destination, options = {}) {
  return downloadRemoteResource(input, destination, {
    ...options,
    defaultLimits: DEFAULT_HTTP_LIMITS,
    resourceLabel: 'Remote ZIP'
  });
}

export async function downloadRemoteSkillFile(input, destination, options = {}) {
  return downloadRemoteResource(input, destination, {
    ...options,
    defaultLimits: DEFAULT_REMOTE_SKILL_FILE_LIMITS,
    resourceLabel: 'Remote SKILL.md',
    validateUrl: (url) => parseRemoteSkillFileInput(url.toString())
  });
}

async function downloadRemoteResource(input, destination, options) {
  const limits = { ...options.defaultLimits, ...options.limits };
  const resourceLabel = options.resourceLabel;
  const controller = new AbortController();
  const completeTimer = setTimeout(() => {
    controller.abort(downloadError(
      `${resourceLabel} complete-download timeout exceeded`
    ));
  }, limits.completeTimeoutMs);

  try {
    const response = await followRedirects(
      requireHttpUrl(input),
      limits,
      options.lookup,
      controller.signal,
      options.validateUrl,
      resourceLabel
    );
    await writeResponse(
      response,
      destination,
      limits.maxDownloadBytes,
      resourceLabel
    );
  } catch (error) {
    await rm(destination, { force: true });
    if (error instanceof SourceAcquisitionError) throw error;
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof SourceAcquisitionError
    ) {
      throw controller.signal.reason;
    }
    if (error.cause instanceof SourceAcquisitionError) throw error.cause;
    throw downloadError(`${resourceLabel} download was truncated or interrupted`);
  } finally {
    clearTimeout(completeTimer);
  }
}

async function followRedirects(
  url,
  limits,
  lookup,
  signal,
  validateUrl,
  resourceLabel,
  redirectCount = 0
) {
  if (validateUrl) validateUrl(url);
  const response = await requestUrl(url, {
    connectionTimeoutMs: limits.connectionTimeoutMs,
    lookup,
    signal,
    resourceLabel
  });
  if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw downloadError(
        `${resourceLabel} request failed with HTTP ${response.statusCode}`
      );
    }
    return response;
  }

  response.resume();
  if (redirectCount >= limits.maxRedirects) {
    throw downloadError(
      `${resourceLabel} exceeded ${limits.maxRedirects} redirects`
    );
  }
  const location = response.headers.location;
  if (!location) {
    throw downloadError(`${resourceLabel} redirect is missing Location`);
  }
  let next;
  try {
    next = new URL(location, url);
  } catch {
    throw downloadError(`${resourceLabel} redirect has an invalid Location`);
  }
  if (next.protocol !== url.protocol) {
    throw downloadError(`${resourceLabel} redirect changed protocol`);
  }
  return followRedirects(
    next,
    limits,
    lookup,
    signal,
    validateUrl,
    resourceLabel,
    redirectCount + 1
  );
}

function requestUrl(url, {
  connectionTimeoutMs,
  lookup,
  signal,
  resourceLabel
}) {
  const client = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { lookup, signal }, resolve);
    let connectionTimer;
    request.once('socket', (socket) => {
      if (!socket.connecting) return;
      connectionTimer = setTimeout(() => {
        request.destroy(downloadError(
          `${resourceLabel} connection timeout exceeded`
        ));
      }, connectionTimeoutMs);
      const event = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      socket.once(event, () => clearTimeout(connectionTimer));
    });
    request.once('error', reject);
    request.once('close', () => clearTimeout(connectionTimer));
  });
}

async function writeResponse(
  response,
  destination,
  maxDownloadBytes,
  resourceLabel
) {
  let downloadedBytes = 0;
  response.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (downloadedBytes > maxDownloadBytes) {
      response.destroy(downloadError(
        `${resourceLabel} exceeds the ${maxDownloadBytes}-byte download limit`
      ));
    }
  });
  await pipeline(response, createWriteStream(destination, { flags: 'wx' }));
  if (!response.complete) {
    throw downloadError(`${resourceLabel} download was truncated`);
  }
}

function requireHttpUrl(input, inputLabel = 'Remote Archive') {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw downloadError(`${inputLabel} input must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw downloadError(`${inputLabel} input must use HTTP or HTTPS`);
  }
  return url;
}

function sanitizeRemoteArchiveUrl(url) {
  const sanitized = new URL(url);
  sanitized.username = '';
  sanitized.password = '';
  sanitized.search = '';
  sanitized.hash = '';
  return sanitized.toString();
}

function inferArchiveName(url) {
  let basename;
  try {
    basename = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
  } catch {
    throw identityError('Remote Archive URL contains invalid path encoding');
  }
  return basename.replace(/\.zip$/i, '');
}

function identityError(message) {
  return new SourceAcquisitionError('unresolved-identity', message, 3);
}

function downloadError(message) {
  return new SourceAcquisitionError('download-failure', message);
}
