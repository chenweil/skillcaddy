#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import {
  applyAddSource,
  applyRepairSource,
  applySourceMigration,
  applyUpdateSource,
  inspectSource,
  listSources,
  planAddSource,
  planBreakingRepairSource,
  planBreakingUpdateSource,
  planRepairSource,
  planSourceMigration,
  planUpdateSource,
  updateGitSources
} from '../lib/sourceManager.js';

export async function runSourceCli({
  argv = [],
  rootDir = process.cwd(),
  projectPath = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  confirm
} = {}) {
  const [command, ...args] = argv;
  const projectOption = parseProjectOption(args);

  try {
    if (projectOption.error) {
      stderr.write(`Error: ${projectOption.error}\n`);
      printUsage(stderr);
      return 2;
    }

    if (projectOption.specified && !['repair', 'update', 'update-git'].includes(command)) {
      stderr.write('Error: --project is supported only by repair, update, and update-git\n');
      printUsage(stderr);
      return 2;
    }

    const commandArgs = projectOption.args;
    const effectiveProjectPath = path.resolve(projectOption.projectPath || projectPath);

    if (command === 'list' && commandArgs.length === 0) {
      printList(await listSources({ rootDir }), stdout);
      return 0;
    }

    if (command === 'update') {
      const parsed = parseUpdateArgs(commandArgs);
      if (!parsed) {
        printUsage(stderr);
        return 2;
      }
      const context = { rootDir, projectPath: effectiveProjectPath };
      const planUpdate = parsed.allowBreaking
        ? planBreakingUpdateSource
        : planUpdateSource;
      const plan = await planUpdate(context, parsed.request);
      printUpdatePlan(plan, stdout);
      if (
        plan.status === 'ready' &&
        !parsed.yes &&
        !await requestConfirmation(
          { confirm, stdin, stdout },
          plan,
          'Apply this update plan? [y/N] '
        )
      ) {
        stdout.write('Outcome: cancelled\n');
        return 0;
      }
      printUpdateResult(await applyUpdateSource(context, plan), stdout);
      return 0;
    }

    if (command === 'update-git') {
      const parsed = parseGitUpdateArgs(commandArgs);
      if (!parsed) {
        printUsage(stderr);
        return 2;
      }
      const result = await updateGitSources({ rootDir, projectPath: effectiveProjectPath });
      printGitUpdateBatch(result, stdout, parsed);
      return result.sources.some(
        (source) => source.status === 'failed' ||
          source.status === 'breaking' && source.applied === false
      ) ? 1 : 0;
    }

    if (command === 'repair') {
      const parsed = parseRepairArgs(commandArgs);
      if (!parsed) {
        printUsage(stderr);
        return 2;
      }
      const context = { rootDir, projectPath: effectiveProjectPath };
      const planRepair = parsed.allowBreaking
        ? planBreakingRepairSource
        : planRepairSource;
      const plan = await planRepair(context, parsed.request);
      printRepairPlan(plan, stdout);
      if (
        plan.status === 'ready' &&
        !parsed.yes &&
        !await requestConfirmation(
          { confirm, stdin, stdout },
          plan,
          'Adopt this Git registry state? [y/N] '
        )
      ) {
        stdout.write('Outcome: cancelled\n');
        return 0;
      }
      printRepairResult(await applyRepairSource(context, plan), stdout);
      return 0;
    }

    if (command === 'inspect' && args.length === 1) {
      printSource(await inspectSource({ rootDir }, args[0]), stdout);
      return 0;
    }

    if (command === 'add') {
      const parsed = parseAddArgs(args);
      if (!parsed) {
        printUsage(stderr);
        return 2;
      }
      const plan = await planAddSource({ rootDir }, parsed.request);
      printAddPlan(plan, stdout);
      if (
        plan.status === 'ready' &&
        !parsed.yes &&
        !await requestConfirmation(
          { confirm, stdin, stdout },
          plan,
          'Apply this add plan? [y/N] '
        )
      ) {
        stdout.write('Outcome: cancelled\n');
        return 0;
      }
      printAddResult(await applyAddSource({ rootDir }, plan), stdout);
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
      return plan.unresolved.length > 0 ? 3 : 0;
    }

    printUsage(stderr);
    return 2;
  } catch (error) {
    stderr.write(`Outcome: ${error.category || 'failure'}\n`);
    stderr.write(`${error.message}\n`);
    return error.exitCode || 1;
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

function printAddPlan(plan, stdout) {
  stdout.write(`Add plan: ${plan.status}\n`);
  stdout.write(`source: ${plan.sourceId}\n`);
  stdout.write(`install: ${plan.installPath}\n`);
  stdout.write(
    `input: ${plan.input.type} ${
      plan.input.name || plan.input.remote || plan.input.display
    }\n`
  );
  if (plan.origin?.kind === 'git') {
    stdout.write(`origin: ${formatOrigin(plan.origin)}\n`);
    if (plan.focus) {
      stdout.write(`focus: ${plan.focus.ref}${plan.focus.path ? ` ${plan.focus.path}` : ''}\n`);
    }
  } else {
    stdout.write(`integrity: ${plan.integrity.algorithm} ${plan.integrity.value}\n`);
  }
  stdout.write(`skills (${plan.skills.length}):\n`);
  for (const skillPath of plan.skills) stdout.write(`  - ${skillPath}\n`);
  stdout.write(`warnings (${plan.warnings.length}):\n`);
  for (const warning of plan.warnings) {
    stdout.write(`  - [${warning.category}] ${warning.skillPath}: ${warning.message}\n`);
  }
}

function printAddResult(result, stdout) {
  stdout.write(`Outcome: ${result.status}\n`);
  stdout.write(`source: ${result.sourceId}\n`);
  stdout.write(`install: ${result.installPath}\n`);
}

function printUpdatePlan(plan, stdout) {
  stdout.write(`Update plan: ${plan.status}\n`);
  stdout.write(`source: ${plan.sourceId}\n`);
  stdout.write(`install: ${plan.installPath}\n`);
  stdout.write(
    `input: ${plan.input.type} ${
      plan.input.name || plan.input.display || plan.input.remote
    }\n`
  );
  printSkillPaths('unchanged', plan.changes.unchanged, stdout);
  printSkillPaths('added', plan.changes.added, stdout);
  printSkillPaths('removed or relocated', plan.changes.removedOrRelocated, stdout);
  if (plan.skillChanges) {
    printGitUpdateSummary({
      fromCommit: plan.currentCommit,
      toCommit: plan.incomingCommit,
      skillChanges: plan.skillChanges
    }, stdout, { verbose: true });
  }
  if (plan.affectedProjectLinks?.length) {
    printAffectedProjectLinks(plan.affectedProjectLinks, stdout);
  }
}

function printAffectedProjectLinks(links, stdout) {
  if (!Array.isArray(links) || links.length === 0) {
    stdout.write('would break project links:\n  (none)\n');
    return;
  }
  stdout.write('would break project links:\n');
  for (const link of links) {
    stdout.write(`  - ${link.alias} -> ${link.skillPath}\n`);
  }
}

function printGitUpdateBatch(result, stdout, { verbose = false } = {}) {
  const counts = {
    updated: 0,
    current: 0,
    dirty: 0,
    failed: 0,
    breaking: 0
  };
  for (const source of result.sources) {
    counts[source.status] += 1;
    const detail = source.status === 'breaking'
      ? ` (${source.applied ? 'updated' : 'blocked'})`
      : source.status === 'failed' && source.category
        ? ` (${source.category})`
      : '';
    stdout.write(`[${source.status}] ${source.sourceId}${detail}\n`);
    if (source.status === 'breaking' && source.affected?.length) {
      const aliases = source.affected.map((link) => link.alias).join(', ');
      stdout.write(`  would break: ${aliases}\n`);
    }
    if (source.updateSummary) {
      printGitUpdateSummary(source.updateSummary, stdout, { verbose });
    }
    if (source.status === 'dirty') {
      stdout.write(`  reminder: ${source.message || 'local Git changes found; update skipped'}\n`);
    }
    if (source.status === 'failed') {
      stdout.write(`  reason: ${source.message || source.category || 'Git source update failed'}\n`);
    }
  }
  stdout.write(
    `Git source summary: updated=${counts.updated} current=${counts.current} ` +
    `dirty=${counts.dirty} breaking=${counts.breaking} failed=${counts.failed}\n`
  );
}

function printGitUpdateSummary(summary, stdout, { verbose = false } = {}) {
  if (summary.fromCommit && summary.toCommit) {
    stdout.write(
      `  commit: ${shortCommit(summary.fromCommit)} -> ${shortCommit(summary.toCommit)}\n`
    );
  } else if (summary.toCommit) {
    stdout.write(`  commit: ${summary.toCommit}\n`);
  }

  const changes = summary.skillChanges;
  stdout.write(
    `  skill changes: add=${changes.added.length} ` +
    `edit=${changes.edited.length} delete=${changes.deleted.length}\n`
  );
  if (!verbose) return;

  printSkillChangePaths('add new skill', changes.added, stdout);
  printSkillChangePaths('edit skill', changes.edited, stdout);
  printSkillChangePaths('deleted skill', changes.deleted, stdout);
}

function printSkillChangePaths(label, paths, stdout) {
  if (paths.length === 0) return;
  stdout.write(`  ${label}:\n`);
  for (const skillPath of paths) stdout.write(`    - ${skillPath}\n`);
}

function shortCommit(commit) {
  return commit.slice(0, 7);
}

function parseProjectOption(args) {
  const remaining = [];
  let projectPath;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      const value = args[index + 1];
      if (projectPath !== undefined || !value || value.startsWith('--')) {
        return { error: '--project 需要一个目录路径' };
      }
      projectPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--project=')) {
      const value = argument.slice('--project='.length);
      if (projectPath !== undefined || !value) {
        return { error: '--project 需要一个目录路径' };
      }
      projectPath = value;
      continue;
    }
    remaining.push(argument);
  }

  return {
    args: remaining,
    projectPath,
    specified: projectPath !== undefined
  };
}

