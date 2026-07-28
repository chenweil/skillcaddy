import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAddSource,
  applyUpdateSource,
  inspectSource,
  planAddSource,
  planUpdateSource
} from '../lib/sourceManager.js';
import { runSourceCli } from '../scripts/source.js';
import { makeTempDir } from './testHelpers.js';

test('acquires one remote SKILL.md as a registered official source', async (t) => {
  const content = '---\ndescription: Herd management\n---\n# Herdr\n';
  const fixture = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/SKILL.md');
    response.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': Buffer.byteLength(content)
    });
    response.end(content);
  });
  const root = await makeTempDir('source-remote-file-root-');
  const input = `http://127.0.0.1:${fixture.port}/SKILL.md`;

  const plan = await planAddSource(
    { rootDir: root },
    { input, name: 'herdr' }
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
      sourceId: 'official/herdr',
      installPath: 'official/herdr',
      input: {
        type: 'remote-file',
        display: input
      },
      origin: {
        kind: 'http',
        display: input
      },
      skills: ['.']
    }
  );

  const result = await applyAddSource({ rootDir: root }, plan);
  assert.equal(result.status, 'added');
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    content
  );

  const record = await inspectSource({ rootDir: root }, 'official/herdr');
  assert.equal(record.type, 'remote-file');
  assert.match(record.integrity.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.skills, ['.']);
});

test('updates a registered remote file from its stored origin', async (t) => {
  let content = '---\ndescription: Version one\n---\n# One\n';
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': Buffer.byteLength(content)
    });
    response.end(content);
  });
  const root = await makeTempDir('source-remote-file-update-root-');
  const input = `http://127.0.0.1:${fixture.port}/SKILL.md`;
  const addPlan = await planAddSource(
    { rootDir: root },
    { input, name: 'herdr' }
  );
  await applyAddSource({ rootDir: root }, addPlan);
  content = '---\ndescription: Version two\n---\n# Two\n';

  const updatePlan = await planUpdateSource(
    { rootDir: root },
    { sourceId: 'official/herdr' }
  );

  assert.deepEqual(
    {
      status: updatePlan.status,
      sourceId: updatePlan.sourceId,
      installPath: updatePlan.installPath,
      input: updatePlan.input,
      origin: updatePlan.origin,
      skills: updatePlan.skills,
      changes: updatePlan.changes
    },
    {
      status: 'ready',
      sourceId: 'official/herdr',
      installPath: 'official/herdr',
      input: {
        type: 'remote-file',
        display: input
      },
      origin: {
        kind: 'http',
        display: input
      },
      skills: ['.'],
      changes: {
        unchanged: ['.'],
        added: [],
        removedOrRelocated: []
      }
    }
  );

  const result = await applyUpdateSource({ rootDir: root }, updatePlan);
  assert.equal(result.status, 'updated');
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    content
  );
  const record = await inspectSource({ rootDir: root }, 'official/herdr');
  assert.equal(record.origin.display, input);
  assert.equal(record.integrity.value, updatePlan.integrity.value);
});

test('requires a stable direct SKILL.md URL and explicit source name', async (t) => {
  const root = await makeTempDir('source-remote-file-url-root-');
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end('# Skill\n');
  });
  const cases = [
    {
      request: { input: 'https://example.com/SKILL.md' },
      message: /explicit.*name/i
    },
    {
      request: {
        input: 'https://user:password@example.com/SKILL.md',
        name: 'unsafe'
      },
      message: /credentials/i
    },
    {
      request: {
        input: 'https://example.com/SKILL.md?token=secret',
        name: 'unsafe'
      },
      message: /query/i
    },
    {
      request: {
        input: 'https://github.com/owner/repo/blob/main/SKILL.md',
        name: 'unsafe'
      },
      message: /direct.*SKILL\.md.*URL/i
    },
    {
      request: {
        input: `http://127.0.0.1:${fixture.port}/SKILL.md`,
        name: 'team/herdr'
      },
      message: /single.*segment/i
    }
  ];

  for (const scenario of cases) {
    await assert.rejects(
      () => planAddSource({ rootDir: root }, scenario.request),
      scenario.message
    );
  }
});

