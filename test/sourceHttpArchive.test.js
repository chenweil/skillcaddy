import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  access,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAddSource,
  applyUpdateSource,
  inspectSource,
  planAddSource,
  planBreakingUpdateSource,
  planUpdateSource
} from '../lib/sourceManager.js';
import { runSourceCli } from '../scripts/source.js';
import { scanSkills } from '../lib/skillStore.js';
import { makeTempDir } from './testHelpers.js';
import { buildZip } from './zipFixtures.js';

test('acquires a remote ZIP by signature with sanitized provenance and no enablement', async (t) => {
  const archive = buildZip([
    {
      name: 'bundle/skills/remote/SKILL.md',
      content: '---\ndescription: Remote skill\n---\n# Remote\n'
    }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/publisher-package?token=secret');
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': archive.length
    });
    response.end(archive);
  });
  const root = await makeTempDir('source-http-add-root-');
  const project = await makeTempDir('source-http-add-project-');
  const projectBefore = await snapshotProject(project);
  const input = `http://user:password@127.0.0.1:${fixture.port}/publisher-package?token=secret#fragment`;

  const plan = await planAddSource(
    { rootDir: root },
    { input }
  );

  assert.deepEqual(
    {
      status: plan.status,
      sourceId: plan.sourceId,
      installPath: plan.installPath,
      input: plan.input,
      origin: plan.origin,
      skills: plan.skills
    },
    {
      status: 'ready',
      sourceId: 'official/publisher-package',
      installPath: 'official/publisher-package',
      input: {
        type: 'remote-zip',
        display: `http://127.0.0.1:${fixture.port}/publisher-package`
      },
      origin: {
        kind: 'http',
        display: `http://127.0.0.1:${fixture.port}/publisher-package`
      },
      skills: ['skills/remote']
    }
  );

  const result = await applyAddSource({ rootDir: root }, plan);
  assert.equal(result.status, 'added');
  assert.equal(
    await readFile(
      path.join(root, 'official', 'publisher-package', 'skills', 'remote', 'SKILL.md'),
      'utf8'
    ),
    '---\ndescription: Remote skill\n---\n# Remote\n'
  );
  assert.deepEqual(
    await inspectSource({ rootDir: root }, 'official/publisher-package'),
    {
      schemaVersion: 1,
      sourceId: 'official/publisher-package',
      bucket: 'official',
      type: 'archive',
      installPath: 'official/publisher-package',
      origin: {
        kind: 'http',
        display: `http://127.0.0.1:${fixture.port}/publisher-package`
      },
      integrity: plan.integrity,
      skills: ['skills/remote']
    }
  );
  assert.deepEqual(
    (await scanSkills(root)).map((skill) => skill.id),
    ['official/publisher-package/skills/remote']
  );
  assert.deepEqual(await snapshotProject(project), projectBefore);
});

test('Remote Archive Source acquisition re-plans before apply', async (t) => {
  let archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Planned Archive\n' }
  ]);
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end(archive);
  });
  const root = await makeTempDir('source-http-add-stale-root-');
  const input = `http://127.0.0.1:${fixture.port}/stale-archive`;
  const plan = await planAddSource({ rootDir: root }, { input });
  archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Changed Archive\n' }
  ]);

  await assert.rejects(
    () => applyAddSource({ rootDir: root }, plan),
    (error) => error.category === 'stale-plan' &&
      /Remote Archive changed/.test(error.message)
  );
  await assert.rejects(
    () => access(path.join(root, plan.installPath)),
    /ENOENT/
  );
});

