import { constants } from 'node:fs';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';

const KNOWN_FRONTMATTER_FIELDS = new Set([
  'allowed-tools',
  'compatibility',
  'description',
  'disable-model-invocation',
  'license',
  'metadata',
  'name'
]);

export async function validateStagedSource(sourceRoot) {
  const skillDirectories = await discoverSkillDirectories(sourceRoot);
  if (skillDirectories.length === 0) {
    throw validationError('No scanner-visible SKILL.md was found');
  }

  const skills = [];
  const warnings = [];
  for (const skillDirectory of skillDirectories) {
    const skillPath = path.join(skillDirectory, 'SKILL.md');
    const relativeDirectory = toRelativeSkillPath(sourceRoot, skillDirectory);
    const content = await readRegularSkillFile(skillPath, relativeDirectory);
    skills.push(relativeDirectory);
    warnings.push(...qualityWarnings(relativeDirectory, content));
  }

  return { skills: skills.sort(), warnings };
}

async function discoverSkillDirectories(sourceRoot) {
  const directSkill = path.join(sourceRoot, 'SKILL.md');
  if (await pathEntryExists(directSkill)) return [sourceRoot];

  const skillsRoot = path.join(sourceRoot, 'skills');
  if (!(await directoryExists(skillsRoot))) return [];
  return findNestedSkillDirectories(skillsRoot, 4);
}

async function findNestedSkillDirectories(directory, depth) {
  if (depth < 0) return [];
  if (await pathEntryExists(path.join(directory, 'SKILL.md'))) return [directory];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    nested.push(...await findNestedSkillDirectories(path.join(directory, entry.name), depth - 1));
  }
  return nested;
}

async function readRegularSkillFile(skillPath, relativeDirectory) {
  const displayPath = relativeDirectory === '.' ? 'SKILL.md' : `${relativeDirectory}/SKILL.md`;
  const stat = await lstat(skillPath);
  if (!stat.isFile()) {
    throw validationError(`${displayPath} must be a regular file`);
  }

  try {
    await access(skillPath, constants.R_OK);
    const content = await readFile(skillPath, 'utf8');
    if (!content.trim()) throw validationError(`${displayPath} must not be empty`);
    return content;
  } catch (error) {
    if (error instanceof SourceAcquisitionError) throw error;
    throw validationError(`${displayPath} must be readable`);
  }
}

function qualityWarnings(skillPath, content) {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    return [
      warning('missing-frontmatter', skillPath, 'SKILL.md has no YAML frontmatter'),
      warning('missing-description', skillPath, 'SKILL.md frontmatter has no description')
    ];
  }
  if (frontmatter.malformed) {
    return [
      warning('malformed-frontmatter', skillPath, 'SKILL.md frontmatter is not closed'),
      warning('missing-description', skillPath, 'SKILL.md frontmatter has no description')
    ];
  }

  const warnings = [];
  if (!frontmatter.fields.has('description')) {
    warnings.push(warning(
      'missing-description',
      skillPath,
      'SKILL.md frontmatter has no description'
    ));
  }
  for (const field of frontmatter.fields) {
    if (!KNOWN_FRONTMATTER_FIELDS.has(field)) {
      warnings.push(warning(
        'unknown-frontmatter-field',
        skillPath,
        `SKILL.md frontmatter contains unknown field: ${field}`
      ));
    }
  }
  return warnings;
}

function parseFrontmatter(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex < 0) return { malformed: true, fields: new Set() };

  const fields = new Set();
  for (const line of lines.slice(1, closingIndex)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (match) fields.add(match[1]);
  }
  return { malformed: false, fields };
}

function warning(category, skillPath, message) {
  return { category, skillPath, message };
}

function validationError(message) {
  return new SourceAcquisitionError('source-validation', message);
}

function toRelativeSkillPath(sourceRoot, skillDirectory) {
  const relative = path.relative(sourceRoot, skillDirectory);
  return relative ? relative.split(path.sep).join('/') : '.';
}

async function pathEntryExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function directoryExists(targetPath) {
  try {
    return (await lstat(targetPath)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
