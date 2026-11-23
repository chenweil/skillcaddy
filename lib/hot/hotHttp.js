/**
 * HTTP surface for the hot page.
 *
 * Kept out of `server.js` so the routing, the origin guard, the JSON contract,
 * and the status-code mapping can be exercised over a real socket in tests
 * without duplicating them.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateRequestOrigin, isJsonContentType, originError } from './requestOrigin.js';

const MAX_BODY_BYTES = 64 * 1024;
const ASSET_CACHE_CONTROL = 'public, max-age=86400';
const ASSET_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

export const ERROR_STATUS = {
  origin_rejected: 403,
  unsupported_source: 400,
  unknown_source: 400,
  invalid_request: 400,
  rate_limited: 429,
  install_unavailable: 503
};

/**
 * Build the route handler. Returns a function that resolves to `true` when the
 * request was handled, so `server.js` can keep its own 404 path.
 */
export function createHotRoutes({ api, catalogDir, port } = {}) {
  if (!api) throw new Error('Hot routes require an API instance');

  return async function handleHotRequest(req, res, url) {
    const { pathname } = url;

    if (pathname === '/api/hot' && req.method === 'GET') {
      const payload = await api.ranking({
        window: url.searchParams.get('window') || '24h',
        days: url.searchParams.get('days') || undefined,
        category: url.searchParams.get('category') || undefined
      });
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/hot/skill' && req.method === 'GET') {
      const payload = await api.detail({
        source: url.searchParams.get('source') || '',
        skill: url.searchParams.get('skill') || '',
        window: url.searchParams.get('window') || '24h',
        days: url.searchParams.get('days') || undefined
      });
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/hot/install' && req.method === 'POST') {
      guard(req, port);
      const body = await readJson(req);
      const payload = await api.install({ source: body?.source, skill: body?.skill });
      sendJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/hot/refresh' && req.method === 'POST') {
      guard(req, port);
      await readJson(req);
      sendJson(res, 200, await api.refresh());
      return true;
    }

    if (pathname.startsWith('/catalog-assets/') && req.method === 'GET') {
      await serveCatalogAsset(res, catalogDir, pathname);
      return true;
    }

    return false;
  };
}

function guard(req, port) {
  const verdict = evaluateRequestOrigin(req, { port });
  if (!verdict.ok) throw originError(verdict.reason);
  if (!isJsonContentType(req)) {
    const error = new Error('请求体必须是 application/json');
    error.code = 'invalid_request';
    throw error;
  }
}

async function serveCatalogAsset(res, catalogDir, pathname) {
  const relative = decodeURIComponent(pathname.slice('/catalog-assets/'.length));
  if (!relative.startsWith('covers/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const type = ASSET_TYPES[path.extname(relative).toLowerCase()];
  if (!type) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const root = path.resolve(catalogDir);
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ASSET_CACHE_CONTROL });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.code = 'invalid_request';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.code = 'invalid_request';
    throw error;
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function statusForError(error) {
  if (Number.isFinite(error?.status) && error.status >= 400) return error.status;
  return ERROR_STATUS[error?.code] || 500;
}
