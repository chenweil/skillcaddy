import { syncClaudeSkills } from './claudeStore.js';
import { updateSkillMetadata } from './skillMetadata.js';
import { disableSkill, getState } from './skillStore.js';
import { enableProjectSkill } from './projectActions.js';

const DEFAULT_LIMIT = 20;

export async function loadTuiState(rootDir, projectPath) {
  return getState(rootDir, projectPath);
}

export function summarizeState(state) {
  return {
    projectPath: state.projectPath,
    totalSkills: state.stats.total,
    availableSkills: state.stats.available,
    enabledAgents: state.enabled.length,
    enabledClaude: state.claude?.skills?.length || 0,
    advice: state.advice.length
  };
}

export function listSkillChoices(state, options = {}) {
  const query = normalizeSearch(options.query);
  const source = options.source || '';
  const tag = options.tag || '';
  const limit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  const enabledTargets = new Set(state.enabled.map((skill) => skill.targetPath).filter(Boolean));

  return state.skills
    .filter((skill) => !source || skill.source === source)
    .filter((skill) => !tag || (skill.tags || []).includes(tag))
    .filter((skill) => !query || skillMatchesQuery(skill, query))
    .slice(0, limit)
    .map((skill, index) => ({
      index: index + 1,
      id: skill.id,
      label: formatSkillLabel(skill),
      enabled: enabledTargets.has(skill.path),
      autoEnable: skill.autoEnable,
      skill
    }));
}

export function listEnabledAliases(state) {
  return state.enabled.map((skill, index) => ({
    index: index + 1,
    alias: skill.alias,
    label: `${skill.alias} -> ${skill.targetPath || skill.linkPath}`,
    canDisable: skill.isSymlink,
    skill
  }));
}

export function findSkillByChoice(state, value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('skill 选择不能为空');

  const byId = state.skills.find((skill) => skill.id === text);
  if (byId) return byId;

  const byName = state.skills.filter((skill) => skill.name === text);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`存在多个同名 skill：${text}，请使用完整 id`);
  }

  throw new Error(`找不到 skill：${text}`);
}

export function findSkillByQuery(state, query) {
  const matches = listSkillChoices(state, { query, limit: 2 });
  if (matches.length === 0) {
    throw new Error(`找不到匹配的 skill：${query}`);
  }
  if (matches.length > 1) {
    throw new Error(`多个 skill 匹配：${query}，请从搜索结果序号中选择`);
  }
  return matches[0].skill;
}

export async function enableSkillChoice(rootDir, state, value, options = {}) {
  const skill = findSkillByChoice(state, value);
  return enableProjectSkill(rootDir, {
    projectPath: state.projectPath,
    skillPath: skill.path,
    alias: options.alias || skill.name
  });
}

export async function disableAlias(state, alias) {
  return disableSkill({
    projectPath: state.projectPath,
    alias
  });
}

export async function syncClaude(state) {
  return syncClaudeSkills(state.projectPath);
}

export async function saveSkillMetadata(rootDir, state, value, metadata) {
  const skill = findSkillByChoice(state, value);
  return updateSkillMetadata(rootDir, {
    skillPath: skill.path,
    note: metadata.note ?? skill.note,
    tags: metadata.tags ?? skill.tags,
    autoEnable: metadata.autoEnable ?? skill.autoEnable
  });
}

export function formatAdvice(advice) {
  return advice.map((item, index) => ({
    index: index + 1,
    severity: item.severity || 'info',
    title: item.title,
    detail: item.detail
  }));
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function skillMatchesQuery(skill, query) {
  return [
    skill.id,
    skill.name,
    skill.source,
    skill.collection,
    skill.description,
    skill.note,
    ...(skill.tags || [])
  ].some((value) => String(value || '').toLowerCase().includes(query));
}

function formatSkillLabel(skill) {
  const disabled = skill.autoEnable === false ? ' skip-bulk' : '';
  return `${skill.id}${disabled} - ${skill.note || skill.description || '无描述'}`;
}
