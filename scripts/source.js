#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { inspectSource, listSources } from '../lib/sourceManager.js';

export async function runSourceCli({
  argv = [],
  rootDir = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const [command, sourceId, ...rest] = argv;

  try {
    if (command === 'list' && sourceId === undefined) {
      printList(await listSources({ rootDir }), stdout);
      return 0;
    }

    if (command === 'inspect' && sourceId && rest.length === 0) {
      printSource(await inspectSource({ rootDir }, sourceId), stdout);
      return 0;
    }

    printUsage(stderr);
    return 2;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function printList(result, stdout) {
  if (result.sources.length === 0) {
    stdout.write('No registered or unmanaged sources found.\n');
    return;
  }

  for (const source of result.sources) {
    stdout.write(`[${source.status}] ${source.inventoryId}\n`);
    stdout.write(`  install: ${source.installPath}${source.exists ? '' : ' (missing)'}\n`);
  }
}

function printSource(source, stdout) {
  stdout.write(`source: ${source.sourceId}\n`);
  stdout.write(`type: ${source.type}\n`);
  stdout.write(`install: ${source.installPath}\n`);
  stdout.write(`origin: ${formatOrigin(source.origin)}\n`);
  if (source.integrity) {
    stdout.write(`integrity: ${source.integrity.algorithm} ${source.integrity.value}\n`);
  } else {
    stdout.write('integrity: unavailable\n');
  }
  stdout.write('skills:\n');
  for (const skillPath of source.skills) stdout.write(`  - ${skillPath}\n`);
}

function formatOrigin(origin) {
  if (origin.kind === 'git') {
    const ref = origin.ref ? ` ${origin.ref}` : '';
    const commit = origin.commit ? ` @ ${origin.commit}` : '';
    return `git ${origin.remote}${ref}${commit}`;
  }
  if (origin.kind === 'http' || origin.kind === 'https') return `${origin.kind} ${origin.display}`;
  if (origin.kind === 'local') return `local ${origin.name}`;
  return 'unknown';
}

function printUsage(stderr) {
  stderr.write('Usage: npm run source -- list\n');
  stderr.write('Usage: npm run source -- inspect <source-id>\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await runSourceCli({
    argv: process.argv.slice(2),
    rootDir: process.env.SKILLCADDY_ROOT || process.cwd()
  });
}
