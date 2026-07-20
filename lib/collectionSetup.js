import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTRACT_ROOT = 'collection-metadata';
const SUPPORTED_SCHEMA_VERSION = 1;

export async function scanCollectionSetups(rootDir, projectPath, skills, enabled) {
  const collections = uniqueCollections(skills);
  const enabledTargets = new Set(enabled.map((skill) => skill.targetPath).filter(Boolean));
  const results = await Promise.all(collections.map(async (collection) => {
    const contractPath = path.join(rootDir, CONTRACT_ROOT, collection.source, `${collection.collection}.json`);
    try {
      const contract = await readContract(contractPath);
      if (!contract) return null;
      return await evaluateSetupContract({
        collection,
        contract: normalizeContract(contract, collection, skills),
        contractPath,
        projectPath,
        skills,
        enabledTargets
      });
    } catch (error) {
      return {
        id: collection.id,
        source: collection.source,
        collection: collection.collection,
        contractPath,
        status: 'invalid',
        error: error.message
      };
    }
  }));

  return results.filter(Boolean).sort((left, right) => left.id.localeCompare(right.id));
}

export function buildCollectionSetupAdvice(setups) {
  const advice = [];

  for (const setup of setups) {
    if (setup.status === 'invalid') {
      advice.push({
        severity: 'warning',
        type: 'collection-setup-invalid',
        title: `库初始化配置无效：${setup.id}`,
        detail: setup.error,
        collection: setup.id,
        contractPath: setup.contractPath
      });
      continue;
    }

    if (setup.affectedEnabledSkillIds.length === 0 || setup.status === 'ready') continue;
    const required = setup.requirement === 'required';
    const statusText = setup.status === 'partial' ? '仅完成部分配置' : '尚未配置';
    const setupSkillText = setup.setupSkillEnabled ? '' : ` 初始化 skill ${setup.setupSkillName} 尚未启用。`;
    advice.push({
      severity: required ? 'warning' : 'info',
      type: required ? 'collection-setup-required' : 'collection-setup-recommended',
      title: `${setup.id} 已启用但${statusText}`,
      detail: `缺少：${setup.missingArtifacts.join('、')}。${setupSkillText}请在 Agent 中运行 ${setup.setupSkillName}。`,
      collection: setup.id,
      status: setup.status,
      setupSkillId: setup.setupSkillId,
      missingArtifacts: setup.missingArtifacts,
      affectedSkillIds: setup.affectedEnabledSkillIds,
      actions: [{
        type: 'run-setup-skill',
        skillId: setup.setupSkillId,
        instruction: setup.instruction
      }]
    });
  }

  return advice;
}

async function evaluateSetupContract({ collection, contract, contractPath, projectPath, skills, enabledTargets }) {
  const artifacts = await Promise.all(contract.requiredArtifacts.map(async (relativePath) => ({
    path: relativePath,
    exists: await pathExists(path.resolve(projectPath, relativePath))
  })));
  const existingCount = artifacts.filter((artifact) => artifact.exists).length;
  const status = existingCount === 0 ? 'missing' : existingCount === artifacts.length ? 'ready' : 'partial';
  const applicableSkills = skills.filter((skill) =>
    skill.id !== contract.skillId && contract.appliesTo.some((pattern) => matchesPattern(skill.id, pattern))
  );
  const setupSkill = skills.find((skill) => skill.id === contract.skillId);

  return {
    id: collection.id,
    source: collection.source,
    collection: collection.collection,
    contractPath,
    requirement: contract.requirement,
    scope: contract.scope,
    mode: contract.mode,
    status,
    setupSkillId: setupSkill.id,
    setupSkillName: setupSkill.name,
    setupSkillEnabled: enabledTargets.has(setupSkill.path),
    applicableSkillIds: applicableSkills.map((skill) => skill.id),
    affectedEnabledSkillIds: applicableSkills.filter((skill) => enabledTargets.has(skill.path)).map((skill) => skill.id),
    requiredArtifacts: artifacts.map((artifact) => artifact.path),
    missingArtifacts: artifacts.filter((artifact) => !artifact.exists).map((artifact) => artifact.path),
    instruction: `请运行 ${setupSkill.name}，完成 ${collection.id} 的项目初始化。`
  };
}

function normalizeContract(value, collection, skills) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('setup contract 必须是对象');
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) throw new Error(`schemaVersion 必须是 ${SUPPORTED_SCHEMA_VERSION}`);
  const setup = value.setup;
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) throw new Error('setup 字段必须是对象');
  if (!['required', 'recommended'].includes(setup.requirement)) throw new Error('setup.requirement 必须是 required 或 recommended');
  if (setup.scope !== 'project') throw new Error('setup.scope 当前只支持 project');
  if (setup.mode !== 'interactive') throw new Error('setup.mode 当前只支持 interactive');
  if (typeof setup.skillId !== 'string' || !setup.skillId.trim()) throw new Error('setup.skillId 不能为空');

  const setupSkill = skills.find((skill) => skill.id === setup.skillId);
  if (!setupSkill || setupSkill.source !== collection.source || setupSkill.collection !== collection.collection) {
    throw new Error('setup.skillId 必须指向当前库中存在的 skill');
  }

  const appliesTo = normalizePatterns(setup.appliesTo);
  const requiredArtifacts = normalizeArtifacts(setup.requiredArtifacts);
  if (!skills.some((skill) => skill.id !== setup.skillId && appliesTo.some((pattern) => matchesPattern(skill.id, pattern)))) {
    throw new Error('setup.appliesTo 没有匹配当前库中的 skill');
  }

  return {
    requirement: setup.requirement,
    scope: setup.scope,
    mode: setup.mode,
    skillId: setup.skillId,
    appliesTo,
    requiredArtifacts
  };
}

function normalizePatterns(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('setup.appliesTo 必须是非空数组');
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('setup.appliesTo 只能包含字符串');
    const text = pattern.trim();
    const star = text.indexOf('*');
    if (star !== -1 && (star !== text.length - 1 || text.indexOf('*', star + 1) !== -1)) {
      throw new Error('setup.appliesTo 仅支持末尾 * 通配符');
    }
    return text;
  });
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('setup.requiredArtifacts 必须是非空数组');
  return [...new Set(value.map((artifact) => {
    if (typeof artifact !== 'string' || !artifact.trim()) throw new Error('setup.requiredArtifacts 只能包含字符串');
    const normalized = path.normalize(artifact.trim());
    if (path.isAbsolute(normalized) || normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error('setup.requiredArtifacts 必须是项目内相对路径');
    }
    return normalized;
  }))];
}

function uniqueCollections(skills) {
  const collections = new Map();
  for (const skill of skills) {
    const id = `${skill.source}/${skill.collection}`;
    if (!collections.has(id)) collections.set(id, { id, source: skill.source, collection: skill.collection });
  }
  return [...collections.values()];
}

function matchesPattern(value, pattern) {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

async function readContract(contractPath) {
  try {
    return JSON.parse(await readFile(contractPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
