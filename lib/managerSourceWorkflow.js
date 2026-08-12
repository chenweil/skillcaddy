import path from 'node:path';
import { buildSkillEnablePlan } from './enablePlan.js';
import { enableProjectSkill } from './projectActions.js';
import {
  applyAddSource,
  applyUpdateSource,
  listSources,
  planAddSource,
  planBreakingUpdateSource,
  planUpdateSource
} from './sourceManager.js';
import { getState } from './skillStore.js';
import { normalizeEnablementScope } from './enablementScope.js';

const workflowPlans = new WeakMap();

export async function planManagerSourceWorkflow(context, request) {
  const acquisitionRequest = request?.acquisition || null;
  const enablementRequest = request?.enablement || null;
  if (!acquisitionRequest && !enablementRequest) {
    throw new Error('Manager workflow requires acquisition or enablement intent');
  }

  const acquisition = acquisitionRequest
    ? await planAcquisition(context, acquisitionRequest)
    : null;
  const enablement = enablementRequest
    ? await planEnablement(context, acquisition, enablementRequest)
    : null;
  const plan = {
    operation: 'manager-source-workflow',
    acquisition: acquisition && {
      action: acquisition.action,
      plan: acquisition.plan
    },
    enablement
  };

  workflowPlans.set(plan, {
    acquisition,
    enablementRequest
  });
  return plan;
}

export async function applyManagerSourceWorkflow(context, plan) {
  const privatePlan = workflowPlans.get(plan);
  if (!privatePlan) {
    throw new Error('The Manager workflow plan must be applied by the process that created it');
  }

  const acquisition = await applyAcquisition(context, privatePlan.acquisition);
  const enablement = privatePlan.enablementRequest
    ? await applyEnablement(
        context,
        plan.acquisition?.plan || null,
        privatePlan.enablementRequest
      )
    : null;

  return { acquisition, enablement };
}

async function planAcquisition(context, request) {
  const registeredSource = request.sourceId
    ? await findRegisteredSource(context, request.sourceId)
    : null;

  if (request.sourceId && !registeredSource) {
    throw new Error(`Source is not registered: ${request.sourceId}`);
  }

  if (registeredSource) {
    return planRegisteredUpdate(context, request, registeredSource.sourceId);
  }

  const addRequest = {
      input: request.input,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.namespace === undefined ? {} : { namespace: request.namespace })
  };
  try {
    return {
      action: 'add',
      plan: await planAddSource(context, addRequest)
    };
  } catch (error) {
    if (!error.registeredSourceId) throw error;
    return planRegisteredUpdate(context, request, error.registeredSourceId);
  }
}

async function planRegisteredUpdate(context, request, sourceId) {
  const planUpdate = request.allowBreaking
    ? planBreakingUpdateSource
    : planUpdateSource;
  return {
    action: 'update',
    plan: await planUpdate(context, {
      sourceId,
      ...(request.input === undefined ? {} : { input: request.input })
    })
  };
}

async function findRegisteredSource(context, sourceId) {
  const inventory = await listSources(context);
  return inventory.sources.find(
    (source) => source.status === 'registered' && source.sourceId === sourceId
  );
}

async function planEnablement(context, acquisition, request) {
  const scope = normalizeEnablementScope(request.scope);
  if (acquisition) {
    const skillId = resolveAcquiredSkillId(acquisition.plan, request);
    return {
      skillId,
      alias: request.alias || path.posix.basename(skillId),
      scope,
      status: 'pending-acquisition',
      reminders: []
    };
  }

  if (typeof request.skillId !== 'string' || !request.skillId.trim()) {
    throw new Error('Enablement-only Manager requests require enablement.skillId');
  }
  const state = await getState(
    context.rootDir,
    scope === 'project' ? requireProjectPath(context) : context.projectPath || context.rootDir,
    { globalDir: context.globalDir }
  );
  return buildSkillEnablePlan(state, request.skillId, request.alias, scope);
}

async function applyAcquisition(context, acquisition) {
  if (!acquisition) return null;
  if (acquisition.action === 'add') {
    return applyAddSource(context, acquisition.plan);
  }
  return applyUpdateSource(context, acquisition.plan);
}

async function applyEnablement(context, acquisitionPlan, request) {
  const scope = normalizeEnablementScope(request.scope);
  const state = await getState(
    context.rootDir,
    scope === 'project' ? requireProjectPath(context) : context.projectPath || context.rootDir,
    { globalDir: context.globalDir }
  );
  const skillId = acquisitionPlan
    ? resolveAcquiredSkillId(acquisitionPlan, request)
    : request.skillId;
  const enablementPlan = buildSkillEnablePlan(state, skillId, request.alias, scope);
  const result = await enableProjectSkill(context.rootDir, {
    ...(scope === 'project' ? { projectPath: context.projectPath } : {}),
    scope,
    ...(context.globalDir ? { globalDir: context.globalDir } : {}),
    skillPath: enablementPlan.skillPath,
    alias: enablementPlan.alias
  });
  const verifiedState = await getState(
    context.rootDir,
    scope === 'project' ? context.projectPath : context.projectPath || context.rootDir,
    { globalDir: context.globalDir }
  );
  const verifiedPlan = buildSkillEnablePlan(
    verifiedState,
    skillId,
    enablementPlan.alias,
    scope
  );

  return {
    ...result,
    skillId,
    reminders: verifiedPlan.reminders
  };
}

function resolveAcquiredSkillId(acquisitionPlan, request) {
  const availableIds = new Map(
    acquisitionPlan.skills.map((sourceSkillPath) => [
      path.posix.join(acquisitionPlan.installPath, sourceSkillPath),
      sourceSkillPath
    ])
  );

  if (request.skillId) {
    if (!availableIds.has(request.skillId)) {
      throw new Error(
        `Selected skill is not part of the acquired source: ${request.skillId}`
      );
    }
    return request.skillId;
  }

  if (
    typeof request.sourceSkillPath !== 'string' ||
    !acquisitionPlan.skills.includes(request.sourceSkillPath)
  ) {
    throw new Error(
      `Select one acquired skill: ${[...availableIds.keys()].join(', ')}`
    );
  }
  return path.posix.join(acquisitionPlan.installPath, request.sourceSkillPath);
}

function requireProjectPath(context) {
  if (
    !context ||
    typeof context.projectPath !== 'string' ||
    !context.projectPath.trim()
  ) {
    throw new Error('Manager enablement requires context.projectPath');
  }
  return context.projectPath;
}
