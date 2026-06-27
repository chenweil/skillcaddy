import { renderAgentsSkills } from './agentsUi.js';
import { renderClaudeStatus } from './claudeUi.js';

const state = {
  rootDir: '',
  projectPath: '',
  skills: [],
  enabled: [],
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
  message: document.querySelector('#message'),
  versionTag: document.querySelector('#versionTag')
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
  renderAgentsSkills({ enabled: state.enabled, elements, onDisable: disable });
  renderClaudeStatus({ claude: state.claude, elements, onUnlink: unlinkClaudeSkill });
  renderSkills();
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
          <span class="chevron">▾</span>
          <h3></h3>
          <p></p>
        </div>
        <span class="badge"></span>
      </button>
      <div class="group-items"></div>
    `;

    groupElement.querySelector('h3').textContent = group.collection;
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
  await api('/api/enable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, skillPath: skill.path, alias: skill.name }
  });
  setMessage(`已启用 ${skill.name}`);
  await loadState({ button: null });
}

async function disable(alias) {
  await api('/api/disable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已禁用 ${alias}`);
  await loadState({ button: null });
}

async function disableAgents() {
  await withButtonState(elements.disableAgents, '…', async () => {
    const aliases = state.enabled.filter((skill) => skill.isSymlink).map((skill) => skill.alias);
    await Promise.all(aliases.map((alias) => api('/api/disable', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value, alias }
    })));
    setMessage(aliases.length ? `已禁用 ${aliases.length} 个 agents skill` : '没有可禁用的 agents skill');
    await loadState({ button: null });
  });
}

async function syncClaude() {
  await withButtonState(elements.syncClaude, '加入中', async () => {
    const result = await api('/api/sync-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(`已加入 Claude Code：${result.targetPath}`);
    await loadState({ button: null });
    await flashButton(elements.syncClaude, '已加入');
  });
}

async function unlinkClaude() {
  await withButtonState(elements.unlinkClaude, '清理中', async () => {
    const result = await api('/api/unlink-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(result.removed ? '已一键禁用 Claude Code skill' : 'Claude Code 当前未启用 skill 入口');
    await loadState({ button: null });
    await flashButton(elements.unlinkClaude, '已清理');
  });
}

async function unlinkClaudeSkill(alias) {
  await api('/api/unlink-claude-skill', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已清理 Claude skill：${alias}`);
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

function setMessage(text, isError = false) { elements.message.textContent = text; elements.message.style.color = isError ? '#b42318' : ''; }

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
