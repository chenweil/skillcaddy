#!/usr/bin/env node
/**
 * Recreate the project enablement links for the bundled spec-pipeline skills.
 *
 * Why this script exists: project enablements are live symlinks under
 * `.agents/skills/`, and ADR 0011 Decision 4 deliberately excludes them from
 * the library image — `lib/libraryImage.js` only carries `global` and
 * `hermes` triples. So on a fresh clone the skills exist (they are tracked in
 * `skills/`) but nothing points at them. This is the documented one-time
 * per-project action the ADR calls for.
 *
 * It is safe to run repeatedly: enableSkill reports `unchanged` for a link
 * that already points at the right place, and refuses to overwrite a link
 * that points somewhere else rather than silently repointing it.
 *
 * Usage:
 *   npm run enable:spec-pipeline
 *   node scripts/enable-spec-pipeline.js [--global] [--dry-run]
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getState, enableSkill, disableSkill } from '../lib/skillStore.js';
import { buildSkillEnablePlan } from '../lib/enablePlan.js';

const SKILL_IDS = [
  'local/spec-pipeline/spec-direction-gate',
  'local/spec-pipeline/spec-draft-intake',
  'local/spec-pipeline/spec-role-contract'
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = process.cwd();

function parseArgs(argv) {
  const options = { scope: 'project', dryRun: false, uninstall: false };
  for (const arg of argv) {
    if (arg === '--global') options.scope = 'global';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else return { error: `Unknown argument: ${arg}` };
  }
  return { options };
}

/** Look up a skill by id, reporting the aliases that exist when it does not. */
function findSkill(state, skillId) {
  const direct = state.skills.find((skill) => skill.id === skillId);
  if (direct) return direct;

  // A renamed or moved bundle would otherwise surface as "not found" with no
  // hint about what the library does contain.
  const folder = skillId.split('/')[1];
  const similar = state.skills
    .filter((skill) => skill.id.includes(folder) || String(skill.name).includes(folder))
    .map((skill) => skill.id);
  const suffix = similar.length > 0
    ? `\n  库中相近的条目：\n${similar.map((id) => `    - ${id}`).join('\n')}`
    : '\n  库中没有相近条目。确认 skills/spec-pipeline/ 是否已克隆。';
  throw new Error(`找不到技能 ${skillId}${suffix}`);
}

async function main() {
  const { options, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    console.error('Usage: node scripts/enable-spec-pipeline.js [--global] [--dry-run] [--uninstall]');
    return 2;
  }

  const state = await getState(rootDir, projectPath);
  const results = [];

  for (const skillId of SKILL_IDS) {
    let plan;
    try {
      const skill = findSkill(state, skillId);
      plan = buildSkillEnablePlan(state, skill.id, skill.name, options.scope);
    } catch (err) {
      console.error(`✗ ${skillId}\n  ${err.message}`);
      return 1;
    }

    if (options.uninstall) {
      const removed = await disableSkill({ projectPath, alias: plan.alias, scope: options.scope });
      results.push({ id: skillId, status: removed.ok ? '已停用' : '未启用' });
      continue;
    }

    if (options.dryRun) {
      results.push({ id: skillId, status: plan.status === 'unchanged' ? '已就位' : '将创建' });
      continue;
    }

    try {
      const result = await enableSkill(rootDir, {
        skillPath: plan.skillPath,
        alias: plan.alias,
        scope: options.scope,
        projectPath
      });
      results.push({
        id: skillId,
        status: result.unchanged ? '已就位' : '已创建',
        linkPath: result.linkPath
      });
    } catch (err) {
      console.error(`✗ ${skillId}\n  ${err.message}`);
      return 1;
    }
  }

  const verb = options.uninstall ? '停用' : '启用';
  for (const { id, status, linkPath } of results) {
    console.log(`${status.padEnd(6)} ${id}`);
    if (linkPath && !options.dryRun) console.log(`       ${linkPath}`);
  }

  console.log(`\n✅ spec-pipeline ${verb}完成（scope=${options.scope}${options.dryRun ? '，dry-run' : ''}）。`);
  if (!options.uninstall && options.scope === 'project') {
    console.log('提示：项目级启用链接不在库镜像内（ADR 0011 Decision 4），换机器需重跑本命令。');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`enable-spec-pipeline 执行失败：${err.message}`);
    process.exit(1);
  });