function parseGitUpdateArgs(args) {
  let verbose = false;
  for (const argument of args) {
    if (argument === '--verbose' && !verbose) {
      verbose = true;
      continue;
    }
    return null;
  }
  return { verbose };
}

function printUpdateResult(result, stdout) {
  stdout.write(`Outcome: ${result.status}\n`);
  stdout.write(`source: ${result.sourceId}\n`);
  stdout.write(`install: ${result.installPath}\n`);
  if (result.skillChanges) {
    printGitUpdateSummary({
      fromCommit: undefined,
      toCommit: result.commit,
      skillChanges: result.skillChanges
    }, stdout, { verbose: true });
  }
}

function printRepairPlan(plan, stdout) {
  stdout.write(`Repair plan: ${plan.status}\n`);
  stdout.write(`source: ${plan.sourceId}\n`);
  stdout.write(`install: ${plan.installPath}\n`);
  stdout.write(`registered commit: ${plan.registeredCommit}\n`);
  stdout.write(`current commit: ${plan.currentCommit}\n`);
  printSkillPaths('unchanged', plan.changes.unchanged, stdout);
  printSkillPaths('added', plan.changes.added, stdout);
  printSkillPaths('removed or relocated', plan.changes.removedOrRelocated, stdout);
  if (plan.affectedProjectLinks?.length) {
    printAffectedProjectLinks(plan.affectedProjectLinks, stdout);
  }
  if (plan.status === 'dirty') {
    stdout.write('reminder: local Git changes found; registry was not changed\n');
  }
}

