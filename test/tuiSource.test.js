import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../lib/sourceManager.js';
import { isRemoteSkillFileInput } from '../lib/sourceHttp.js';
import { isDefiniteGitSourceInput } from '../lib/sourceGitUrl.js';
import { loadTuiState } from '../lib/tuiActions.js';
import { makeTempDir } from './testHelpers.js';
import { buildZip } from './zipFixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileCallback);

test('TUI adds a remote archive, refreshes state, and keeps the project untouched', async (t) => {
  const archive = buildZip([
    {
      name: 'bundle/skills/remote/SKILL.md',
      content: '---\ndescription: Remote skill\n---\n# Remote\n'
    }
  ]);
  const server = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/publisher-package?token=secret');
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': archive.length
    });
    response.end(archive);
  });

  const root = await makeTempDir('tui-source-root-');
  const project = await makeTempDir('tui-source-project-');
  const input =
    `http://user:password@127.0.0.1:${server.address().port}` +
    '/publisher-package?token=secret#fragment';
  const result = await runTui(root, project, `12\n${input}\n\n\ny\n\nq\n`);

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Add plan: ready/);
  assert.match(result.stdout, /Outcome: added/);
  assert.match(result.stdout, /official\/publisher-package/);
  assert.match(result.stdout, /Skills: 1/);
  assert.doesNotMatch(result.stdout, /user|password|token|secret|fragment/);

  const record = await inspectSource({ rootDir: root }, 'official/publisher-package');
  assert.deepEqual(
    {
      schemaVersion: record.schemaVersion,
      sourceId: record.sourceId,
      bucket: record.bucket,
      type: record.type,
      installPath: record.installPath,
      origin: record.origin,
      skills: record.skills
    },
    {
      schemaVersion: 1,
      sourceId: 'official/publisher-package',
      bucket: 'official',
      type: 'archive',
      installPath: 'official/publisher-package',
      origin: {
        kind: 'http',
        display: `http://127.0.0.1:${server.address().port}/publisher-package`
      },
      skills: ['skills/remote']
    }
  );
  assert.equal(record.integrity.algorithm, 'sha256');
  assert.match(record.integrity.value, /^[a-f0-9]{64}$/);

  const state = await loadTuiState(root, project);
  assert.deepEqual(state.skills.map((skill) => skill.id), [
    'official/publisher-package/skills/remote'
  ]);
  assert.deepEqual(state.enabled, []);
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );

  const repeated = await runTui(root, project, `12\n${input}\n\n\n\nq\n`);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /Add plan: already-installed/);
  assert.match(repeated.stdout, /Outcome: already-installed/);
  assert.doesNotMatch(repeated.stdout, /确认添加\?/);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['official/publisher-package/skills/remote']
  );
});

test('TUI forwards explicit Archive name and namespace', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Named archive\n' }
  ]);
  const server = await startHttpFixture(t, (_request, response) => response.end(archive));
  const root = await makeTempDir('tui-source-identity-root-');
  const project = await makeTempDir('tui-source-identity-project-');
  const input = `http://127.0.0.1:${server.address().port}/download`;
  const result = await runTui(
    root,
    project,
    `12\n${input}\ncustom-package\ntrusted-team\ny\n\nq\n`
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /source: official\/trusted-team\/custom-package/);
  assert.match(result.stdout, /install: official\/trusted-team--custom-package/);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['official/trusted-team--custom-package']
  );
});

