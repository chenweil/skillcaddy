import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSourceInstaller } from '../lib/catalog.js';
import { createHotApi } from '../lib/hot/hotApi.js';
import { createHotRoutes } from '../lib/hot/hotHttp.js';
import { createMetadataLoader } from '../lib/hot/hotMetadata.js';
import { computeRanking } from '../lib/hot/hotRanking.js';
import { parseLeaderboardHtml } from '../lib/hot/skillsShProvider.js';

const COMMIT = 'a'.repeat(40);

/** `testHelpers.makeTempDir` resolves to undefined; these fixtures need the path. */
async function makeTempDir(prefix) {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const fixtureHtml = (name) =>
  readFile(new URL(`./fixtures/hot/${name}.html`, import.meta.url), 'utf8');

async function makeCatalog() {
  const dir = await makeTempDir('hot-catalog-');
  await mkdir(path.join(dir, 'covers'), { recursive: true });
  await writeFile(
    path.join(dir, 'covers', 'demo.webp'),
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    'binary'
  );
  await writeFile(path.join(dir, 'overrides.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-11-23',
    sources: {
      'vercel-labs/skills': {
        category: 'engineering',
        description: '开放 agent skill 工具链的官方来源。',
        verified: true,
        stars: 40511,
        starsCapturedAt: '2026-11-23'
      },
      'beltsh/superpowers': {
        category: 'design',
        description: '视频生成类 skill 合集。',
        cover: 'covers/demo.webp'
      }
    },
    skills: {
      'vercel-labs/skills/find-skills': {
        displayName: 'find-skills',
        description: '发现并安装专门的 agent skill。',
        verified: true
      }
    }
  }), 'utf8');
  return dir;
}

async function makeLibrary({ withInstalled = true } = {}) {
  const root = await makeTempDir('hot-lib-');
  await mkdir(path.join(root, 'github', 'vercel-labs--skills', 'find-skills'), { recursive: true });
  await writeFile(
    path.join(root, 'github', 'vercel-labs--skills', 'find-skills', 'SKILL.md'),
    '# find-skills\n\nDiscover and install skills.\n\n<script>alert(1)</script>\n',
    'utf8'
  );
  await mkdir(path.join(root, '.skillcaddy', 'sources', 'github'), { recursive: true });

  if (withInstalled) {
    await writeFile(
      path.join(root, '.skillcaddy', 'sources', 'github', 'vercel-labs--skills.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceId: 'github/vercel-labs--skills',
        bucket: 'github',
        type: 'git',
        installPath: 'github/vercel-labs--skills',
        origin: { kind: 'git', remote: 'git@github.com:vercel-labs/skills.git', commit: COMMIT },
        skills: ['find-skills']
      }, null, 2),
      'utf8'
    );
  }
  return root;
}

async function makeProvider() {
  const pages = {
    hot: parseLeaderboardHtml(await fixtureHtml('hot')),
    trending: parseLeaderboardHtml(await fixtureHtml('trending')),
    home: parseLeaderboardHtml(await fixtureHtml('home'))
  };
  return {
    source: 'skills.sh',
    snapshots: null,
    async fetchHotRanking({ window = '24h', days } = {}) {
      const ranking = computeRanking({ requested: window, days, pages });
      return {
        source: 'skills.sh',
        generatedAt: '2026-11-23T06:00:00.000Z',
        fetchedAt: '2026-11-23T06:00:00.000Z',
        stale: false,
        offlineSnapshotAt: null,
        ...ranking
      };
    },
    async refresh() {
      return { source: 'skills.sh', refreshed: true };
    }
  };
}

async function makeApi({ withInstalled = true, installer } = {}) {
  const libraryRoot = await makeLibrary({ withInstalled });
  const catalogDir = await makeCatalog();
  const provider = await makeProvider();
  const applied = [];

  const defaultInstaller = createSourceInstaller({
    libraryRoot,
    plan: async (_context, request) => ({ request }),
    apply: async (_context, plan) => {
      applied.push(plan.request.input);
      return {
        status: 'added',
        sourceId: 'github/vercel-labs--agent-browser',
        installPath: 'github/vercel-labs--agent-browser',
        skills: ['.'],
        warnings: []
      };
    }
  });

  const api = createHotApi({
    libraryRoot,
    catalogDir,
    provider,
    installer: installer || defaultInstaller,
    metadata: createMetadataLoader({ catalogDir })
  });

  return { api, libraryRoot, catalogDir, provider, applied };
}

test('ranking merges overrides, category counts, and installed state', async () => {
  const { api } = await makeApi();
  const payload = await api.ranking({ window: '24h' });

  assert.equal(payload.source, 'skills.sh');
  assert.equal(payload.stale, false);
  assert.equal(payload.windowTotal, 3);

  const findSkills = payload.entries.find((entry) => entry.skillId === 'find-skills');
  assert.equal(findSkills.category, 'engineering');
  assert.equal(findSkills.verified, true);
  assert.equal(findSkills.description, '发现并安装专门的 agent skill。');
  assert.equal(findSkills.installed, true);
  assert.equal(findSkills.installable, true);
  assert.equal(findSkills.stars, 40511);

  // 没被 override 覆盖的条目落进 other，而不是被丢掉。
  const regressed = payload.entries.find((entry) => entry.skillId === 'regressed');
  assert.equal(regressed.category, 'other');
  assert.equal(regressed.installed, false);

  const counts = Object.fromEntries(payload.categories.map((item) => [item.key, item.count]));
  assert.equal(counts.engineering, 1);
  assert.equal(counts.other, 2);
});

