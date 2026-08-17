import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionEnablePlan, buildSkillEnablePlan } from '../lib/enablePlan.js';

test('includes a required setup skill even when it opts out of bulk enable', () => {
  const setupSkill = skill('github/toolbox/setup', '/library/setup', false);
  const tddSkill = skill('github/toolbox/tdd', '/library/tdd', true);
  const state = {
    skills: [setupSkill, tddSkill],
    enabled: [],
    setups: [{
      status: 'missing',
      setupSkillId: setupSkill.id,
      setupSkillEnabled: false,
      applicableSkillIds: [tddSkill.id]
    }]
  };

  const plan = buildCollectionEnablePlan(state, [tddSkill.id]);
  assert.deepEqual(plan.targetSkillIds, [setupSkill.id, tddSkill.id]);
  assert.deepEqual(plan.skippedSkillIds, []);
  assert.equal(plan.setups.length, 1);
});

test('keeps optional bulk exclusions and already-enabled skills out of targets', () => {
  const setupSkill = skill('github/toolbox/setup', '/library/setup', true);
  const riskySkill = skill('github/toolbox/risky', '/library/risky', false);
  const readySkill = skill('github/toolbox/ready', '/library/ready', true);
  const state = {
    skills: [setupSkill, riskySkill, readySkill],
    enabled: [{ targetPath: readySkill.path }],
    setups: []
  };

  const plan = buildCollectionEnablePlan(state, state.skills.map((item) => item.id));
  assert.deepEqual(plan.targetSkillIds, [setupSkill.id]);
  assert.deepEqual(plan.skippedSkillIds, [riskySkill.id]);
  assert.deepEqual(plan.unchangedSkillIds, [readySkill.id]);
});

test('Hermes plans include personal skills and exclude bundled skills', () => {
  const state = {
    skills: [
      skill('official/tool', '/library/official/tool', true),
      skill('personal/tool', '/library/personal/tool', true),
      skill('local/tool', '/library/local/tool', true)
    ],
    hermes: [],
    setups: []
  };

  const plan = buildCollectionEnablePlan(state, state.skills.map((item) => item.id), { scope: 'hermes' });
  assert.deepEqual(plan.targetSkillIds, ['official/tool', 'personal/tool']);
  assert.deepEqual(plan.skippedSkillIds, ['local/tool']);
  assert.throws(
    () => buildSkillEnablePlan(state, 'local/tool', undefined, 'hermes'),
    /Hermes 不允许启用 local 来源/
  );
});

function skill(id, skillPath, autoEnable) {
  return { id, path: skillPath, source: id.split('/')[0], autoEnable };
}