test('TUI can resolve an Archive collision with an explicit identity', async (t) => {
  const firstArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# First archive\n' }
  ]);
  const secondArchive = buildZip([
    { name: 'skill/SKILL.md', content: '# Second archive\n' }
  ]);
  const firstServer = await startHttpFixture(t, (_request, response) => response.end(firstArchive));
  const secondServer = await startHttpFixture(t, (_request, response) => response.end(secondArchive));
  const root = await makeTempDir('tui-archive-collision-root-');
  const project = await makeTempDir('tui-archive-collision-project-');
  const firstInput = `http://127.0.0.1:${firstServer.address().port}/shared-package`;
  const secondInput = `http://127.0.0.1:${secondServer.address().port}/shared-package`;

  const firstResult = await runTui(
    root,
    project,
    `12\n${firstInput}\n\n\ny\n\nq\n`
  );
  assert.equal(firstResult.code, 0, `${firstResult.stderr}\n${firstResult.stdout}`);

  const secondResult = await runTui(
    root,
    project,
    `12\n${secondInput}\nrenamed-package\ntrusted-team\ny\n\nq\n`
  );
  assert.equal(secondResult.code, 0, `${secondResult.stderr}\n${secondResult.stdout}`);
  assert.match(secondResult.stdout, /source: official\/trusted-team\/renamed-package/);
  assert.match(secondResult.stdout, /Outcome: added/);
});

test('TUI acquires an HTTPS Git source without identity prompts', async () => {
  const fixture = await createGitFixture('tui-owner', 'tui-skills');
  const root = await makeTempDir('tui-git-root-');
  const project = await makeTempDir('tui-git-project-');
  const input =
    'https://user:password@fixtures.invalid/tui-owner/tui-skills.git' +
    '?token=secret#fragment';

  const result = await withGitUrlRewrite(fixture.remoteRoot, () => runTui(
    root,
    project,
    `12\n${input}\ny\n\nq\n`
  ));

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Add plan: ready/);
  assert.match(result.stdout, /origin: git https:\/\/fixtures\.invalid\/tui-owner\/tui-skills\.git/);
  assert.match(result.stdout, /Outcome: added/);
  assert.doesNotMatch(result.stdout, /Archive 名称|Archive namespace/);
  assert.doesNotMatch(result.stdout, /user|password|token|secret|fragment/);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['github/tui-skills/skills/review']
  );
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );

  const repeated = await withGitUrlRewrite(fixture.remoteRoot, () => runTui(
    root,
    project,
    `12\n${input}\n\nq\n`
  ));
  assert.equal(repeated.code, 0, `${repeated.stderr}\n${repeated.stdout}`);
  assert.match(repeated.stdout, /Add plan: already-installed/);
  assert.match(repeated.stdout, /Outcome: already-installed/);
  assert.doesNotMatch(repeated.stdout, /确认添加\?/);
});

test('TUI accepts SSH and SCP-style Git addresses', async () => {
  const fixture = await createGitFixture('tui-git-owner', 'tui-git-shapes');

  for (const [label, input] of [
    ['ssh', 'ssh://git@fixtures.invalid/tui-git-owner/tui-git-shapes.git'],
    ['scp', 'git@fixtures.invalid:tui-git-owner/tui-git-shapes.git']
  ]) {
    const root = await makeTempDir(`tui-git-${label}-root-`);
    const project = await makeTempDir(`tui-git-${label}-project-`);
    const result = await withGitUrlRewrite(fixture.remoteRoot, () => runTui(
      root,
      project,
      `12\n${input}\ny\n\nq\n`
    ));

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Outcome: added/);
    assert.doesNotMatch(result.stdout, /Archive 名称|Archive namespace/);
    assert.deepEqual(
      (await loadTuiState(root, project)).skills.map((skill) => skill.id),
      ['github/tui-git-shapes/skills/review']
    );
  }
});

test('TUI cancellation does not apply a Git source', async () => {
  const fixture = await createGitFixture('cancel-owner', 'cancel-skills');
  const root = await makeTempDir('tui-git-cancel-root-');
  const project = await makeTempDir('tui-git-cancel-project-');
  const input = 'https://fixtures.invalid/cancel-owner/cancel-skills.git';
  const result = await withGitUrlRewrite(fixture.remoteRoot, () => runTui(
    root,
    project,
    `12\n${input}\nn\n\nq\n`
  ));

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /已取消添加/);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'github/cancel-skills'),
    /Source is not registered/
  );
});

