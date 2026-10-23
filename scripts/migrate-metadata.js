#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacySkillMetadata } from '../lib/skillMetadata.js';
import { resolveRoots } from '../lib/roots.js';
import { ensureSourceFolders, scanSkills } from '../lib/skillStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roots = resolveRoots({ codeRoot: path.resolve(__dirname, '..') });
const write = process.argv.slice(2).includes('--yes');

await ensureSourceFolders(roots);
const skills = await scanSkills(roots);
const result = await migrateLegacySkillMetadata(roots, skills, { write });
const invalid = [
  ...skills.filter((skill) => skill.metadataError),
  ...result.invalid
];

if (result.pending.length === 0) {
  console.log('没有需要迁移的 legacy metadata。');
} else {
  result.pending.forEach((item) => console.log(`${write ? '[migrated]' : '[dry-run]'} ${item.id}\n  ${item.legacyPath}\n  -> ${item.sidecarPath}`));
  console.log(write
    ? `已迁移 ${result.migrated} 个 metadata；legacy 文件保留，便于回滚。`
    : `待迁移 ${result.pending.length} 个 metadata。确认后运行 npm run migrate:metadata -- --yes`);
}

if (invalid.length > 0) {
  invalid.forEach((skill) => console.error(`[invalid] ${skill.id}: ${skill.metadataError}`));
  process.exitCode = 1;
}