test('uses registrable-domain namespaces on collision and permits an explicit override', async (t) => {
  const qqArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# QQ package\n' }
  ]);
  const ukArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# UK package\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    const archive = request.headers.host.startsWith('app-dl.ima.qq.com')
      ? qqArchive
      : ukArchive;
    response.writeHead(200);
    response.end(archive);
  });
  const root = await makeTempDir('source-http-domain-root-');
  const httpLookup = loopbackLookup;
  const qqInput = `http://app-dl.ima.qq.com:${fixture.port}/publisher.zip`;
  const ukInput = `http://cdn.example.co.uk:${fixture.port}/publisher.zip`;

  const qqPlan = await planAddSource(
    { rootDir: root, httpLookup },
    { input: qqInput }
  );
  await applyAddSource({ rootDir: root, httpLookup }, qqPlan);

  const ukPlan = await planAddSource(
    { rootDir: root, httpLookup },
    { input: ukInput }
  );
  assert.equal(ukPlan.sourceId, 'official/example.co.uk/publisher');
  assert.equal(ukPlan.installPath, 'official/example.co.uk--publisher');
  await applyAddSource({ rootDir: root, httpLookup }, ukPlan);

  const overridePlan = await planAddSource(
    { rootDir: root, httpLookup },
    {
      input: ukInput,
      namespace: 'trusted-publisher'
    }
  );
  assert.equal(
    overridePlan.sourceId,
    'official/trusted-publisher/publisher'
  );
  assert.equal(
    overridePlan.installPath,
    'official/trusted-publisher--publisher'
  );
});

test('enforces redirect count and rejects redirects to another protocol', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Redirected\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    const match = request.url.match(/^\/(allowed|excessive)\/(\d+)$/);
    if (match) {
      const [, kind, countText] = match;
      const count = Number(countText);
      const last = kind === 'allowed' ? 5 : 6;
      if (count < last) {
        response.writeHead(302, {
          location: `/${kind}/${count + 1}`
        });
        response.end();
        return;
      }
      response.end(archive);
      return;
    }
    response.writeHead(302, {
      location: `https://127.0.0.1:${fixture.port}/cross-protocol-target`
    });
    response.end();
  });

  const allowed = await planAddSource(
    { rootDir: await makeTempDir('source-http-redirect-ok-') },
    {
      input: `http://127.0.0.1:${fixture.port}/allowed/0`,
      name: 'redirected'
    }
  );
  assert.equal(allowed.sourceId, 'official/redirected');

  await assert.rejects(
    async () => planAddSource(
      { rootDir: await makeTempDir('source-http-redirect-limit-') },
      {
        input: `http://127.0.0.1:${fixture.port}/excessive/0`,
        name: 'redirected'
      }
    ),
    /exceeded 5 redirects/
  );
  await assert.rejects(
    async () => planAddSource(
      { rootDir: await makeTempDir('source-http-redirect-protocol-') },
      {
        input: `http://127.0.0.1:${fixture.port}/cross-protocol`,
        name: 'redirected'
      }
    ),
    /changed protocol/
  );
});

test('enforces streamed download limits, truncation, and complete-download timeout', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Network limits\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    if (request.url === '/oversized') {
      response.writeHead(200, { 'content-length': archive.length + 1_000 });
      response.end(archive);
      return;
    }
    if (request.url === '/truncated') {
      response.writeHead(200, { 'content-length': archive.length + 10 });
      response.write(archive);
      response.destroy();
      return;
    }
    response.writeHead(200);
    response.write(archive.subarray(0, 4));
    setTimeout(() => response.end(archive.subarray(4)), 100);
  });

  await assert.rejects(
    async () => planAddSource(
      {
        rootDir: await makeTempDir('source-http-download-limit-'),
        httpLimits: { maxDownloadBytes: archive.length - 1 }
      },
      {
        input: `http://127.0.0.1:${fixture.port}/oversized`,
        name: 'oversized'
      }
    ),
    /download limit/
  );
  await assert.rejects(
    async () => planAddSource(
      { rootDir: await makeTempDir('source-http-truncated-') },
      {
        input: `http://127.0.0.1:${fixture.port}/truncated`,
        name: 'truncated'
      }
    ),
    /truncated|interrupted/
  );
  await assert.rejects(
    async () => planAddSource(
      {
        rootDir: await makeTempDir('source-http-timeout-'),
        httpLimits: { completeTimeoutMs: 20 }
      },
      {
        input: `http://127.0.0.1:${fixture.port}/slow`,
        name: 'slow'
      }
    ),
    /complete-download timeout/
  );
});