test('TUI reports an invalid Git address without mutation', async () => {
  const root = await makeTempDir('tui-git-error-root-');
  const project = await makeTempDir('tui-git-error-project-');
  const input = 'ssh://fixtures.invalid/only-owner';
  const result = await runTui(
    root,
    project,
    `12\n${input}\n\nq\n`
  );

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /错误 \[unresolved-identity\]：/);
  assert.doesNotMatch(result.stdout, /确认添加\?/);
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

test('TUI preserves GitHub tree focus while acquiring the complete repository', async () => {
  const fixture = await createGitFixture('tree-owner', 'tree-skills');
  const root = await makeTempDir('tui-git-tree-root-');
  const project = await makeTempDir('tui-git-tree-project-');
  const input = 'https://github.com/tree-owner/tree-skills/tree/main/skills/review';

  const result = await withGitUrlRewrite(fixture.remoteRoot, () => runTui(
    root,
    project,
    `12\n${input}\ny\n\nq\n`
  ));

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /focus: main skills\/review/);
  assert.match(result.stdout, /Outcome: added/);
  assert.deepEqual(
    (await inspectSource({ rootDir: root }, 'github/tree-owner/tree-skills')).focus,
    { ref: 'main', path: 'skills/review' }
  );
});

test('TUI acquires a stable Remote file without a namespace prompt', async (t) => {
  const content = '---\ndescription: Remote file\n---\n# Remote file\n';
  const server = await startHttpFixture(t, (request, response) => {
    assert.equal(request.url, '/SKILL.md');
    response.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': Buffer.byteLength(content)
    });
    response.end(content);
  });
  const root = await makeTempDir('tui-remote-file-root-');
  const project = await makeTempDir('tui-remote-file-project-');
  const input = `http://127.0.0.1:${server.address().port}/SKILL.md#fragment`;
  const result = await runTui(
    root,
    project,
    `12\n${input}\nherdr\ny\n\nq\n`
  );

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /input: remote-file http:\/\/127\.0\.0\.1:[0-9]+\/SKILL\.md/);
  assert.match(result.stdout, /origin: http http:\/\/127\.0\.0\.1:[0-9]+\/SKILL\.md/);
  assert.match(result.stdout, /integrity: sha256 [a-f0-9]{64}/);
  assert.match(result.stdout, /Outcome: added/);
  assert.doesNotMatch(result.stdout, /Archive 名称|Archive namespace|fragment/);
  const record = await inspectSource({ rootDir: root }, 'official/herdr');
  assert.equal(record.type, 'remote-file');
  assert.equal(record.origin.display, `http://127.0.0.1:${server.address().port}/SKILL.md`);
  assert.deepEqual(
    (await loadTuiState(root, project)).skills.map((skill) => skill.id),
    ['official/herdr']
  );
  await assert.rejects(
    () => access(path.join(project, '.agents', 'skills')),
    /ENOENT/
  );

  const repeated = await runTui(
    root,
    project,
    `12\n${input}\nherdr\n\nq\n`
  );
  assert.equal(repeated.code, 0, `${repeated.stderr}\n${repeated.stdout}`);
  assert.match(repeated.stdout, /Add plan: already-installed/);
  assert.match(repeated.stdout, /Outcome: already-installed/);
  assert.doesNotMatch(repeated.stdout, /确认添加\?/);
});

test('TUI rejects a blank Remote file name before acquisition', async () => {
  const root = await makeTempDir('tui-remote-file-name-root-');
  const project = await makeTempDir('tui-remote-file-name-project-');
  const result = await runTui(
    root,
    project,
    '12\nhttps://example.test/SKILL.md\n\n\nq\n'
  );

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /错误 \[unresolved-identity\]：/);
  assert.match(result.stdout, /Remote file source requires an explicit non-empty name/);
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

test('TUI cancellation does not apply a Remote file source', async (t) => {
  const content = '# Cancelled Remote file\n';
  const server = await startHttpFixture(t, (_request, response) => response.end(content));
  const root = await makeTempDir('tui-remote-file-cancel-root-');
  const project = await makeTempDir('tui-remote-file-cancel-project-');
  const input = `http://127.0.0.1:${server.address().port}/SKILL.md`;
  const result = await runTui(
    root,
    project,
    `12\n${input}\ncancelled\nn\n\nq\n`
  );

  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /已取消添加/);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/cancelled'),
    /Source is not registered/
  );
});

