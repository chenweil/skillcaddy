import {
  mkdir,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  applyAddSource,
  planAddSource
} from '../lib/sourceManager.js';
import { makeTempDir } from './testHelpers.js';

export async function addSource(rootDir, request) {
  const plan = await planAddSource({ rootDir }, request);
  await applyAddSource({ rootDir }, plan);
  return plan;
}

export async function createLocalInput(prefix, skills) {
  const input = await makeTempDir(prefix);
  for (const [skillPath, content] of Object.entries(skills)) {
    const skillDirectory = path.join(input, skillPath);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), content);
  }
  return input;
}

export async function createInstalledLocalSource(name, description) {
  const root = await makeTempDir(`source-upgrade-contract-${name}-root-`);
  const input = await createLocalInput(`source-upgrade-contract-${name}-v1-`, {
    'skills/review': skillDocument(description, 'Review')
  });
  const plan = await addSource(root, { input, name });
  return {
    root,
    sourceId: `personal/${name}`,
    installPath: plan.installPath,
    installedSkill: path.join(
      root,
      'personal',
      name,
      'skills',
      'review',
      'SKILL.md'
    )
  };
}

export async function enableSkillLink({
  root,
  project,
  installPath,
  skillPath,
  alias
}) {
  const projectSkills = path.join(project, '.agents', 'skills');
  await mkdir(projectSkills, { recursive: true });
  await symlink(
    path.join(root, installPath, skillPath),
    path.join(projectSkills, alias),
    'dir'
  );
}

export function skillDocument(description, heading) {
  return `---\ndescription: ${description}\n---\n# ${heading}\n`;
}
