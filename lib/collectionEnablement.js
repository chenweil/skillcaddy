import { buildCollectionEnablePlan } from './enablePlan.js';
import { enableProjectSkill } from './projectActions.js';
import { getState } from './skillStore.js';

export async function executeCollectionEnablement(rootDir, input) {
  const projectPath = input.projectPath;
  const skillIds = normalizeSkillIds(input.skillIds);
  const state = await getState(rootDir, projectPath);
  const plan = buildCollectionEnablePlan(state, skillIds);
  const skillsById = new Map(state.skills.map((skill) => [skill.id, skill]));
  const outcomes = [
    ...plan.unchangedSkillIds.map((skillId) => buildStaticOutcome(skillsById, skillId, 'unchanged')),
    ...plan.skippedSkillIds.map((skillId) => buildStaticOutcome(skillsById, skillId, 'skipped'))
  ];

  for (const skillId of plan.targetSkillIds) {
    const skill = skillsById.get(skillId);
    try {
      const result = await enableProjectSkill(rootDir, {
        projectPath: state.projectPath,
        skillPath: skill.path,
        alias: skill.name
      });
      outcomes.push({
        skillId,
        alias: result.alias,
        status: result.unchanged ? 'unchanged' : 'enabled',
        claudeSync: result.claudeSync
      });
    } catch (error) {
      outcomes.push({
        skillId,
        alias: skill.name,
        status: 'failed',
        error: error.message || 'Collection enablement failed'
      });
    }
  }

  const refreshed = await refreshSetupGuidance(rootDir, state.projectPath, plan.setups);
  return {
    plan,
    outcomes,
    counts: countOutcomes(outcomes),
    setups: refreshed.setups,
    reminders: refreshed.reminders,
    refresh: refreshed.refresh
  };
}

function normalizeSkillIds(value) {
  if (!Array.isArray(value)) throw new Error('skillIds 必须是数组');
  return [...new Set(value.map((skillId) => {
    if (typeof skillId !== 'string' || !skillId.trim()) {
      throw new Error('skillIds 只能包含非空字符串');
    }
    return skillId.trim();
  }))];
}

function buildStaticOutcome(skillsById, skillId, status) {
  const skill = skillsById.get(skillId);
  return {
    skillId,
    alias: skill.name,
    status
  };
}

function countOutcomes(outcomes) {
  const counts = {
    enabled: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

async function refreshSetupGuidance(rootDir, projectPath, plannedSetups) {
  try {
    const state = await getState(rootDir, projectPath);
    const setupIds = new Set(plannedSetups.map((setup) => setup.id));
    return {
      setups: state.setups.filter((setup) => setupIds.has(setup.id)),
      reminders: state.advice.filter((advice) =>
        setupIds.has(advice.collection) && advice.type.startsWith('collection-setup-')
      ),
      refresh: { ok: true }
    };
  } catch (error) {
    return {
      setups: plannedSetups,
      reminders: [],
      refresh: {
        ok: false,
        error: error.message || 'Collection setup guidance refresh failed'
      }
    };
  }
}
