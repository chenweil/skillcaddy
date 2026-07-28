const GITHUB_HOSTNAMES = new Set(['github.com', 'www.github.com']);

export function isRemoteSkillFilePathInput(input) {
  const url = parseUrl(input);
  return Boolean(
    url &&
    ['http:', 'https:'].includes(url.protocol) &&
    url.pathname.endsWith('/SKILL.md')
  );
}

export function isGitHubBlobSkillFileInput(input) {
  const url = parseUrl(input);
  return Boolean(
    url &&
    GITHUB_HOSTNAMES.has(url.hostname.toLowerCase()) &&
    url.pathname.endsWith('/SKILL.md') &&
    url.pathname.split('/').includes('blob')
  );
}

export function validateRemoteSkillFileUrl(input, options = {}) {
  const url = parseUrl(input);
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Remote file source input must be a valid HTTP(S) URL');
  }
  if (url.username || url.password) {
    throw new Error('Remote file source URL must not contain credentials');
  }
  if (url.search) {
    throw new Error('Remote file source URL must not contain a query');
  }
  if (!url.pathname.endsWith('/SKILL.md')) {
    throw new Error('Remote file source URL path must end with /SKILL.md');
  }
  if (isGitHubBlobSkillFileInput(url)) {
    throw new Error('Remote file source requires a direct SKILL.md URL');
  }
  if (!options.allowFragment && url.hash) {
    throw new Error('Remote file source URL must not contain a fragment');
  }

  const sanitized = new URL(url);
  sanitized.username = '';
  sanitized.password = '';
  sanitized.search = '';
  sanitized.hash = '';
  return {
    url,
    display: sanitized.toString(),
    protocol: url.protocol.slice(0, -1)
  };
}

function parseUrl(input) {
  if (typeof input !== 'string' && !(input instanceof URL)) return null;
  try {
    return new URL(input.toString().trim());
  } catch {
    return null;
  }
}