test('rejects a redirect that stops being a direct stable SKILL.md URL', async (t) => {
  const content = '---\ndescription: Redirected\n---\n# Redirected\n';
  const fixture = await startHttpFixture(t, (request, response) => {
    if (request.url === '/SKILL.md') {
      response.writeHead(302, { location: '/download?token=secret' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-length': Buffer.byteLength(content) });
    response.end(content);
  });
  const root = await makeTempDir('source-remote-file-redirect-root-');

  await assert.rejects(
    () => planAddSource(
      { rootDir: root },
      {
        input: `http://127.0.0.1:${fixture.port}/SKILL.md`,
        name: 'redirected'
      }
    ),
    /query|SKILL\.md/i
  );
});

test('rejects invalid remote SKILL.md bytes and the one MiB limit', async (t) => {
  let content = Buffer.from([0xff, 0xfe]);
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': content.length });
    response.end(content);
  });
  const input = `http://127.0.0.1:${fixture.port}/SKILL.md`;

  for (const invalid of [
    { name: 'invalid-utf8', content: Buffer.from([0xff, 0xfe]), message: /UTF-8/i },
    { name: 'nul-byte', content: Buffer.from('# Bad\0Skill\n'), message: /NUL/i },
    { name: 'empty', content: Buffer.alloc(0), message: /empty/i },
    {
      name: 'oversized',
      content: Buffer.alloc(1024 * 1024 + 1, 0x61),
      message: /Remote SKILL\.md exceeds the 1048576-byte download limit/i
    }
  ]) {
    content = invalid.content;
    const root = await makeTempDir(`source-remote-file-${invalid.name}-`);
    await assert.rejects(
      () => planAddSource(
        { rootDir: root },
        { input, name: invalid.name }
      ),
      invalid.message
    );
  }
});

test('migrates a registered remote file origin only through update', async (t) => {
  const firstContent = '---\ndescription: First origin\n---\n# First\n';
  const secondContent = '---\ndescription: Second origin\n---\n# Second\n';
  const first = await startHttpFixture(t, (_request, response) => {
    response.end(firstContent);
  });
  const second = await startHttpFixture(t, (_request, response) => {
    response.end(secondContent);
  });
  const root = await makeTempDir('source-remote-file-origin-root-');
  const firstInput = `http://127.0.0.1:${first.port}/SKILL.md`;
  const secondInput = `http://127.0.0.1:${second.port}/SKILL.md`;
  const addPlan = await planAddSource(
    { rootDir: root },
    { input: firstInput, name: 'herdr' }
  );
  await applyAddSource({ rootDir: root }, addPlan);

  await assert.rejects(
    () => planAddSource(
      { rootDir: root },
      { input: secondInput, name: 'herdr' }
    ),
    (error) => error.category === 'source-collision'
  );

  const updatePlan = await planUpdateSource(
    { rootDir: root },
    { sourceId: 'official/herdr', input: secondInput }
  );
  await applyUpdateSource({ rootDir: root }, updatePlan);

  const record = await inspectSource({ rootDir: root }, 'official/herdr');
  assert.equal(record.origin.display, secondInput);
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    secondContent
  );
});

test('preserves installed content and registry when an update plan becomes stale', async (t) => {
  let content = '---\ndescription: Installed\n---\n# Installed\n';
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end(content);
  });
  const root = await makeTempDir('source-remote-file-stale-root-');
  const input = `http://127.0.0.1:${fixture.port}/SKILL.md`;
  const addPlan = await planAddSource(
    { rootDir: root },
    { input, name: 'herdr' }
  );
  await applyAddSource({ rootDir: root }, addPlan);
  const installedRecord = await inspectSource({ rootDir: root }, 'official/herdr');

  content = '---\ndescription: Planned\n---\n# Planned\n';
  const updatePlan = await planUpdateSource(
    { rootDir: root },
    { sourceId: 'official/herdr' }
  );
  content = '---\ndescription: Changed again\n---\n# Changed\n';

  await assert.rejects(
    () => applyUpdateSource({ rootDir: root }, updatePlan),
    (error) => error.category === 'stale-plan'
  );
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    '---\ndescription: Installed\n---\n# Installed\n'
  );
  assert.deepEqual(
    await inspectSource({ rootDir: root }, 'official/herdr'),
    installedRecord
  );
});

