import { renderAgentsSkills } from './agentsUi.js';
import { renderClaudeStatus } from './claudeUi.js';

const state = {
  rootDir: '',
  projectPath: '',
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
elements.refreshButton.addEventListener('click', () => loadState({ button: elements.refreshButton, feedback: true, label: '刷新' }));
elements.sourceFilter.addEventListener('change', render);
elements.unlinkClaude.addEventListener('click', unlinkClaude);
elements.syncClaude.addEventListener('click', syncClaude);
elements.disableAgents.addEventListener('click', disableAgents);

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
  renderSkills();
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
      <button class="group-head" type="button" aria-expanded="${!isCollapsed}">
        <div>
          <h3>
            <span class="chevron" aria-hidden="true">▾</span>
            <span class="title"></span>
          </h3>
          <p></p>
        </div>
        <span class="badge"></span>
      </button>
      <div class="group-items"></div>
    `;

    groupElement.querySelector('h3 .title').textContent = group.collection;
    groupElement.querySelector('p').textContent = group.collectionPath;
    groupElement.querySelector('.badge').textContent = `${group.source} · ${group.skills.length}`;
    groupElement.querySelector('.group-head').addEventListener('click', () => toggleGroup(group.key));

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
