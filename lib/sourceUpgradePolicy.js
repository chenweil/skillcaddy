import path from 'node:path';
import { canonicalJson } from './canonicalJson.js';
import { SourceAcquisitionError } from './sourceAcquisitionError.js';
import {
  checksumDirectory,
  sourcePathExists
} from './sourceTree.js';
import { scanEnabledSkills } from './skillStore.js';

export function fingerprintSourceUpgradePlan(plan) {
  return canonicalJson({
    operation: plan.operation,
    status: plan.status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    origin: plan.origin,
    integrity: plan.integrity,
    currentCommit: plan.currentCommit,
    incomingCommit: plan.incomingCommit,
    skills: plan.skills,
    warnings: plan.warnings,
    changes: plan.changes,
    affectedProjectLinks: plan.affectedProjectLinks
  });
}

export function assertSameSourceUpgradePlan(
  originalFingerprint,
  plan,
  message
) {
  if (originalFingerprint !== fingerprintSourceUpgradePlan(plan)) {
    throw new SourceAcquisitionError('stale-plan', message);
  }
}

export function assertNoAffectedProjectLinks(affectedProjectLinks) {
  if (affectedProjectLinks.length === 0) return;
  const error = new SourceAcquisitionError(
    'breaking-replacement',
    `Source replacement would break current-project links: ${
      affectedProjectLinks.map((link) => link.alias).join(', ')
    }. Re-run with --allow-breaking to authorize it.`,
    4
  );
  error.affectedProjectLinks = affectedProjectLinks.map((link) => ({
    alias: link.alias,
    skillPath: link.skillPath
  }));
  throw error;
}

export async function findAffectedProjectLinks({
  rootDir,
  projectPath,
  installPath,
  removedSkillPaths
}) {
  if (!projectPath || removedSkillPaths.length === 0) return [];
  const removedByTarget = new Map(removedSkillPaths.map((skillPath) => [
    path.resolve(rootDir, installPath, skillPath),
    skillPath
  ]));
  const links = await scanEnabledSkills(projectPath);
  return links
    .filter((link) => link.isSymlink && removedByTarget.has(link.targetPath))
    .map((link) => ({
      alias: link.alias,
      skillPath: removedByTarget.get(link.targetPath)
    }));
}

export async function assertActiveSourceMatchesRecord(destination, record) {
  if (!(await sourcePathExists(destination))) {
    throw new SourceAcquisitionError(
      'source-collision',
      `Registered source content is missing: ${record.sourceId}`,
      3
    );
  }
  if (await checksumDirectory(destination) !== record.integrity?.value) {
    throw new SourceAcquisitionError(
      'source-collision',
      `Registered source content no longer matches its integrity: ${record.sourceId}`,
      3
    );
  }
}

export function classifySkillChanges(previousSkills, nextSkills) {
  const previous = new Set(previousSkills);
  const next = new Set(nextSkills);
  return {
    unchanged: previousSkills.filter((skillPath) => next.has(skillPath)),
    added: nextSkills.filter((skillPath) => !previous.has(skillPath)),
    removedOrRelocated: previousSkills.filter(
      (skillPath) => !next.has(skillPath)
    )
  };
}
