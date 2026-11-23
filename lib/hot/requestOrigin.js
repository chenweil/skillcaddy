/**
 * Same-origin guard for mutating requests.
 *
 * A local server that accepts POSTs from any web page is a drive-by primitive:
 * a malicious site could drive the acquisition pipeline. The rules:
 *
 *   - `Origin`, when present, must be this server's own loopback origin.
 *   - `Sec-Fetch-Site`, when present, must be `same-origin` or `none`.
 *   - `Origin: null` is rejected.
 *
 * Requests without `Origin` (CLI, tests, curl) stay allowed — they are not
 * browser-driven.
 */

export function evaluateRequestOrigin(req, { port } = {}) {
  const origin = req?.headers?.origin;

  if (typeof origin === 'string' && origin) {
    if (origin === 'null') return { ok: false, reason: 'origin_null' };
    if (!isLoopbackOrigin(origin, port)) return { ok: false, reason: 'origin_mismatch' };
  }

  const fetchSite = req?.headers?.['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite) {
    if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return { ok: false, reason: 'cross_site' };
    }
  }

  return { ok: true };
}

export function isLoopbackOrigin(origin, port) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) return false;
  if (port === undefined || port === null) return true;
  return parsed.port === String(port);
}

/** JSON API bodies must be declared as JSON; form posts are rejected outright. */
export function isJsonContentType(req) {
  const value = req?.headers?.['content-type'];
  if (typeof value !== 'string') return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function originError(reason) {
  const error = new Error('拒绝跨站请求');
  error.code = 'origin_rejected';
  error.reason = reason;
  return error;
}