test('rejects an unstable remote-file origin stored in the registry', async () => {
  const root = await makeTempDir('source-remote-file-record-root-');
  await mkdir(path.join(root, 'official', 'unsafe'), { recursive: true });
  await writeFile(path.join(root, 'official', 'unsafe', 'SKILL.md'), '# Unsafe\n');
  await mkdir(path.join(root, '.skillcaddy', 'sources', 'official'), {
    recursive: true
  });
  await writeFile(
    path.join(root, '.skillcaddy', 'sources', 'official', 'unsafe.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceId: 'official/unsafe',
      bucket: 'official',
      type: 'remote-file',
      installPath: 'official/unsafe',
      origin: {
        kind: 'https',
        display: 'https://example.com/SKILL.md?token=secret'
      },
      integrity: {
        algorithm: 'sha256',
        value: 'a'.repeat(64)
      },
      skills: ['.']
    })}\n`
  );

  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/unsafe'),
    /stable|query/i
  );
});

test('rejects a fragment in a remote-file origin stored in the registry', async () => {
  const root = await makeTempDir('source-remote-file-fragment-record-root-');
  await mkdir(path.join(root, 'official', 'unsafe'), { recursive: true });
  await writeFile(path.join(root, 'official', 'unsafe', 'SKILL.md'), '# Unsafe\n');
  await mkdir(path.join(root, '.skillcaddy', 'sources', 'official'), {
    recursive: true
  });
  await writeFile(
    path.join(root, '.skillcaddy', 'sources', 'official', 'unsafe.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceId: 'official/unsafe',
      bucket: 'official',
      type: 'remote-file',
      installPath: 'official/unsafe',
      origin: {
        kind: 'https',
        display: 'https://example.com/SKILL.md#temporary'
      },
      integrity: {
        algorithm: 'sha256',
        value: 'a'.repeat(64)
      },
      skills: ['.']
    })}\n`
  );

  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/unsafe'),
    /stable|fragment/i
  );
});

test('requires integrity and the root skill in remote-file registry records', async () => {
  const root = await makeTempDir('source-remote-file-record-shape-root-');
  await mkdir(path.join(root, 'official', 'unsafe'), { recursive: true });
  await writeFile(path.join(root, 'official', 'unsafe', 'SKILL.md'), '# Unsafe\n');
  await mkdir(path.join(root, '.skillcaddy', 'sources', 'official'), {
    recursive: true
  });
  const recordPath = path.join(
    root,
    '.skillcaddy',
    'sources',
    'official',
    'unsafe.json'
  );
  const baseRecord = {
    schemaVersion: 1,
    sourceId: 'official/unsafe',
    bucket: 'official',
    type: 'remote-file',
    installPath: 'official/unsafe',
    origin: {
      kind: 'https',
      display: 'https://example.com/SKILL.md'
    },
    skills: ['.']
  };
  await writeFile(recordPath, `${JSON.stringify(baseRecord)}\n`);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/unsafe'),
    /integrity/i
  );

  await writeFile(recordPath, `${JSON.stringify({
    ...baseRecord,
    integrity: { algorithm: 'sha256', value: 'a'.repeat(64) },
    skills: ['nested']
  })}\n`);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/unsafe'),
    /root skill/i
  );

  await writeFile(recordPath, `${JSON.stringify({
    ...baseRecord,
    integrity: { algorithm: 'sha256', value: 'a'.repeat(64) },
    installPath: 'official/different'
  })}\n`);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/unsafe'),
    /install path|source identity/i
  );
});

test('CLI adds and updates a named remote file source', async (t) => {
  let content = '---\ndescription: CLI one\n---\n# One\n';
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.end(content);
  });
  const root = await makeTempDir('source-remote-file-cli-root-');
  const input = `http://127.0.0.1:${fixture.port}/SKILL.md`;
  const addOutput = captureOutput();

  assert.equal(
    await runSourceCli({
      argv: ['add', input, '--name', 'herdr', '--yes'],
      rootDir: root,
      ...addOutput.streams
    }),
    0
  );
  assert.match(addOutput.stdout(), /input: remote-file /);
  assert.match(addOutput.stdout(), /Outcome: added/);

  content = '---\ndescription: CLI two\n---\n# Two\n';
  const updateOutput = captureOutput();
  assert.equal(
    await runSourceCli({
      argv: ['update', 'official/herdr', '--yes'],
      rootDir: root,
      ...updateOutput.streams
    }),
    0
  );
  assert.match(updateOutput.stdout(), /input: remote-file /);
  assert.match(updateOutput.stdout(), /Outcome: updated/);
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    content
  );
});

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { port: server.address().port };
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