test('enforces connection timeout and rejects non-HTTP remote URLs', async () => {
  await assert.rejects(
    async () => planAddSource(
      {
        rootDir: await makeTempDir('source-http-connect-timeout-'),
        httpLimits: {
          connectionTimeoutMs: 20,
          completeTimeoutMs: 200
        },
        httpLookup: () => {}
      },
      {
        input: 'http://unresolved.invalid/archive',
        name: 'archive'
      }
    ),
    /connection timeout/
  );
  await assert.rejects(
    async () => planAddSource(
      { rootDir: await makeTempDir('source-http-protocol-') },
      {
        input: 'ftp://example.com/archive.zip',
        name: 'archive'
      }
    ),
    /HTTP or HTTPS/
  );
});

test('replaces a remote Archive transactionally at its stable install path', async (t) => {
  const firstArchive = buildZip([
    { name: 'skills/kept/SKILL.md', content: '# Kept v1\n' },
    { name: 'skills/old/SKILL.md', content: '# Old\n' }
  ]);
  const secondArchive = buildZip([
    { name: 'skills/kept/SKILL.md', content: '# Kept v2\n' },
    { name: 'skills/new/SKILL.md', content: '# New\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(request.url.startsWith('/v1') ? firstArchive : secondArchive);
  });
  const root = await makeTempDir('source-http-update-root-');
  const project = await makeTempDir('source-http-update-project-');
  const firstInput =
    `http://127.0.0.1:${fixture.port}/v1?signature=first#secret`;
  const secondInput =
    `http://127.0.0.1:${fixture.port}/v2?signature=second#secret`;
  const addPlan = await planAddSource(
    { rootDir: root },
    { input: firstInput, name: 'managed-archive' }
  );
  await applyAddSource({ rootDir: root }, addPlan);
  const projectSkills = path.join(project, '.agents', 'skills');
  const keptLink = path.join(projectSkills, 'kept');
  await mkdir(projectSkills, { recursive: true });
  await symlink(
    path.join(root, addPlan.installPath, 'skills', 'kept'),
    keptLink,
    'dir'
  );

  const updatePlan = await planUpdateSource(
    { rootDir: root, projectPath: project },
    {
      sourceId: addPlan.sourceId,
      input: secondInput
    }
  );
  assert.deepEqual(updatePlan.changes, {
    unchanged: ['skills/kept'],
    added: ['skills/new'],
    removedOrRelocated: ['skills/old']
  });
  assert.equal(updatePlan.installPath, addPlan.installPath);

  const result = await applyUpdateSource(
    { rootDir: root, projectPath: project },
    updatePlan
  );
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(path.join(keptLink, 'SKILL.md'), 'utf8'), '# Kept v2\n');
  const record = await inspectSource({ rootDir: root }, addPlan.sourceId);
  assert.deepEqual(record.skills, ['skills/kept', 'skills/new']);
  assert.deepEqual(record.origin, {
    kind: 'http',
    display: `http://127.0.0.1:${fixture.port}/v2`
  });
  assert.deepEqual(await transactionEntries(root), []);
});

