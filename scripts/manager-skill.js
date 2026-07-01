#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManagerInstall, installManagerSkill } from '../lib/managerInstall.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'check';

try {
  if (command === 'check') {
    const result = await checkManagerInstall(rootDir);
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'install') {
    const result = await installManagerSkill(rootDir);
    printResult(result);
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  console.error('Usage: node scripts/manager-skill.js <check|install>');
  process.exit(2);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function printResult(result) {
  console.log(result.message);
  console.log(`source: ${result.sourcePath}`);
  console.log(`target: ${result.targetPath}`);
  if (result.linkTarget) console.log(`link: ${result.linkTarget}`);
}