test('TUI refuses a Remote file identity collision without replacing the source', async (t) => {
  const firstContent = '---\ndescription: First\n---\n# First\n';
  const secondContent = '---\ndescription: Second\n---\n# Second\n';
  const server = await startHttpFixture(t, (request, response) => {
    const content = request.url === '/first/SKILL.md' ? firstContent : secondContent;
    response.end(content);
  });
  const root = await makeTempDir('tui-remote-file-collision-root-');
  const project = await makeTempDir('tui-remote-file-collision-project-');
  const firstInput = `http://127.0.0.1:${server.address().port}/first/SKILL.md`;
  const secondInput = `http://127.0.0.1:${server.address().port}/second/SKILL.md`;

  const firstResult = await runTui(
    root,
    project,
    `12\n${firstInput}\nherdr\ny\n\nq\n`
  );
  assert.equal(firstResult.code, 0, `${firstResult.stderr}\n${firstResult.stdout}`);

  const secondResult = await runTui(
    root,
    project,
    `12\n${secondInput}\nherdr\n\nq\n`
  );
  assert.equal(secondResult.code, 0, `${secondResult.stderr}\n${secondResult.stdout}`);
  assert.match(secondResult.stdout, /错误 \[source-collision\]：/);
  assert.doesNotMatch(secondResult.stdout, /Outcome: added/);
  assert.equal(
    await readFile(path.join(root, 'official', 'herdr', 'SKILL.md'), 'utf8'),
    firstContent
  );
});

test('TUI cancellation does not apply a remote archive', async (t) => {
  const archive = buildZip([
    { name: 'skill/SKILL.md', content: '# Cancelled\n' }
  ]);
  const server = await startHttpFixture(t, (_request, response) => response.end(archive));

  const root = await makeTempDir('tui-source-cancel-root-');
  const project = await makeTempDir('tui-source-cancel-project-');
  const input = `http://127.0.0.1:${server.address().port}/cancelled-package`;
  const result = await runTui(root, project, `12\n${input}\n\n\nn\n\nq\n`);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已取消添加/);
  await assert.rejects(
    () => inspectSource({ rootDir: root }, 'official/cancelled-package'),
    /Source is not registered/
  );
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

test('TUI rejects unsupported source addresses without mutation', async () => {
  for (const input of [
    'ftp://example.test/skills/package.zip',
    'not-a-source-address'
  ]) {
    const root = await makeTempDir('tui-source-unsupported-root-');
    const project = await makeTempDir('tui-source-unsupported-project-');
    const result = await runTui(root, project, `12\n${input}\n\nq\n`);

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /当前 TUI 仅支持 HTTPS\/SSH\/SCP Git、公共 HTTP\(S\) Archive 和直接 \/SKILL\.md Remote file；Web source acquisition 暂不支持/
    );
    assert.deepEqual((await loadTuiState(root, project)).skills, []);
  }
});

test('TUI returns from the initial archive prompt without mutation', async () => {
  for (const address of ['', 'b']) {
    const root = await makeTempDir('tui-source-back-root-');
    const project = await makeTempDir('tui-source-back-project-');
    const result = await runTui(root, project, `12\n${address}\n\nq\n`);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Add plan:|Outcome: added/);
    assert.deepEqual((await loadTuiState(root, project)).skills, []);
  }
});

