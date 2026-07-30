import path from 'node:path';
import { SourceAcquisitionError, sourceCollisionError } from './sourceAcquisitionError.js';
import { readSourceRecords } from './sourceRegistry.js';
import {
  checksumDirectory,
  sourcePathExists
} from './sourceTree.js';

export function fingerprintSourceAcquisitionPlan(plan) {
  return canonicalJson(projectPlanFacts(plan, true));
}

export function fingerprintSourceAcquisitionFacts(plan) {
  return canonicalJson(projectPlanFacts(plan, false));
}

export function assertOriginalSourceAcquisitionPlan(fingerprint, plan, message) {
  if (fingerprint !== fingerprintSourceAcquisitionPlan(plan)) {
    throw new SourceAcquisitionError('stale-plan', message);
  }
}

export function assertSameSourceAcquisitionFacts(fingerprint, plan, message) {
  if (fingerprint !== fingerprintSourceAcquisitionFacts(plan)) {
    throw new SourceAcquisitionError('stale-plan', message);
  }
}

export async function resolveSourceAcquisitionStatus({
  rootDir,
  plan,
  adapter,
  records = null
}) {
  const currentRecords = records || await readSourceRecords(rootDir);
  const sameIdentity = currentRecords.find(
    (record) => record.sourceId === plan.sourceId
  );

  if (sameIdentity) {
    if (!adapter.matchesIdentity(sameIdentity, plan)) {
      throw sourceCollisionError(
        `Source identity is registered with incompatible source facts: ${plan.sourceId}.`
      );
    }
    if (!adapter.matchesContent(sameIdentity, plan)) {
      throw sourceCollisionError(
        `Source identity already exists with different content: ${plan.sourceId}. Use source update${
          plan.input.type === 'local-directory' || plan.input.type === 'local-zip'
            ? ' or another namespace'
            : ''
        }.`,
        plan.sourceId
      );
    }
    await adapter.assertInstalled(rootDir, sameIdentity, plan);
    return 'already-installed';
  }

  const destination = resolveSourceInstallDestination(
    rootDir,
    plan.installPath
  );
  if (
    currentRecords.some((record) => record.installPath === plan.installPath) ||
    await sourcePathExists(destination)
  ) {
    throw sourceCollisionError(
      `Source destination collision: ${plan.installPath}${
        plan.input.type === 'local-directory' || plan.input.type === 'local-zip'
          ? '. Use --namespace to choose another identity.'
          : '.'
      }`
    );
  }
  return 'ready';
}

export async function assertSourceAcquisitionDestinationAvailable(options) {
  if (await resolveSourceAcquisitionStatus(options) !== 'ready') {
    throw sourceCollisionError(
      `Source was installed while applying: ${options.plan.sourceId}`
    );
  }
}

export async function assertDirectorySourceMatchesRecord(
  rootDir,
  record
) {
  const destination = resolveSourceInstallDestination(
    rootDir,
    record.installPath
  );
  if (!(await sourcePathExists(destination))) {
    throw sourceCollisionError(
      `Registered source content is missing: ${record.sourceId}`
    );
  }
  if (await checksumDirectory(destination) !== record.integrity?.value) {
    throw sourceCollisionError(
      `Registered source content no longer matches its integrity: ${record.sourceId}`
    );
  }
}

export function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function resolveSourceInstallDestination(rootDir, installPath) {
  return path.join(rootDir, ...installPath.split('/'));
}

function projectPlanFacts(plan, includeStatus) {
  return {
    operation: plan?.operation,
    ...(includeStatus ? { status: plan?.status } : {}),
    sourceId: plan?.sourceId,
    installPath: plan?.installPath,
    input: plan?.input,
    origin: plan?.origin,
    integrity: plan?.integrity,
    focus: plan?.focus,
    skills: plan?.skills,
    warnings: plan?.warnings
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
