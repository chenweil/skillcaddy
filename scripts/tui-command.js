#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCliInstall, installCliCommand } from '../lib/tuiInstall.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'check';
const target = process.argv[3] || 'cli';

try {
  if (!['cli', 'tui'].includes(target)) {
    console.error(`Unknown target: ${target}`);
    console.error('Usage: node scripts/tui-command.js <check|install> [cli|tui]');
    process.exitCode = 2;
  } else {
    const result = command === 'install'
      ? await installCliCommand(rootDir)
      : command === 'check'
        ? await checkCliInstall(rootDir)
        : null;

    if (!result) {
      console.error(`Unknown command: ${command}`);
      console.error('Usage: node scripts/tui-command.js <check|install> [cli|tui]');
      process.exitCode = 2;
    } else {
      printResult(result);
      process.exitCode = result.ok ? 0 : 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function printResult(result) {
  console.log(result.message);
  console.log(`source: ${result.sourcePath}`);
  console.log(`target: ${result.targetPath}`);
  if (result.linkTarget) console.log(`link: ${result.linkTarget}`);
  if (result.command) console.log(`command: ${result.command}`);
}
