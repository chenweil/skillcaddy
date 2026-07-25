import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { getDomain } from 'tldts';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';

const DEFAULT_HTTP_LIMITS = {
  maxDownloadBytes: 100 * 1024 * 1024,
  maxRedirects: 5,
  connectionTimeoutMs: 15_000,
  completeTimeoutMs: 120_000
};

export function isRemoteArchiveInput(input) {
  if (typeof input !== 'string') return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input.trim());
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
  const limits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };
  const controller = new AbortController();
  const completeTimer = setTimeout(() => {
    controller.abort(downloadError('Remote ZIP complete-download timeout exceeded'));
  }, limits.completeTimeoutMs);

  try {
    const response = await followRedirects(
      requireHttpUrl(input),
      limits,
      options.lookup,
      controller.signal
    );
    await writeResponse(response, destination, limits.maxDownloadBytes);
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
    throw downloadError('Remote ZIP download was truncated or interrupted');
  } finally {
    clearTimeout(completeTimer);
  }
}

async function followRedirects(url, limits, lookup, signal, redirectCount = 0) {
  const response = await requestUrl(url, {
    connectionTimeoutMs: limits.connectionTimeoutMs,
    lookup,
    signal
  });
  if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw downloadError(`Remote ZIP request failed with HTTP ${response.statusCode}`);
    }
    return response;
  }

  response.resume();
  if (redirectCount >= limits.maxRedirects) {
    throw downloadError(`Remote ZIP exceeded ${limits.maxRedirects} redirects`);
  }
  const location = response.headers.location;
  if (!location) throw downloadError('Remote ZIP redirect is missing Location');
  let next;
  try {
    next = new URL(location, url);
  } catch {
    throw downloadError('Remote ZIP redirect has an invalid Location');
  }
  if (next.protocol !== url.protocol) {
    throw downloadError('Remote ZIP redirect changed protocol');
  }
  return followRedirects(next, limits, lookup, signal, redirectCount + 1);
}

function requestUrl(url, { connectionTimeoutMs, lookup, signal }) {
  const client = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { lookup, signal }, resolve);
    let connectionTimer;
    request.once('socket', (socket) => {
      if (!socket.connecting) return;
      connectionTimer = setTimeout(() => {
        request.destroy(downloadError('Remote ZIP connection timeout exceeded'));
      }, connectionTimeoutMs);
      const event = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      socket.once(event, () => clearTimeout(connectionTimer));
    });
    request.once('error', reject);
    request.once('close', () => clearTimeout(connectionTimer));
  });
}

async function writeResponse(response, destination, maxDownloadBytes) {
  let downloadedBytes = 0;
  response.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (downloadedBytes > maxDownloadBytes) {
      response.destroy(downloadError(
        `Remote ZIP exceeds the ${maxDownloadBytes}-byte download limit`
      ));
    }
  });
  await pipeline(response, createWriteStream(destination, { flags: 'wx' }));
  if (!response.complete) throw downloadError('Remote ZIP download was truncated');
}

function requireHttpUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw downloadError('Remote Archive input must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw downloadError('Remote Archive input must use HTTP or HTTPS');
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