test('ranking filters by category but keeps window counts intact', async () => {
  const { api } = await makeApi();
  const payload = await api.ranking({ window: '24h', category: 'engineering' });

  assert.equal(payload.total, 1);
  assert.equal(payload.windowTotal, 3);
  assert.equal(payload.entries[0].skillId, 'find-skills');
});

test('detail returns the local SKILL.md for installed sources and a placeholder otherwise', async () => {
  const { api } = await makeApi();

  const installed = await api.detail({ source: 'vercel-labs/skills', skill: 'find-skills' });
  assert.equal(installed.installed, true);
  assert.equal(installed.sourceType, 'git');
  assert.equal(installed.skillMd.available, true);
  assert.match(installed.skillMd.content, /Discover and install skills/);
  assert.equal(installed.validation.sourceReview, '已审核');
  assert.equal(installed.validation.execution, '不执行');
  assert.equal(installed.skills.length, 1);

  const other = await api.detail({ source: 'beltsh/superpowers', skill: 'ai-video-generation' });
  assert.equal(other.installed, false);
  assert.equal(other.skillMd.available, false);
  assert.equal(other.entry.cover, '/catalog-assets/covers/demo.webp');
  assert.equal(other.validation.formatCheck, '未登记');
});

test('install adds an allowlisted GitHub source and creates nothing else', async () => {
  const { api, applied } = await makeApi();
  const result = await api.install({ source: 'vercel-labs/agent-browser' });

  assert.equal(result.status, 'installed');
  assert.deepEqual(applied, ['https://github.com/vercel-labs/agent-browser.git']);
  assert.equal(result.repositoryUrl, 'https://github.com/vercel-labs/agent-browser.git');
});

test('install reports already-installed for a registered source', async () => {
  const { api, applied } = await makeApi();
  const result = await api.install({ source: 'vercel-labs/skills' });

  assert.equal(result.status, 'already-installed');
  assert.equal(result.sourceId, 'github/vercel-labs--skills');
  assert.deepEqual(applied, []);
});

test('install rejects unsupported and unknown sources without touching the library', async () => {
  const { api, libraryRoot } = await makeApi();
  const before = await readdir(path.join(libraryRoot, '.skillcaddy', 'sources', 'github'));

  await assert.rejects(api.install({ source: 'open.feishu.cn' }), (error) => {
    assert.equal(error.code, 'unsupported_source');
    return true;
  });

  await assert.rejects(api.install({ source: '../../etc/passwd' }), (error) => {
    assert.equal(error.code, 'unsupported_source');
    return true;
  });

  await assert.rejects(api.install({ source: 'nobody/nothing' }), (error) => {
    assert.equal(error.code, 'unknown_source');
    return true;
  });

  const after = await readdir(path.join(libraryRoot, '.skillcaddy', 'sources', 'github'));
  assert.deepEqual(after, before);
});

test('refresh is force-limited to once per 30 seconds', async () => {
  let current = 1_000_000;
  const libraryRoot = await makeLibrary();
  const catalogDir = await makeCatalog();
  const api = createHotApi({
    libraryRoot,
    catalogDir,
    provider: await makeProvider(),
    installer: null,
    metadata: createMetadataLoader({ catalogDir }),
    now: () => current
  });

  await api.refresh();
  await assert.rejects(api.refresh(), (error) => {
    assert.equal(error.code, 'rate_limited');
    return true;
  });

  current += 31_000;
  await api.refresh();
});

test('http surface rejects foreign origins, unknown sources and traversal', async () => {
  const { api, catalogDir } = await makeApi();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (await routes(req, res, url)) return;
      res.writeHead(404).end();
    } catch (error) {
      const { statusForError, sendJson } = await import('../lib/hot/hotHttp.js');
      sendJson(res, statusForError(error), { error: error.message, code: error.code || null });
    }
  });

  let routes;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  routes = createHotRoutes({ api, catalogDir, port });
  const base = `http://127.0.0.1:${port}`;

  try {
    const foreign = await fetch(`${base}/api/hot/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ source: 'vercel-labs/agent-browser' })
    });
    assert.equal(foreign.status, 403);

    const nullOrigin = await fetch(`${base}/api/hot/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ source: 'vercel-labs/agent-browser' })
    });
    assert.equal(nullOrigin.status, 403);

    const wrongType = await fetch(`${base}/api/hot/install`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'source=vercel-labs/agent-browser'
    });
    assert.equal(wrongType.status, 400);

    const sameOrigin = await fetch(`${base}/api/hot/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ source: 'vercel-labs/agent-browser' })
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal((await sameOrigin.json()).status, 'installed');

    const unknown = await fetch(`${base}/api/hot/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'nobody/nothing' })
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unknown_source');

    const ranking = await fetch(`${base}/api/hot?window=7d`);
    assert.equal(ranking.status, 200);
    const body = await ranking.json();
    assert.equal(body.window.label, '7 天');

    const cover = await fetch(`${base}/catalog-assets/covers/demo.webp`);
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get('cache-control'), /max-age/);

    const traversal = await fetch(`${base}/catalog-assets/covers/..%2F..%2Foverrides.json`);
    assert.notEqual(traversal.status, 200);

    const outside = await fetch(`${base}/catalog-assets/overrides.json`);
    assert.equal(outside.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
