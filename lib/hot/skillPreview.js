/**
 * Local SKILL.md preview for installed sources.
 *
 * The file is untrusted content: this module only reads it and caps the size.
 * Escaping and Markdown rendering happen in the browser, which builds DOM nodes
 * and never assigns untrusted HTML.
 *
 * Not-installed sources have no preview in the MVP: no upstream fetch happens
 * from here, and none happens from the browser either.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readSourceRecords } from '../sourceRegistry.js';

export const SKILL_MD_MAX_BYTES = 512 * 1024;
export const SKILL_MD_PREVIEW_CHARS = 20_000;

/**
 * Locate the skill directory inside a source record.
 *
 * Registry skill paths are source-relative (`.` for a root skill, `skills/foo`
 * for a nested one), so matching is by basename.
 */
export function findSkillPath(record, skillId) {
  if (!record || !Array.isArray(record.skills) || typeof skillId !== 'string') return null;
  const normalized = skillId.trim();
  if (!normalized) return null;

  const exact = record.skills.find((skillPath) => skillPath === normalized);
  if (exact) return exact;

  const byName = record.skills.find((skillPath) => path.basename(skillPath) === normalized);
  if (byName) return byName;

  const rootSkill = record.skills.find((skillPath) => skillPath === '.');
  if (rootSkill && path.basename(record.installPath) === normalized) return rootSkill;

  return null;
}

export async function readSkillPreview({ libraryRoot, record, skillId }) {
  if (!libraryRoot || !record) return null;
  const skillPath = findSkillPath(record, skillId);
  if (skillPath === null) return null;

  const skillDir = path.resolve(libraryRoot, record.installPath, skillPath);
  const sourceRoot = path.resolve(libraryRoot, record.installPath);
  if (skillDir !== sourceRoot && !skillDir.startsWith(`${sourceRoot}${path.sep}`)) return null;

  const filePath = path.join(skillDir, 'SKILL.md');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    if (info.size > SKILL_MD_MAX_BYTES) {
      return { available: false, truncatedBySize: true, skillPath, filePath };
    }
    const content = await readFile(filePath, 'utf8');
    const truncated = content.length > SKILL_MD_PREVIEW_CHARS;
    return {
      available: true,
      skillPath,
      content: truncated ? content.slice(0, SKILL_MD_PREVIEW_CHARS) : content,
      totalChars: content.length,
      truncated
    };
  } catch {
    return null;
  }
}

/** Find the registry record whose Git remote resolves to a hot-list source. */
export async function findRecordByLocation(libraryRoot, source, canonicalize) {
  const records = await readSourceRecords(libraryRoot);
  const target = canonicalize(`https://github.com/${source}.git`);
  return records.find((record) => {
    const remote = record?.origin?.remote;
    if (record.type !== 'git' || typeof remote !== 'string') return false;
    try {
      return canonicalize(remote) === target;
    } catch {
      return false;
    }
  }) || null;
}