test('TUI reports remote archive validation failures with their stable category', async (t) => {
  const server = await startHttpFixture(t, (_request, response) => response.end('not a zip'));

  const root = await makeTempDir('tui-source-error-root-');
  const project = await makeTempDir('tui-source-error-project-');
  const input = `http://127.0.0.1:${server.address().port}/broken-package`;
  const result = await runTui(root, project, `12\n${input}\n\nq\n`);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /错误 \[invalid-input\]：/);
  assert.match(result.stdout, /Local file does not have a ZIP signature/);
  assert.deepEqual((await loadTuiState(root, project)).skills, []);
});

function runTui(root, project, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/tui.js', '--root', root, project],
      { cwd: repoRoot }
    );
    const stdout = [];
    const stderr = [];
    let output = '';
    let outputOffset = 0;
    let settled = false;
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const lines = input.split('\n');
    while (lines.at(-1) === '') lines.pop();
    let index = 0;

    const takeLine = () => {
      if (index >= lines.length) {
        throw new Error(`TUI fixture ran out of input at line ${index}`);
      }
      return lines[index++];
    };

    const sendLine = (line) => child.stdin.write(`${line}\n`);

    const waitForAny = (patterns) => new Promise((resolvePrompt, rejectPrompt) => {
      const check = () => {
        let best;
        for (const pattern of patterns) {
          const match = pattern.regex.exec(output.slice(outputOffset));
          if (!match) continue;
          const end = outputOffset + match.index + match[0].length;
          if (!best || end < best.end) best = { kind: pattern.kind, end };
        }
        if (!best) return;
        child.stdout.off('data', check);
        child.off('close', onClose);
        outputOffset = best.end;
        resolvePrompt(best.kind);
      };
      const onClose = () => {
        child.stdout.off('data', check);
        rejectPrompt(new Error(`TUI closed while waiting for ${patterns.map(({ kind }) => kind).join(', ')}`));
      };
      child.stdout.on('data', check);
      child.once('close', onClose);
      check();
    });

    const waitFor = (kind, regex) => waitForAny([{ kind, regex }]);
    const sendAfter = async (patterns) => {
      await waitForAny(patterns);
      sendLine(takeLine());
    };

    const continueAndQuit = async () => {
      await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
      await sendAfter([{ kind: 'menu', regex: /选择操作: /u }]);
      child.stdin.end();
    };

    const drive = async () => {
      await sendAfter([{ kind: 'menu', regex: /选择操作: /u }]);
      const choice = lines[0];
      if (choice !== '12') throw new Error(`Unexpected TUI fixture choice: ${choice}`);

      await waitFor('address', /远程 Source 地址（留空或 b 返回）: /u);
      const address = takeLine();
      sendLine(address);

      if (!address || address.toLowerCase() === 'b') {
        await continueAndQuit();
        return;
      }

      if (isRemoteSkillFileInput(address)) {
        await sendAfter([{ kind: 'remote-name', regex: /Remote file name（必填，b 返回）: /u }]);
        const result = await waitForAny([
          { kind: 'confirm', regex: /确认添加\? y\/N: /u },
          { kind: 'error', regex: /错误(?: \[[^\n]+\])?：/u },
          { kind: 'continue', regex: /回车继续: /u }
        ]);
        if (result === 'confirm') {
          sendLine(takeLine());
          await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
        } else if (result === 'error') {
          await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
        } else {
          sendLine(takeLine());
        }
        await sendAfter([{ kind: 'menu', regex: /选择操作: /u }]);
        child.stdin.end();
        return;
      }

      if (!isDefiniteGitSourceInput(address) && !/^https?:\/\//iu.test(address)) {
        await continueAndQuit();
        return;
      }

      if (isDefiniteGitSourceInput(address)) {
        const result = await waitForAny([
          { kind: 'confirm', regex: /确认添加\? y\/N: /u },
          { kind: 'error', regex: /错误(?: \[[^\n]+\])?：/u },
          { kind: 'continue', regex: /回车继续: /u }
        ]);
        if (result === 'confirm') {
          sendLine(takeLine());
          await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
        } else if (result === 'error') {
          await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
        } else {
          sendLine(takeLine());
        }
        await sendAfter([{ kind: 'menu', regex: /选择操作: /u }]);
        child.stdin.end();
        return;
      }

      const initialResult = await waitForAny([
        { kind: 'archive-name', regex: /Archive 名称（留空自动推断，b 返回）: /u },
        { kind: 'error', regex: /错误(?: \[[^\n]+\])?：/u },
        { kind: 'continue', regex: /回车继续: /u }
      ]);
      if (initialResult === 'error') {
        await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
      } else if (initialResult === 'continue') {
        sendLine(takeLine());
      } else {
        const name = takeLine();
        sendLine(name);
        if (name.toLowerCase() === 'b') {
          await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
        } else {
          const namespaceResult = await waitForAny([
            { kind: 'namespace', regex: /Archive namespace（留空自动推断，b 返回）: /u },
            { kind: 'error', regex: /错误(?: \[[^\n]+\])?：/u },
            { kind: 'continue', regex: /回车继续: /u }
          ]);
          if (namespaceResult === 'namespace') {
            const namespace = takeLine();
            sendLine(namespace);
            if (namespace.toLowerCase() === 'b') {
              await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
            } else {
              await finishPlannedSource();
            }
          } else if (namespaceResult === 'error') {
            await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
          } else {
            sendLine(takeLine());
          }
        }
      }
      await sendAfter([{ kind: 'menu', regex: /选择操作: /u }]);
      child.stdin.end();
    };

    const finishPlannedSource = async () => {
      const result = await waitForAny([
        { kind: 'confirm', regex: /确认添加\? y\/N: /u },
        { kind: 'error', regex: /错误(?: \[[^\n]+\])?：/u },
        { kind: 'continue', regex: /回车继续: /u }
      ]);
      if (result === 'confirm') {
        sendLine(takeLine());
        await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
      } else if (result === 'error') {
        await sendAfter([{ kind: 'continue', regex: /回车继续: /u }]);
      } else {
        sendLine(takeLine());
      }
    };

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join('')
      });
    });

    drive().catch((error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    });
  });
}

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server;
}

