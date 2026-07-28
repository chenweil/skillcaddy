import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import { downloadRemoteSkillFile } from './sourceHttp.js';
import { checksumDirectory } from './sourceTree.js';
import { validateStagedSource } from './sourceValidation.js';

export async function inspectRemoteSkillFile(context, parsed, prefix) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await stageRemoteSkillFile(context, parsed, stagingRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function stageRemoteSkillFile(context, parsed, stagingRoot) {
  const contentRoot = path.join(stagingRoot, 'content');
  await mkdir(contentRoot);
  const skillFile = path.join(contentRoot, 'SKILL.md');
  await downloadRemoteSkillFile(parsed.input, skillFile, {
    limits: context.httpLimits,
    lookup: context.httpLookup
  });
  await validateRemoteSkillFileBytes(skillFile);
  const validated = await validateStagedSource(contentRoot);
  return {
    contentRoot,
    integrity: {
      algorithm: 'sha256',
      value: await checksumDirectory(contentRoot)
    },
    skills: validated.skills,
    warnings: validated.warnings
  };
}

async function validateRemoteSkillFileBytes(skillFile) {
  const content = await readFile(skillFile);
  if (content.includes(0)) {
    throw new SourceAcquisitionError(
      'source-validation',
      'Remote SKILL.md must not contain NUL bytes'
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new SourceAcquisitionError(
      'source-validation',
      'Remote SKILL.md must contain valid UTF-8'
    );
  }
}
