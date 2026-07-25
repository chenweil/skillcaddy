import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { sanitizeGitRemote, validateSourceId } from './sourceRecord.js';

export function isGitSourceInput(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  return /^ssh:\/\//i.test(trimmed) ||
    /^(?:[^@\s]+@)?[^:/\s]+:[^/\s][^\s]*$/.test(trimmed) ||
    /^https:\/\//i.test(trimmed);
}

export function parseGitSourceRequest(request) {
  if (!request || typeof request.input !== 'string' || !request.input.trim()) {
    throw new Error('Source add requires request.input');
  }
  if (request.name !== undefined || request.namespace !== undefined) {
    throw identityError('Git source identity is derived from its repository owner and name');
  }

  const input = request.input.trim();
  if (input.includes('://')) return parseGitUrl(input);
  return parseScpGitUrl(input);
}

export function canonicalGitRepositoryLocation(remote) {
  if (remote.includes('://')) {
    const url = new URL(remote);
    return `${url.hostname.toLowerCase()}/${normalizeRepositoryPath(url.pathname)}`;
  }
  const separator = remote.indexOf(':');
  const host = remote.slice(0, separator).replace(/^.*@/, '').toLowerCase();
  return `${host}/${normalizeRepositoryPath(remote.slice(separator + 1))}`;
}

function parseGitUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw identityError('Invalid Git source URL');
  }
  if (!['https:', 'ssh:'].includes(url.protocol)) {
    throw identityError('Git source URL must use HTTPS or SSH');
  }

  const segments = decodePathSegments(url.pathname);
  if (
    url.protocol === 'https:' &&
    ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) &&
    segments[2] === 'tree'
  ) {
    if (segments.length < 4) {
      throw identityError('GitHub tree URL must include a branch');
    }
    const [owner, rawRepository, , ...treeSegments] = segments;
    const repository = stripGitSuffix(rawRepository);
    const repositoryRemote = `https://github.com/${owner}/${repository}.git`;
    return validateParsedGitSource({
      owner,
      repository,
      cloneRemote: repositoryRemote,
      displayRemote: repositoryRemote,
      treeSegments
    });
  }

  if (segments.length < 2) {
    throw identityError('Git source URL must identify a repository owner and name');
  }
  const owner = segments.at(-2);
  const repository = stripGitSuffix(segments.at(-1));
  const cloneUrl = new URL(url);
  cloneUrl.search = '';
  cloneUrl.hash = '';
  if (cloneUrl.protocol === 'https:') {
    cloneUrl.username = '';
    cloneUrl.password = '';
  } else {
    cloneUrl.password = '';
  }
  return validateParsedGitSource({
    owner,
    repository,
    cloneRemote: cloneUrl.toString(),
    displayRemote: sanitizeGitRemote(cloneUrl.toString())
  });
}

function parseScpGitUrl(input) {
  if (!/^(?:[^@\s]+@)?[^:/\s]+:[^?#\s]+(?:[?#].*)?$/.test(input)) {
    throw identityError('Invalid SSH Git source URL');
  }
  const withoutSensitiveSuffix = input.replace(/[?#].*$/, '');
  const repositoryPath = withoutSensitiveSuffix.slice(withoutSensitiveSuffix.indexOf(':') + 1);
  const segments = decodePathSegments(repositoryPath);
  if (segments.length < 2) {
    throw identityError('Git source URL must identify a repository owner and name');
  }
  return validateParsedGitSource({
    owner: segments.at(-2),
    repository: stripGitSuffix(segments.at(-1)),
    cloneRemote: withoutSensitiveSuffix,
    displayRemote: sanitizeGitRemote(withoutSensitiveSuffix)
  });
}

function validateParsedGitSource(parsed) {
  const sourceId = `github/${parsed.owner}/${parsed.repository}`;
  try {
    validateSourceId(sourceId);
  } catch {
    throw identityError('Git repository owner and name must form a safe source identity');
  }
  return { ...parsed, sourceId };
}

function decodePathSegments(pathname) {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw identityError('Git source URL contains invalid path encoding');
  }
}

function stripGitSuffix(repository) {
  const normalized = repository.replace(/\.git$/i, '');
  if (!normalized) throw identityError('Git source URL has no repository name');
  return normalized;
}

function normalizeRepositoryPath(repositoryPath) {
  return repositoryPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

function identityError(message) {
  return new SourceAcquisitionError('unresolved-identity', message, 3);
}
