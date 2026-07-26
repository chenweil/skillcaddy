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

export function buildSkillEnablePlan(state, skillId, requestedAlias) {
  const matches = state.skills.filter((skill) => skill.id === skillId);
  if (matches.length !== 1) {
    throw new Error(`Expected one acquired skill for ${skillId}; found ${matches.length}`);
  }

  const skill = matches[0];
  const alias = requestedAlias || skill.name;
  const existing = state.enabled.find((enabledSkill) => enabledSkill.alias === alias);
  if (
    existing &&
    (!existing.isSymlink || existing.targetPath !== skill.path)
  ) {
    throw new Error(`Project alias is occupied by another entry: ${alias}`);
  }

  return {
    skillId: skill.id,
    skillPath: skill.path,
    alias,
    status: existing ? 'unchanged' : 'ready',
    reminders: findSetupReminders(state, skill.id)
  };
}

function findSetupsForSkillIds(state, skillIds) {
  const candidates = new Set(skillIds);
  return (state.setups || []).filter((setup) =>
    setup.status !== 'invalid' && setup.applicableSkillIds.some((skillId) => candidates.has(skillId))
  );
}

function findSetupReminders(state, skillId) {
  const setupIds = new Set(
    findSetupsForSkillIds(state, [skillId])
      .filter((setup) => setup.status !== 'ready')
      .map((setup) => setup.setupSkillId)
  );
  return (state.advice || []).filter(
    (advice) =>
      (
        advice.type === 'collection-setup-required' ||
        advice.type === 'collection-setup-recommended'
      ) &&
      setupIds.has(advice.setupSkillId)
  );
}