async function createGitFixture(owner, repository) {
  const fixtureRoot = await makeTempDir('tui-git-fixture-');
  const remoteRoot = path.join(fixtureRoot, 'remotes');
  const worktree = path.join(fixtureRoot, 'worktree');
  const remote = path.join(remoteRoot, owner, `${repository}.git`);

  await mkdir(path.join(worktree, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'complete repository\n');
  await writeFile(
    path.join(worktree, 'skills', 'review', 'SKILL.md'),
    '---\ndescription: Review code\n---\n# Review\n'
  );
  await execFile('git', ['init', '--initial-branch=main', worktree]);
  await execFile('git', ['-C', worktree, 'add', '.']);
  await execFile('git', [
    '-C',
    worktree,
    '-c',
    'user.name=Skillcaddy Tests',
    '-c',
    'user.email=tests@skillcaddy.invalid',
    'commit',
    '-m',
    'initial'
  ]);
  const { stdout: commit } = await execFile('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  await mkdir(path.dirname(remote), { recursive: true });
  await execFile('git', ['clone', '--bare', worktree, remote]);
  await execFile('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  return { remoteRoot, commit: commit.trim() };
}

async function withGitUrlRewrite(remoteRoot, callback) {
  const configRoot = await makeTempDir('tui-git-config-');
  const configPath = path.join(configRoot, 'gitconfig');
  const fileBase = pathToFileURL(`${remoteRoot}${path.sep}`).toString();
  await writeFile(configPath, [
    `[url "${fileBase}"]`,
    '\tinsteadOf = https://fixtures.invalid/',
    '\tinsteadOf = ssh://git@fixtures.invalid/',
    '\tinsteadOf = ssh://fixtures.invalid/',
    '\tinsteadOf = git@fixtures.invalid:',
    '\tinsteadOf = https://github.com/',
    ''
  ].join('\n'));

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return await callback();
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousSystem;
  }
}
