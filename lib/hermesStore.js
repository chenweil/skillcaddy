import { homedir } from 'node:os';
import path from 'node:path';
import { scanSkillLinks } from './skillLinkStore.js';

export const HERMES_ELIGIBLE_SOURCES = Object.freeze(['official', 'github', 'personal']);

export function getHermesSkillsDir(hermesDir) {
  return path.resolve(hermesDir || path.join(homedir(), '.hermes', 'skills'));
}

export async function scanHermesSkills({ hermesDir } = {}) {
  const directory = getHermesSkillsDir(hermesDir);
  const skills = await scanSkillLinks(directory);
  return skills
    .map((skill) => ({ ...skill, agent: 'Hermes', scope: 'hermes', directory }))
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export function isHermesEligibleSource(source) {
  return HERMES_ELIGIBLE_SOURCES.includes(source);
}
