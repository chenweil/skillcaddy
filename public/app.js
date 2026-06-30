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
  activeTag: '',
  editingSkillId: '',
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
  tagTabs: document.querySelector('#tagTabs'),
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
  renderTagTabs();
  renderSkills();
}

function renderProjectHistory() {
  elements.projectHistory.replaceChildren();
  if (state.projectHistory.length === 0) return;

  state.projectHistory.forEach((projectPath) => {
    const item = document.createElement('div');
    item.className = 'project-chip';
    item.title = projectPath;

    const button = document.createElement('button');
    button.className = 'project-chip-path';
    button.type = 'button';
    button.textContent = projectPath;
    button.disabled = projectPath === state.projectPath;
    button.addEventListener('click', async () => {
      elements.projectPath.value = projectPath;
      await loadState({ button: null, feedback: true });
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'project-chip-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = `移除项目：${projectPath}`;
    removeButton.setAttribute('aria-label', `移除项目：${projectPath}`);
    removeButton.addEventListener('click', () => forgetProject(projectPath));

    item.append(button, removeButton);
    elements.projectHistory.append(item);
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

function forgetProject(projectPath) {
  state.projectHistory = state.projectHistory.filter((item) => item !== projectPath);
  localStorage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(state.projectHistory));
  renderProjectHistory();
  setMessage(`已移除项目：${projectPath}`);
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
  const enabledByTarget = new Map(state.enabled.filter((item) => item.isSymlink && item.targetPath).map((item) => [item.targetPath, item]));
  const enabledTargets = new Set(enabledByTarget.keys());
  const sourceSkills = filter ? state.skills.filter((skill) => skill.source === filter) : state.skills;
  const skills = state.activeTag ? sourceSkills.filter((skill) => (skill.tags || []).includes(state.activeTag)) : sourceSkills;
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
          <div class="group-actions">
            <button class="icon-button group-enable-all" type="button" title="启用该库全部 skill" aria-label="启用该库全部 skill">+</button>
            <button class="icon-button group-disable-all danger" type="button" title="清理该库已启用 skill" aria-label="清理该库已启用 skill">×</button>
          </div>
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
    const pendingSkills = group.skills.filter((skill) => canBulkEnableSkill(skill, enabledTargets));
    enableAllButton.disabled = pendingSkills.length === 0;
    enableAllButton.addEventListener('click', () => enableGroup(group));
    const disableAllButton = groupElement.querySelector('.group-disable-all');
    const enabledSkills = group.skills.filter((skill) => enabledByTarget.has(skill.path));
    disableAllButton.disabled = enabledSkills.length === 0;
    disableAllButton.addEventListener('click', () => disableGroup(group));

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
      <div class="skill-tags"></div>
      <div class="bulk-status"></div>
      <p class="note"></p>
      <div class="meta"></div>
      <div class="path"></div>
      <div class="metadata-editor"></div>
      <div class="actions"></div>
    `;

    item.querySelector('.name').textContent = skill.name;
    renderSkillTags(item.querySelector('.skill-tags'), skill.tags || []);
    renderBulkStatus(item.querySelector('.bulk-status'), skill);
    item.querySelector('.note').textContent = skill.note || '未填写备注';
    item.querySelector('.note').classList.toggle('is-empty', !skill.note);
    item.querySelector('.meta').textContent = skill.description || (skill.hasSkillFile ? '未填写 description' : '缺少 SKILL.md');
    item.querySelector('.path').textContent = skill.path;
    if (state.editingSkillId === skill.id) renderMetadataEditor(item.querySelector('.metadata-editor'), skill);

    const actions = item.querySelector('.actions');
    const editButton = document.createElement('button');
    editButton.className = 'secondary';
    editButton.textContent = state.editingSkillId === skill.id ? '收起备注' : '编辑备注';
    editButton.addEventListener('click', () => {
      state.editingSkillId = state.editingSkillId === skill.id ? '' : skill.id;
      renderSkills();
    });
    actions.append(editButton);

    const button = document.createElement('button');
    button.textContent = isEnabled ? '已启用' : '启用 agents skill';
    button.disabled = isEnabled || skill.source === 'archived';
    button.addEventListener('click', () => enable(skill));
    actions.append(button);

    return item;
}

function renderTagTabs() {
  const tags = [...new Set(state.skills.flatMap((skill) => skill.tags || []))].sort((left, right) => left.localeCompare(right));
  elements.tagTabs.replaceChildren();
  if (tags.length === 0) return;

  const allButton = tagTabButton('全部标签', state.activeTag === '');
  allButton.addEventListener('click', () => {
    state.activeTag = '';
    render();
  });
  elements.tagTabs.append(allButton);

  tags.forEach((tag) => {
    const button = tagTabButton(tag, state.activeTag === tag);
    button.addEventListener('click', () => {
      state.activeTag = tag;
      render();
    });
    elements.tagTabs.append(button);
  });
}

function tagTabButton(text, isActive) {
  const button = document.createElement('button');
  button.className = `category-tab${isActive ? ' is-active' : ''}`;
  button.type = 'button';
  button.textContent = text;
  return button;
}

function renderSkillTags(container, tags) {
  container.replaceChildren();
  tags.forEach((tag) => {
    const badge = document.createElement('span');
    badge.className = 'tag-pill';
    badge.textContent = tag;
    container.append(badge);
  });
}

function renderBulkStatus(container, skill) {
  container.replaceChildren();
  if (skill.autoEnable !== false) return;
  const badge = document.createElement('span');
  badge.className = 'tag-pill is-muted';
  badge.textContent = '不参与一键加入';
  container.append(badge);
}

function renderMetadataEditor(container, skill) {
  const form = document.createElement('form');
  form.className = 'metadata-form';
  form.innerHTML = `
    <label>
      <span>备注</span>
      <textarea name="note" rows="3" maxlength="500"></textarea>
    </label>
    <label>
      <span>Tags</span>
      <input name="tags" type="text" placeholder="Developer Tools, Productivity">
    </label>
    <label class="toggle-field">
      <input name="autoEnable" type="checkbox">
      <span>参与库级一键加入</span>
    </label>
    <div class="metadata-actions">
      <button type="submit">保存</button>
      <button class="secondary" type="button">取消</button>
    </div>
  `;
  form.elements.note.value = skill.note || '';
  form.elements.tags.value = (skill.tags || []).join(', ');
  form.elements.autoEnable.checked = skill.autoEnable !== false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveMetadata(skill, form);
  });
  form.querySelector('button[type="button"]').addEventListener('click', () => {
    state.editingSkillId = '';
    renderSkills();
  });
  container.append(form);
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
  const skipped = group.skills.filter((skill) => skill.autoEnable === false && !enabledTargets.has(skill.path));
  const skills = group.skills.filter((skill) => canBulkEnableSkill(skill, enabledTargets));

  if (skills.length === 0) {
    setMessage(skipped.length ? `${group.collection} 没有需要启用的 skill，已跳过 ${skipped.length} 个不参与一键加入` : `${group.collection} 没有需要启用的 skill`);
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
  if (skipped.length) parts.push(`跳过 ${skipped.length}`);
  if (failed) parts.push(`失败 ${failed}`);
  setMessage(parts.join('，'), failed > 0);
  await loadState({ button: null });
}

function canBulkEnableSkill(skill, enabledTargets) {
  return skill.source !== 'archived' && skill.autoEnable !== false && !enabledTargets.has(skill.path);
}

async function disableGroup(group) {
  const enabledByTarget = new Map(state.enabled.filter((item) => item.isSymlink && item.targetPath).map((item) => [item.targetPath, item]));
  const aliases = group.skills
    .map((skill) => enabledByTarget.get(skill.path)?.alias)
    .filter(Boolean);

  if (aliases.length === 0) {
    setMessage(`${group.collection} 没有可清理的 agents skill`);
    return;
  }

  let removed = 0;
  let claudeRemoved = 0;
  let unchanged = 0;
  let failed = 0;

  for (const alias of aliases) {
    try {
      const result = await api('/api/disable', {
        method: 'POST',
        body: { projectPath: elements.projectPath.value, alias }
      });
      result.removed ? removed += 1 : unchanged += 1;

      const claudeResult = await api('/api/unlink-claude-skill', {
        method: 'POST',
        body: { projectPath: elements.projectPath.value, alias }
      });
      if (claudeResult.removed) claudeRemoved += 1;
    } catch {
      failed += 1;
    }
  }

  const parts = [`已清理 ${group.collection}`];
  if (removed) parts.push(`${removed} 个 agents skill`);
  if (claudeRemoved) parts.push(`${claudeRemoved} 个 Claude Code skill`);
  if (unchanged) parts.push(`已不存在 ${unchanged}`);
  if (failed) parts.push(`失败 ${failed}`);
  setMessage(parts.join('，'), failed > 0);
  await loadState({ button: null });
}

async function saveMetadata(skill, form) {
  const result = await api('/api/skill-metadata', {
    method: 'POST',
    body: {
      skillPath: skill.path,
      note: form.elements.note.value,
      tags: form.elements.tags.value,
      autoEnable: form.elements.autoEnable.checked
    }
  });
  state.editingSkillId = '';
  setMessage(`已保存备注：${skill.name}`);
  await loadState({ button: null });
  return result;
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
