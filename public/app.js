import { renderAgentsSkills } from './agentsUi.js';
import { renderClaudeStatus } from './claudeUi.js';

const PROJECT_HISTORY_KEY = 'skillcaddy.projectHistory';
const MAX_PROJECT_HISTORY = 8;

const state = {
  rootDir: '',
  projectPath: '',
  projectHistory: readProjectHistory(),
  skills: [],
  enabled: [],
  global: [],
  advice: [],
  claude: null,
  collapsedGroups: new Set(),
  knownGroups: new Set(),
  stats: { total: 0, enabled: 0, available: 0 }
};

const elements = {
  projectPath: document.querySelector('#projectPath'),
  addProject: document.querySelector('#addProject'),
  projectHistory: document.querySelector('#projectHistory'),
  loadProject: document.querySelector('#loadProject'),
  refreshButton: document.querySelector('#refreshButton'),
  disableAgents: document.querySelector('#disableAgents'),
  unlinkClaude: document.querySelector('#unlinkClaude'),
  syncClaude: document.querySelector('#syncClaude'),
  claudeSkillList: document.querySelector('#claudeSkillList'),
  totalSkills: document.querySelector('#totalSkills'),
  sourceFilter: document.querySelector('#sourceFilter'),
  enabledList: document.querySelector('#enabledList'),
  agentsCount: document.querySelector('#agentsCount'),
  claudeCount: document.querySelector('#claudeCount'),
  skillList: document.querySelector('#skillList'),
  adviceList: document.querySelector('#adviceList'),
  message: document.querySelector('#message'),
  versionTag: document.querySelector('#versionTag'),
  heroTotalSkills: document.querySelector('#heroTotalSkills'),
  heroAgentsCount: document.querySelector('#heroAgentsCount'),
  heroClaudeCount: document.querySelector('#heroClaudeCount'),
  activeProject: document.querySelector('#activeProject')
};

elements.loadProject.addEventListener('click', () => loadState({ feedback: true }));
elements.addProject.addEventListener('click', addCurrentProject);
elements.refreshButton.addEventListener('click', () => loadState({ button: elements.refreshButton, feedback: true, label: '刷新' }));
elements.sourceFilter.addEventListener('change', render);
elements.unlinkClaude.addEventListener('click', unlinkClaude);
elements.syncClaude.addEventListener('click', syncClaude);
elements.disableAgents.addEventListener('click', disableAgents);

initializeProjectPathFromUrl();
await Promise.all([loadState(), loadVersion()]);

async function loadState(options = {}) {
  const action = options.label || '读取项目';
  const button = options.button === undefined ? elements.loadProject : options.button;
  const task = async () => {
    const projectPath = elements.projectPath.value.trim();
    const url = `/api/state${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ''}`;
    const nextState = await api(url);
    Object.assign(state, nextState);
    elements.projectPath.value = state.projectPath;
    rememberProject(state.projectPath);
    syncProjectPathToUrl(state.projectPath);
    render();
    if (options.feedback) setMessage(`已${action}：${state.projectPath}`);
  };

  button ? await withButtonState(button, `${action}中`, task) : await task();
}

function render() {
  elements.totalSkills.textContent = state.stats.total;
  elements.agentsCount.textContent = state.enabled.length;
  elements.claudeCount.textContent = state.claude?.skills?.length || 0;
  elements.heroTotalSkills.textContent = state.stats.total;
  elements.heroAgentsCount.textContent = state.enabled.length;
  elements.heroClaudeCount.textContent = state.claude?.skills?.length || 0;
  elements.activeProject.textContent = state.projectPath || '等待读取项目路径';
  renderAgentsSkills({ enabled: state.enabled, elements, onDisable: disable });
  renderClaudeStatus({ claude: state.claude, elements, onUnlink: unlinkClaudeSkill });
  renderAdvice();
  renderProjectHistory();
  renderSkills();
}

function renderProjectHistory() {
  elements.projectHistory.replaceChildren();
  if (state.projectHistory.length === 0) return;

  state.projectHistory.forEach((projectPath) => {
    const button = document.createElement('button');
    button.className = 'project-chip';
    button.type = 'button';
    button.textContent = projectPath;
    button.title = projectPath;
    button.disabled = projectPath === state.projectPath;
    button.addEventListener('click', async () => {
      elements.projectPath.value = projectPath;
      await loadState({ button: null, feedback: true });
    });
    elements.projectHistory.append(button);
  });
}

function addCurrentProject() {
  const projectPath = elements.projectPath.value.trim();
  if (!projectPath) {
    setMessage('请输入项目路径后再添加', true);
    return;
  }

  rememberProject(projectPath);
  renderProjectHistory();
  setMessage(`已添加项目：${projectPath}`);
}

