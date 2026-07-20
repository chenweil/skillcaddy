export function buildCollectionEnablePlan(state, skillIds) {
  const requestedIds = new Set(skillIds);
  const requestedSkills = state.skills.filter((skill) => requestedIds.has(skill.id));
  if (requestedSkills.length !== requestedIds.size) {
    const knownIds = new Set(requestedSkills.map((skill) => skill.id));
    const missing = [...requestedIds].filter((skillId) => !knownIds.has(skillId));
    throw new Error(`找不到待启用 skill：${missing.join(', ')}`);
  }

  const enabledTargets = new Set(state.enabled.map((skill) => skill.targetPath).filter(Boolean));
  const setups = findSetupsForSkillIds(state, skillIds).filter((setup) => setup.status !== 'ready');
  const setupSkillIds = new Set(setups.filter((setup) => !setup.setupSkillEnabled).map((setup) => setup.setupSkillId));
  const expandedSkills = [];

  for (const setupSkillId of setupSkillIds) {
    const setupSkill = state.skills.find((skill) => skill.id === setupSkillId);
    if (setupSkill) expandedSkills.push(setupSkill);
  }
  for (const skill of requestedSkills) {
    if (!setupSkillIds.has(skill.id)) expandedSkills.push(skill);
  }

  const targetSkillIds = [];
  const skippedSkillIds = [];
  const unchangedSkillIds = [];

  for (const skill of expandedSkills) {
    if (enabledTargets.has(skill.path)) {
      unchangedSkillIds.push(skill.id);
    } else if (skill.source === 'archived' || (skill.autoEnable === false && !setupSkillIds.has(skill.id))) {
      skippedSkillIds.push(skill.id);
    } else {
      targetSkillIds.push(skill.id);
    }
  }

  return { targetSkillIds, skippedSkillIds, unchangedSkillIds, setups };
}

function findSetupsForSkillIds(state, skillIds) {
  const candidates = new Set(skillIds);
  return (state.setups || []).filter((setup) =>
    setup.status !== 'invalid' && setup.applicableSkillIds.some((skillId) => candidates.has(skillId))
  );
}
