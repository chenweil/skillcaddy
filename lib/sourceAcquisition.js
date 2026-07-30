import { createGitAcquisitionAdapter } from './sourceGitAcquisitionAdapter.js';
import {
  isDefiniteGitSourceInput,
  isGitSourceInput
} from './sourceGitUrl.js';
import {
  isRemoteArchiveInput,
  isRemoteSkillFileInput
} from './sourceHttp.js';
import {
  createLocalAcquisitionAdapter
} from './sourceLocalAcquisitionAdapter.js';
import {
  createRemoteArchiveAcquisitionAdapter
} from './sourceRemoteArchiveAcquisitionAdapter.js';
import {
  createRemoteFileAcquisitionAdapter
} from './sourceRemoteFileAcquisitionAdapter.js';
import { executeSourceAcquisition } from './sourceAcquisitionExecution.js';
import {
  assertOriginalSourceAcquisitionPlan,
  assertSameSourceAcquisitionFacts,
  fingerprintSourceAcquisitionFacts,
  fingerprintSourceAcquisitionPlan,
  resolveSourceAcquisitionStatus
} from './sourceAcquisitionPolicy.js';
import { readSourceRecords } from './sourceRegistry.js';

const sourceAcquisitionPlans = new WeakMap();
const SOURCE_INPUT_TYPES = new Set([
  'git',
  'local-directory',
  'local-zip',
  'remote-file',
  'remote-zip'
]);

export async function planSourceAcquisition(context, request) {
  const acquisition = await buildSourceAcquisition(context, request);
  sourceAcquisitionPlans.set(acquisition.plan, {
    originalFingerprint: fingerprintSourceAcquisitionPlan(acquisition.plan),
    factsFingerprint: acquisition.factsFingerprint,
    request: snapshotRequest(request),
    stalePlanMessage: acquisition.adapter.stalePlanMessage
  });
  return acquisition.plan;
}

export async function applySourceAcquisition(context, plan) {
  const session = sourceAcquisitionPlans.get(plan);
  if (!session) {
    assertAcquisitionPlan(plan);
    throw copiedPlanError(plan);
  }
  assertOriginalSourceAcquisitionPlan(
    session.originalFingerprint,
    plan,
    session.stalePlanMessage
  );
  assertAcquisitionPlan(plan);

  const acquisition = await buildSourceAcquisition(context, session.request);
  assertSameSourceAcquisitionFacts(
    session.factsFingerprint,
    acquisition.plan,
    session.stalePlanMessage
  );
  if (acquisition.plan.status === 'already-installed') {
    return buildAcquisitionResult(acquisition.plan);
  }

  await executeSourceAcquisition(context, acquisition);
  return buildAcquisitionResult(acquisition.plan, 'added');
}

async function buildSourceAcquisition(context, request) {
  if (isDefiniteGitSourceInput(request?.input)) {
    return inspectAcquisition(
      context,
      createGitAcquisitionAdapter(context, request)
    );
  }
  if (isRemoteSkillFileInput(request?.input)) {
    return inspectAcquisition(
      context,
      createRemoteFileAcquisitionAdapter(context, request)
    );
  }
  if (isRemoteArchiveInput(request?.input)) {
    try {
      return await inspectAcquisition(
        context,
        createRemoteArchiveAcquisitionAdapter(context, request)
      );
    } catch (error) {
      if (!isAmbiguousHttpsSource(request.input)) throw error;
      try {
        return await inspectAcquisition(
          context,
          createGitAcquisitionAdapter(context, request)
        );
      } catch {
        throw error;
      }
    }
  }
  return inspectAcquisition(
    context,
    createLocalAcquisitionAdapter(context, request)
  );
}

async function inspectAcquisition(context, adapter) {
  const candidate = await adapter.inspect();
  const records = await readSourceRecords(context.rootDir);
  const identity = await adapter.resolveIdentity(candidate, records);
  const plan = buildSourceAcquisitionPlan(identity, candidate, 'ready');
  plan.status = await resolveSourceAcquisitionStatus({
    rootDir: context.rootDir,
    plan,
    adapter,
    records
  });
  const factsFingerprint = fingerprintSourceAcquisitionFacts(plan);
  return {
    adapter,
    plan,
    factsFingerprint,
    projectPlan: (prepared) => buildSourceAcquisitionPlan(
      identity,
      prepared,
      plan.status
    )
  };
}

function buildSourceAcquisitionPlan(identity, candidate, status) {
  return {
    operation: 'add-source',
    status,
    sourceId: identity.sourceId,
    installPath: identity.installPath,
    input: candidate.input,
    ...(candidate.origin ? { origin: candidate.origin } : {}),
    ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
    ...(candidate.focus ? { focus: candidate.focus } : {}),
    skills: candidate.skills,
    warnings: candidate.warnings
  };
}

function buildAcquisitionResult(plan, status = plan.status) {
  return {
    status,
    sourceId: plan.sourceId,
    installPath: plan.installPath,
    input: plan.input,
    ...(plan.origin ? { origin: plan.origin } : {}),
    ...(plan.integrity ? { integrity: plan.integrity } : {}),
    ...(plan.focus ? { focus: plan.focus } : {}),
    skills: plan.skills,
    warnings: plan.warnings
  };
}

function assertAcquisitionPlan(plan) {
  if (
    !plan ||
    plan.operation !== 'add-source' ||
    !SOURCE_INPUT_TYPES.has(plan.input?.type) ||
    !['ready', 'already-installed'].includes(plan.status)
  ) {
    throw new Error('A valid add-source plan is required');
  }
}

function copiedPlanError(plan) {
  return new Error(
    plan.input?.type === 'git'
      ? 'The Git add-source plan must be applied by the process that created it'
      : 'The add-source plan must be applied by the process that created it'
  );
}

function snapshotRequest(request) {
  return {
    input: request?.input,
    ...(request?.name === undefined ? {} : { name: request.name }),
    ...(request?.namespace === undefined
      ? {}
      : { namespace: request.namespace })
  };
}

function isAmbiguousHttpsSource(input) {
  if (!isGitSourceInput(input) || isDefiniteGitSourceInput(input)) return false;
  let url;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return !/\.zip$/i.test(url.pathname);
}