function rememberProject(projectPath) {
  const value = projectPath.trim();
  if (!value) return;
  state.projectHistory = [value, ...state.projectHistory.filter((item) => item !== value)].slice(0, MAX_PROJECT_HISTORY);
  localStorage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(state.projectHistory));
}

function readProjectHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_PROJECT_HISTORY) : [];
  } catch {
    return [];
  }
}

function initializeProjectPathFromUrl() {
  const projectPath = new URLSearchParams(window.location.search).get('projectPath');
  if (projectPath) elements.projectPath.value = projectPath;
}

function syncProjectPathToUrl(projectPath) {
  const url = new URL(window.location.href);
  url.searchParams.set('projectPath', projectPath);
  window.history.replaceState({}, '', url);
}

function renderAdvice() {
  elements.adviceList.replaceChildren();
  if (!state.advice || state.advice.length === 0) return;

  state.advice.slice(0, 6).forEach((advice) => {
    const item = document.createElement('article');
    item.className = `advice ${advice.severity || 'info'}`;
    item.innerHTML = `
      <div>
        <strong></strong>
        <p></p>
      </div>
      <span></span>
    `;
    item.querySelector('strong').textContent = advice.title;
    item.querySelector('p').textContent = advice.detail;
    item.querySelector('span').textContent = advice.type;
    elements.adviceList.append(item);
  });
}

function renderSkills() {
  const filter = elements.sourceFilter.value;
  const enabledTargets = new Set(state.enabled.map((item) => item.targetPath).filter(Boolean));
  const skills = filter ? state.skills.filter((skill) => skill.source === filter) : state.skills;
  const groups = groupSkills(skills);

  elements.skillList.replaceChildren();

  if (skills.length === 0) { elements.skillList.append(empty('还没有 skill 原件。把目录放入 official、github 或 personal 后刷新。')); return; }

  initializeCollapsedGroups(groups);
  groups.forEach((group) => {
    const isCollapsed = state.collapsedGroups.has(group.key);
    const groupElement = document.createElement('section');
    groupElement.className = `skill-group${isCollapsed ? ' is-collapsed' : ''}`;
    groupElement.innerHTML = `
      <div class="group-bar">
        <div class="group-head">
          <button class="group-toggle" type="button" aria-expanded="${!isCollapsed}">
            <h3>
              <span class="chevron" aria-hidden="true">▾</span>
              <span class="title"></span>
            </h3>
          </button>
          <button class="icon-button group-enable-all" type="button" title="启用该库全部 skill" aria-label="启用该库全部 skill">+</button>
          <p></p>
        </div>
        <span class="badge"></span>
      </div>
      <div class="group-items"></div>
    `;

    groupElement.querySelector('h3 .title').textContent = group.collection;
    groupElement.querySelector('p').textContent = group.collectionPath;
    groupElement.querySelector('.badge').textContent = `${group.source} · ${group.skills.length}`;
    groupElement.querySelector('.group-toggle').addEventListener('click', () => toggleGroup(group.key));
    const enableAllButton = groupElement.querySelector('.group-enable-all');
    const pendingSkills = group.skills.filter((skill) => skill.source !== 'archived' && !enabledTargets.has(skill.path));
    enableAllButton.disabled = pendingSkills.length === 0;
    enableAllButton.addEventListener('click', () => enableGroup(group));

    const items = groupElement.querySelector('.group-items');
    group.skills.forEach((skill) => items.append(renderSkill(skill, enabledTargets)));
    elements.skillList.append(groupElement);
  });
}

function initializeCollapsedGroups(groups) { groups.forEach((group) => collapseNewGroup(group.key)); }

function collapseNewGroup(key) {
  if (state.knownGroups.has(key)) return;
  state.knownGroups.add(key); state.collapsedGroups.add(key);
}

function renderSkill(skill, enabledTargets) {
    const isEnabled = enabledTargets.has(skill.path);
    const item = document.createElement('article');
    item.className = 'skill';
    item.innerHTML = `
      <div class="skill-head">
        <span class="name"></span>
        <span class="badge">${skill.source}</span>
      </div>
      <div class="meta"></div>
      <div class="path"></div>
      <div class="actions"></div>
    `;

    item.querySelector('.name').textContent = skill.name;
    item.querySelector('.meta').textContent = skill.description || (skill.hasSkillFile ? '未填写 description' : '缺少 SKILL.md');
    item.querySelector('.path').textContent = skill.path;

    const actions = item.querySelector('.actions');
    const button = document.createElement('button');
    button.textContent = isEnabled ? '已启用' : '启用 agents skill';
    button.disabled = isEnabled || skill.source === 'archived';
    button.addEventListener('click', () => enable(skill));
    actions.append(button);

    return item;
}

