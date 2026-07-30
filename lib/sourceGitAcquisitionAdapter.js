import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  defineSourceAcquisitionAdapter
} from './sourceAcquisitionAdapter.js';
import { sourceCollisionError } from './sourceAcquisitionError.js';
import {
  resolveSourceInstallDestination,
  sameJson
} from './sourceAcquisitionPolicy.js';
import {
  cloneAndInspectGitSource,
  prioritizeFocusedSkills
} from './sourceGitStaging.js';
import {
  canonicalGitRepositoryLocation,
  parseGitSourceRequest
} from './sourceGitUrl.js';
import {
  sourceInstallPathAvailable,
  sourcePathExists
} from './sourceTree.js';

const execFile = promisify(execFileCallback);

export function createGitAcquisitionAdapter({ rootDir }, request) {
  const parsed = parseGitSourceRequest(request);

  return defineSourceAcquisitionAdapter({
    stalePlanMessage: 'Git source changed since the add plan',
    async inspect() {
      const stagingRoot = await mkdtemp(
        path.join(tmpdir(), 'skillcaddy-git-plan-')
      );
      try {
        return buildGitCandidate(
          parsed,
          await cloneAndInspectGitSource(stagingRoot, parsed)
        );
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    },
    prepare: async (workspaceRoot) => buildGitCandidate(
      parsed,
      await cloneAndInspectGitSource(workspaceRoot, parsed)
    ),
    resolveIdentity: (_candidate, records) =>
      resolveGitIdentity(rootDir, records, parsed),
    buildRecord(plan) {
      return {
        schemaVersion: 1,
        sourceId: plan.sourceId,
        bucket: 'github',
        type: 'git',
        installPath: plan.installPath,
        origin: plan.origin,
        ...(plan.focus ? { focus: plan.focus } : {}),
        skills: plan.skills
      };
    },
    matchesIdentity(record, plan) {
      return record.type === 'git' &&
        record.installPath === plan.installPath &&
        canonicalGitRepositoryLocation(record.origin.remote) ===
          canonicalGitRepositoryLocation(plan.origin.remote) &&
        record.origin.ref === plan.origin.ref &&
        sameJson(record.focus, plan.focus);
    },
    matchesContent(record, plan) {
      return record.origin.commit === plan.origin.commit &&
        sameJson(record.skills, plan.skills);
    },
    assertInstalled: assertGitSourceMatchesRecord
  });
}

async function resolveGitIdentity(rootDir, records, parsed) {
  const sameIdentity = records.find(
    (record) => record.sourceId === parsed.sourceId
  );
  if (sameIdentity) {
    return {
      sourceId: parsed.sourceId,
      installPath: sameIdentity.installPath
    };
  }

  const defaultPath = `github/${parsed.repository}`;
  if (await sourceInstallPathAvailable(rootDir, records, defaultPath)) {
    return { sourceId: parsed.sourceId, installPath: defaultPath };
  }

  const namespacedPath = `github/${parsed.owner}--${parsed.repository}`;
  if (await sourceInstallPathAvailable(rootDir, records, namespacedPath)) {
    return { sourceId: parsed.sourceId, installPath: namespacedPath };
  }
  throw sourceCollisionError(
    `Source destination collision: ${namespacedPath}. The repository owner namespace is already in use.`
  );
}

async function assertGitSourceMatchesRecord(rootDir, record, plan) {
  const destination = resolveSourceInstallDestination(
    rootDir,
    record.installPath
  );
  if (!(await sourcePathExists(destination))) {
    throw sourceCollisionError(
      `Registered source content is missing: ${record.sourceId}`
    );
  }
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    execFile('git', ['-C', destination, 'rev-parse', 'HEAD']),
    execFile('git', ['-C', destination, 'status', '--porcelain'])
  ]);
  if (commitOutput.trim() !== plan.origin.commit || statusOutput.trim()) {
    throw sourceCollisionError(
      `Registered Git source content has changed: ${record.sourceId}`
    );
  }
}

function buildGitCandidate(parsed, prepared) {
  const focus = prepared.focus;
  return {
    input: {
      type: 'git',
      remote: parsed.displayRemote
    },
    origin: {
      kind: 'git',
      remote: parsed.displayRemote,
      ref: prepared.ref,
      commit: prepared.commit
    },
    ...(focus ? { focus } : {}),
    skills: prioritizeFocusedSkills(prepared.skills, focus),
    warnings: prepared.warnings,
    ...(prepared.contentRoot ? { contentRoot: prepared.contentRoot } : {})
  };
}
