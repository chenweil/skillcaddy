#!/usr/bin/env node
/**
 * Spec-pipeline gate check for a whole checkout.
 *
 * Scans each spec directory for TECH.md and ROLE.md and applies the gate
 * decisions from lib/specGate.js. Exits non-zero when any spec fails, so this
 * can be wired into a pre-commit hook or a CI job — which is the point: the
 * spec skills describe a gate that is only real if something refuses to let
 * implementation start without it.
 *
 * Deliberate design points, each of which is a place this could have looked
 * stricter than it is:
 *
 *   - A repository with no `specs/` directory is NOT a failure. Most repos
 *     never use this pipeline, and `check:specs` is wired into `npm test`.
 *     Failing them would make the check noise, and noise is what gets
 *     ignored.
 *   - A spec directory is only judged once it has real content. A stub — a
 *     heading and a TODO, nothing else — is reported as skipped, not blocked:
 *     the gate protects the transition into implementation, and there is no
 *     implementation to protect yet. The test for "stub" is structural, not a
 *     character count; see isPlaceholder below for why that distinction
 *     matters.
 *   - ROLE.md is checked independently of TECH.md. An approved spec with no
 *     role contract is still a failure, because "who is implementing this"
 *     is undeclared — but a *missing* ROLE.md is skipped, same reasoning.
 *
 * Usage:
 *   node scripts/check-specs.js [--dir <specs-dir>] [--strict]
 *
 * Exit codes:
 *   0  all present specs pass (or there is nothing to check)
 *   1  at least one spec failed its gate
 *   2  usage error
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { decideApproval, decideRoleContract } from '../lib/specGate.js';

const DEFAULT_DIR = 'specs';

/**
 * Decide whether a document is a real spec or a stub.
 *
 * This is deliberately structural, not length-based. An earlier version used a
 * character count, and it silently swallowed exactly the case the gate exists
 * to catch: a short, unapproved draft ("尚未确认方向的技术方案草稿") is
 * shorter than the threshold, so it was reported as a placeholder and passed.
 *
 * A document is a stub only when it has no substantive content at all — a
 * heading and a TODO. Once someone has written a real Context section, the
 * question is no longer "is this worth checking" but "is it approved", and
 * that is what the gate is for.
 */
function isPlaceholder(text) {
  const body = text
    .split('\n')
    .map((line) => line.trim())
    // Drop headings, list bullets, and comment markers.
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !/^[-*>]/.test(line))
    .join('\n')
    .trim();

  if (body.length === 0) return true;

  // A body consisting only of placeholder tokens is still a stub.
  const meaningful = body
    .split(/\s+/)
    .filter((word) => !/^(todo|tbd|fixme|xxx|待定|待补充|占位)$/i.test(word.replace(/[.,，。]$/, '')));
  return meaningful.length === 0;
}

async function collectSpecs(specsDir) {
  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null; // no pipeline here — not a failure
    throw error;
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(specsDir, entry.name);
    for (const file of ['TECH.md', 'ROLE.md']) {
      const full = path.join(dir, file);
      let text;
      try {
        text = await readFile(full, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      found.push({ id: entry.name, file, path: full, text });
    }
  }
  return found;
}

function parseArgs(argv) {
  let dir = DEFAULT_DIR;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      dir = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--strict') {
      strict = true;
    } else {
      return { error: `Unknown argument: ${argv[i]}` };
    }
  }
  return { dir, strict };
}

async function main() {
  const { dir, strict, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    console.error('Usage: node scripts/check-specs.js [--dir <specs-dir>] [--strict]');
    return 2;
  }

  const specs = await collectSpecs(dir);
  if (specs === null) {
    if (strict) {
      console.error(`STRICT: 未找到 ${dir}/ 目录。`);
      return 1;
    }
    console.log(`ℹ 未找到 ${dir}/，本仓库不使用 spec-pipeline，跳过关卡检查。`);
    return 0;
  }
  if (specs.length === 0) {
    console.log(`ℹ ${dir}/ 下没有 TECH.md 或 ROLE.md，跳过关卡检查。`);
    return 0;
  }

  const failures = [];
  const skipped = [];

  for (const spec of specs) {
    if (isPlaceholder(spec.text)) {
      skipped.push(spec);
      continue;
    }

    const decision = spec.file === 'TECH.md'
      ? decideApproval(spec.text)
      : decideRoleContract(spec.text);

    if (decision.code !== 0) {
      failures.push({ ...spec, decision });
    }
  }

  for (const spec of skipped) {
    console.log(`⏭  ${spec.id}/${spec.file}：内容还是占位，跳过。`);
  }

  for (const { id, file, decision } of failures) {
    console.error(`\n✗ ${id}/${file}`);
    console.error(decision.reason.split('\n').map((l) => `  ${l}`).join('\n'));
  }

  const checked = specs.length - skipped.length;
  if (failures.length === 0) {
    console.log(`\n✅ 关卡检查通过：${checked} 个文档（跳过占位 ${skipped.length} 个）。`);
    return 0;
  }

  console.error(`\n❌ ${failures.length}/${checked} 个文档未通过关卡检查。未通过前不得进入实施。`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`check-specs 执行失败：${err.message}`);
    process.exit(2);
  });