function groupSkills(skills) {
  const groups = new Map();

  skills.forEach((skill) => {
    const key = `${skill.source}/${skill.collection}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        source: skill.source,
        collection: skill.collection,
        collectionPath: skill.collectionPath,
        skills: []
      });
    }

    groups.get(key).skills.push(skill);
  });

  return [...groups.values()].sort((left, right) =>
    left.source.localeCompare(right.source) || left.collection.localeCompare(right.collection)
  );
}

function toggleGroup(key) {
  state.collapsedGroups.has(key) ? state.collapsedGroups.delete(key) : state.collapsedGroups.add(key);
  renderSkills();
}

async function enable(skill) {
  const result = await api('/api/enable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, skillPath: skill.path, alias: skill.name }
  });
  setMessage(enableMessage(skill.name, result));
  await loadState({ button: null });
}

async function enableGroup(group) {
  const enabledTargets = new Set(state.enabled.map((item) => item.targetPath).filter(Boolean));
  const skills = group.skills.filter((skill) => skill.source !== 'archived' && !enabledTargets.has(skill.path));

  if (skills.length === 0) {
    setMessage(`${group.collection} 没有需要启用的 skill`);
    return;
  }

  let enabled = 0;
  let unchanged = 0;
  let failed = 0;

  for (const skill of skills) {
    try {
      const result = await api('/api/enable', {
        method: 'POST',
        body: { projectPath: elements.projectPath.value, skillPath: skill.path, alias: skill.name }
      });
      result.unchanged ? unchanged += 1 : enabled += 1;
    } catch {
      failed += 1;
    }
  }

  const parts = [`已处理 ${group.collection}`];
  if (enabled) parts.push(`启用 ${enabled}`);
  if (unchanged) parts.push(`已存在 ${unchanged}`);
  if (failed) parts.push(`失败 ${failed}`);
  setMessage(parts.join('，'), failed > 0);
  await loadState({ button: null });
}

function enableMessage(skillName, result) {
  if (result.claudeSync?.ok === false) {
    return `已启用 ${skillName}；Claude Code 自动同步失败：${result.claudeSync.error}`;
  }

  return result.claudeSync ? `已启用 ${skillName}，并同步 Claude Code` : `已启用 ${skillName}`;
}

async function disable(alias) {
  await api('/api/disable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已清空 ${alias}`);
  await loadState({ button: null });
}

async function disableAgents() {
  await withButtonState(elements.disableAgents, '…', async () => {
    const aliases = state.enabled.filter((skill) => skill.isSymlink).map((skill) => skill.alias);
    await Promise.all(aliases.map((alias) => api('/api/disable', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value, alias }
    })));
    setMessage(aliases.length ? `已清空 ${aliases.length} 个 agents skill` : '没有可清空的 agents skill');
    await loadState({ button: null });
  });
}

async function syncClaude() {
  await withButtonState(elements.syncClaude, '…', async () => {
    const result = await api('/api/sync-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(`已加入 Claude Code：${result.targetPath}`);
    await loadState({ button: null });
    await flashButton(elements.syncClaude, '✓');
  });
}

async function unlinkClaude() {
  await withButtonState(elements.unlinkClaude, '清空中', async () => {
    const result = await api('/api/unlink-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(result.removed ? '已一键清空 Claude Code skill' : 'Claude Code 当前未启用 skill 入口');
    await loadState({ button: null });
    await flashButton(elements.unlinkClaude, '已清空');
  });
}

async function unlinkClaudeSkill(alias) {
  await api('/api/unlink-claude-skill', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已清空 Claude skill：${alias}`);
  await loadState({ button: null });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();

  if (!response.ok) {
    setMessage(payload.error || '请求失败', true);
    throw new Error(payload.error || '请求失败');
  }

  return payload;
}

async function loadVersion() {
  try {
    const info = await api('/api/version');
    if (!info || !info.version) return;
    elements.versionTag.textContent = `v${info.version}`;
    elements.versionTag.title = `${info.name}@${info.version}`;
  } catch {
    // 版本信息不是关键路径，失败时静默（标签留空，CSS :empty 会隐藏）
  }
}

function empty(text) {
  const element = document.createElement('div');
  element.className = 'empty'; element.textContent = text;
  return element;
}

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle('is-error', isError);
}

async function withButtonState(button, busyText, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function flashButton(button, text) {
  const originalText = button.textContent;
  button.textContent = text;
  await new Promise((resolve) => setTimeout(resolve, 700));
  button.textContent = originalText;
}