function printRepairResult(result, stdout) {
  stdout.write(`Outcome: ${result.status}\n`);
  stdout.write(`source: ${result.sourceId}\n`);
  stdout.write(`install: ${result.installPath}\n`);
  stdout.write(`commit: ${result.commit}\n`);
}

function printSkillPaths(label, skillPaths, stdout) {
  stdout.write(`${label}:\n`);
  if (skillPaths.length === 0) {
    stdout.write('  (none)\n');
    return;
  }
  for (const skillPath of skillPaths) stdout.write(`  - ${skillPath}\n`);
}

function parseAddArgs(args) {
  if (args.length === 0 || args[0].startsWith('--')) return null;
  const request = { input: args[0] };
  let yes = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--yes') {
      if (yes) return null;
      yes = true;
      continue;
    }
    if (argument === '--name' || argument === '--namespace') {
      const key = argument.slice(2);
      const value = args[index + 1];
      if (!value || value.startsWith('--') || request[key] !== undefined) return null;
      request[key] = value;
      index += 1;
      continue;
    }
    return null;
  }
  return { request, yes };
}

function parseUpdateArgs(args) {
  if (
    args.length < 1 ||
    args[0].startsWith('--')
  ) {
    return null;
  }
  const request = {
    sourceId: args[0],
    ...(args[1] && !args[1].startsWith('--') ? { input: args[1] } : {})
  };
  let allowBreaking = false;
  let yes = false;

  const optionStart = request.input ? 2 : 1;
  for (const argument of args.slice(optionStart)) {
    if (argument === '--allow-breaking' && !allowBreaking) {
      allowBreaking = true;
      continue;
    }
    if (argument === '--yes' && !yes) {
      yes = true;
      continue;
    }
    return null;
  }
  return { request, yes, allowBreaking };
}

function parseRepairArgs(args) {
  if (args.length < 1 || args[0].startsWith('--')) return null;
  const request = { sourceId: args[0] };
  let allowBreaking = false;
  let yes = false;

  for (const argument of args.slice(1)) {
    if (argument === '--allow-breaking' && !allowBreaking) {
      allowBreaking = true;
      continue;
    }
    if (argument === '--yes' && !yes) {
      yes = true;
      continue;
    }
    return null;
  }
  return { request, yes, allowBreaking };
}

async function requestConfirmation({ confirm, stdin, stdout }, plan, prompt) {
  if (confirm) return Boolean(await confirm(plan));
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(prompt);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export function formatOrigin(origin) {
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
  stderr.write('Usage: npm run source -- add <input> [--name <name>] [--namespace <namespace>] [--yes]\n');
  stderr.write('Usage: npm run source -- repair <source-id> [--allow-breaking] [--yes] [--project <dir>]\n');
  stderr.write('Usage: npm run source -- update <source-id> [input] [--allow-breaking] [--yes] [--project <dir>]\n');
  stderr.write('Usage: npm run source -- update-git [--verbose] [--project <dir>]\n');
  stderr.write('Usage: npm run source -- migrate [--yes]\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await runSourceCli({
    argv: process.argv.slice(2),
    rootDir: process.env.SKILLCADDY_ROOT || process.cwd(),
    projectPath: process.env.SKILLCADDY_PROJECT || process.cwd()
  });
}
