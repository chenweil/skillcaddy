import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requirePath } from './projectPath.js';
import {
  assertInsideAllowedSkillSources,
  resolveAllowedSkillSource
} from './sourcePolicy.js';

const METADATA_FILE = 'skillcaddy.json';
const METADATA_ROOT = '.skillcaddy/metadata';
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;
const MAX_NOTE_LENGTH = 500;

export async function readSkillMetadata(rootDir, skillPath) {
  const sidecarMetadataPath = getSidecarMetadataPath(rootDir, skillPath);
  try {
    const content = await readFile(sidecarMetadataPath, 'utf8');
    return {
      ...normalizeMetadata(JSON.parse(content)),
      metadataPath: sidecarMetadataPath,
      hasMetadata: true,
      metadataStorage: 'sidecar'
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        ...emptyMetadata(sidecarMetadataPath),
        metadataError: `skillcaddy.json 读取失败：${error.message}`
      };
    }
  }

  const legacyMetadataPath = getLegacyMetadataPath(skillPath);
  try {
    const content = await readFile(legacyMetadataPath, 'utf8');
    return {
      ...normalizeMetadata(JSON.parse(content)),
      metadataPath: legacyMetadataPath,
      hasMetadata: true,
      metadataStorage: 'legacy'
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptyMetadata(sidecarMetadataPath);
    }

    return {
      ...emptyMetadata(sidecarMetadataPath),
      metadataError: `skillcaddy.json 读取失败：${error.message}`
    };
  }
}

export async function updateSkillMetadata(rootDir, input) {
  const skillPath = path.resolve(requirePath(input.skillPath, 'skillPath'));
  assertInsideAllowedSkillSources(rootDir, skillPath);
  await assertDirectory(skillPath, 'skillPath');

  const metadata = normalizeMetadata(input);
  const metadataPath = getSidecarMetadataPath(rootDir, skillPath);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify({ note: metadata.note, tags: metadata.tags, autoEnable: metadata.autoEnable }, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    skillPath,
    metadataPath,
    metadata: {
      ...metadata,
      metadataPath,
      hasMetadata: true,
      metadataStorage: 'sidecar'
    }
  };
}

export async function migrateLegacySkillMetadata(rootDir, skills, options = {}) {
  const pending = skills
    .filter((skill) => skill.metadataStorage === 'legacy')
    .map((skill) => ({
      id: skill.id,
      skillPath: skill.path,
      legacyPath: skill.metadataPath,
      sidecarPath: getSidecarMetadataPath(rootDir, skill.path)
    }));

  if (!options.write) {
    return { dryRun: true, pending, migrated: 0 };
  }

  for (const item of pending) {
    const skill = skills.find((candidate) => candidate.id === item.id);
    await updateSkillMetadata(rootDir, {
      skillPath: skill.path,
      note: skill.note,
      tags: skill.tags,
      autoEnable: skill.autoEnable
    });
  }

  return { dryRun: false, pending, migrated: pending.length };
}

function getLegacyMetadataPath(skillPath) {
  return path.join(skillPath, METADATA_FILE);
}

function getSidecarMetadataPath(rootDir, skillPath) {
  const source = resolveAllowedSkillSource(rootDir, skillPath);
  return path.join(rootDir, METADATA_ROOT, source.sourceFolder, source.relativePath, METADATA_FILE);
}

function normalizeMetadata(input = {}) {
  return {
    note: normalizeNote(input.note),
    tags: normalizeTags(input.tags),
    autoEnable: normalizeAutoEnable(input.autoEnable)
  };
}

function normalizeNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('note 必须是字符串');
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error(`note 不能超过 ${MAX_NOTE_LENGTH} 个字符`);
  }
  return note;
}

function normalizeTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const tags = Array.isArray(value) ? value : String(value).split(',');
  const normalized = [];

  for (const tag of tags) {
    if (typeof tag !== 'string') throw new Error('tags 只能包含字符串');
    const value = tag.trim();
    if (!value) continue;
    if (value.length > MAX_TAG_LENGTH) {
      throw new Error(`tag 不能超过 ${MAX_TAG_LENGTH} 个字符：${value}`);
    }
    if (!normalized.includes(value)) normalized.push(value);
    if (normalized.length > MAX_TAGS) {
      throw new Error(`tags 不能超过 ${MAX_TAGS} 个`);
    }
  }

  return normalized;
}

function normalizeAutoEnable(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  throw new Error('autoEnable 必须是布尔值');
}

function emptyMetadata(metadataPath) {
  return {
    note: '',
    tags: [],
    autoEnable: true,
    metadataPath,
    hasMetadata: false
  };
}

async function assertDirectory(targetPath, label) {
  await access(targetPath, constants.F_OK);
  const stat = await lstat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} 必须是目录：${targetPath}`);
  }
}