test('requires explicit authorization before a remote update breaks a project link', async (t) => {
  const firstArchive = buildZip([
    { name: 'skills/linked/SKILL.md', content: '# Linked\n' }
  ]);
  const secondArchive = buildZip([
    { name: 'skills/replacement/SKILL.md', content: '# Replacement\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(request.url === '/first' ? firstArchive : secondArchive);
  });
  const root = await makeTempDir('source-http-breaking-root-');
  const project = await makeTempDir('source-http-breaking-project-');
  const addPlan = await planAddSource(
    { rootDir: root },
    {
      input: `http://127.0.0.1:${fixture.port}/first`,
      name: 'breaking-archive'
    }
  );
  await applyAddSource({ rootDir: root }, addPlan);
  const projectSkills = path.join(project, '.agents', 'skills');
  await mkdir(projectSkills, { recursive: true });
  await symlink(
    path.join(root, addPlan.installPath, 'skills', 'linked'),
    path.join(projectSkills, 'linked'),
    'dir'
  );
  const request = {
    sourceId: addPlan.sourceId,
    input: `http://127.0.0.1:${fixture.port}/second`
  };

  await assert.rejects(
    () => planUpdateSource({ rootDir: root, projectPath: project }, request),
    /--allow-breaking/
  );
  const plan = await planBreakingUpdateSource(
    { rootDir: root, projectPath: project },
    request
  );
  assert.deepEqual(plan.affectedProjectLinks, [
    {
      alias: 'linked',
      skillPath: 'skills/linked'
    }
  ]);
});

test('replaces a remote Archive from a local ZIP while retaining its provenance', async (t) => {
  const firstArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# Remote version\n' }
  ]);
  const localArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# Local replacement\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    response.end(firstArchive);
  });
  const root = await makeTempDir('source-http-local-update-root-');
  const localInputRoot = await makeTempDir('source-http-local-update-input-');
  const localInput = path.join(localInputRoot, 'replacement.zip');
  await writeFile(localInput, localArchive);
  const input = `http://127.0.0.1:${fixture.port}/archive?token=sensitive`;
  const addPlan = await planAddSource({ rootDir: root }, { input });
  await applyAddSource({ rootDir: root }, addPlan);

  const updatePlan = await planUpdateSource(
    { rootDir: root },
    {
      sourceId: addPlan.sourceId,
      input: localInput
    }
  );
  assert.equal(updatePlan.input.type, 'local-zip');
  await applyUpdateSource({ rootDir: root }, updatePlan);

  assert.equal(
    await readFile(
      path.join(root, addPlan.installPath, 'SKILL.md'),
      'utf8'
    ),
    '# Local replacement\n'
  );
  const record = await inspectSource({ rootDir: root }, addPlan.sourceId);
  assert.equal(record.type, 'archive');
  assert.deepEqual(record.origin, {
    kind: 'http',
    display: `http://127.0.0.1:${fixture.port}/archive`
  });
});

test('CLI output never exposes remote credentials, fragments, or signed queries', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# CLI remote\n' }
  ]);
  const fixture = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/cli-archive?signature=sensitive');
    response.end(archive);
  });
  const root = await makeTempDir('source-http-cli-root-');
  const output = captureOutput();
  const input =
    `http://user:password@127.0.0.1:${fixture.port}` +
    '/cli-archive?signature=sensitive#private';

  assert.equal(
    await runSourceCli({
      argv: ['add', input, '--yes'],
      rootDir: root,
      ...output.streams
    }),
    0
  );
  assert.match(
    output.stdout(),
    new RegExp(`input: remote-zip http://127\\.0\\.0\\.1:${fixture.port}/cli-archive`)
  );
  assert.doesNotMatch(
    `${output.stdout()}${output.stderr()}`,
    /user|password|signature|sensitive|private/
  );
});

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { port: server.address().port };
}

async function transactionEntries(root) {
  try {
    return await readdir(path.join(root, '.skillcaddy', 'staging'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function loopbackLookup(hostname, options, callback) {
  if (options.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }
  callback(null, '127.0.0.1', 4);
}

async function snapshotProject(project) {
  try {
    return await readFile(path.join(project, '.agents', 'skills'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return [];
    throw error;
  }
}

function captureOutput() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    streams: {
      stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) }
    },
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join('')
  };
}
