import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  disableSkill,
  ensureSourceFolders,
  getState
} from './lib/skillStore.js';
import { syncClaudeSkills, unlinkClaudeSkill, unlinkClaudeSkills } from './lib/claudeStore.js';
import { readVersion } from './lib/version.js';
import { enableProjectSkill } from './lib/projectActions.js';
import { updateSkillMetadata } from './lib/skillMetadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.PORT || 4173);

await ensureSourceFolders(rootDir);
const appInfo = await readVersion(rootDir);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Skillcaddy: http://127.0.0.1:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/version') {
    sendJson(res, 200, appInfo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const projectPath = url.searchParams.get('projectPath') || rootDir;
    sendJson(res, 200, await getState(rootDir, projectPath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/enable') {
    const body = await readJson(req);
    sendJson(res, 200, await enableProjectSkill(rootDir, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skill-metadata') {
    const body = await readJson(req);
    sendJson(res, 200, await updateSkillMetadata(rootDir, body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/disable') {
    const body = await readJson(req);
    sendJson(res, 200, await disableSkill(body));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sync-claude') {
    const body = await readJson(req);
    sendJson(res, 200, await syncClaudeSkills(body.projectPath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/unlink-claude') {
    const body = await readJson(req);
    sendJson(res, 200, await unlinkClaudeSkills(body.projectPath));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/unlink-claude-skill') {
    const body = await readJson(req);
    sendJson(res, 200, await unlinkClaudeSkill(body));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function serveStatic(res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream'
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
