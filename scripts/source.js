#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import {
  applySourceMigration,
  inspectSource,
  listSources,
  planSourceMigration
} from '../lib/sourceManager.js';

export async function runSourceCli({
  argv = [],
  rootDir = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const [command, ...args] = argv;

  try {
    if (command === 'list' && args.length === 0) {
      printList(await listSources({ rootDir }), stdout);
      return 0;
    }

    if (command === 'inspect' && args.length === 1) {
      printSource(await inspectSource({ rootDir }, args[0]), stdout);
      return 0;
    }

    if (command === 'migrate' && (args.length === 0 || (args.length === 1 && args[0] === '--yes'))) {
      const plan = await planSourceMigration({ rootDir });
      printMigrationPlan(plan, stdout);
      if (args[0] === '--yes') {
        printMigrationResult(await applySourceMigration({ rootDir }, plan), stdout);
      } else {
        stdout.write('next: npm run source -- migrate --yes\n');
      }
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

function printMigrationPlan(plan, stdout) {
  const recordLabel = plan.records.length === 1 ? 'source record' : 'source records';
  stdout.write(`Migration plan: ${plan.records.length} ${recordLabel}, ${plan.unresolved.length} unresolved.\n`);
  for (const record of plan.records) {
    stdout.write(`[adopt] ${record.sourceId} -> ${record.installPath}\n`);
  }
  for (const issue of plan.unresolved) {
    stdout.write(`[unresolved] ${issue.installPath}: ${issue.reason} — ${issue.detail}\n`);
  }
}

function printMigrationResult(result, stdout) {
  if (result.written.length === 0) {
    stdout.write('Applied source migration: no source records to write.\n');
    return;
  }
  const label = result.written.length === 1 ? 'record' : 'records';
  stdout.write(`Applied source migration: ${result.written.length} ${label} written.\n`);
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
  stderr.write('Usage: npm run source -- migrate [--yes]\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await runSourceCli({
    argv: process.argv.slice(2),
    rootDir: process.env.SKILLCADDY_ROOT || process.cwd()
  });
}
