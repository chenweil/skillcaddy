import { renderAgentsSkills } from './agentsUi.js';
import { renderClaudeStatus } from './claudeUi.js';
import { emptyState } from './emptyState.js';

const PROJECT_HISTORY_KEY = 'skillcaddy.projectHistory';
const MAX_PROJECT_HISTORY = 8;

const state = {
  rootDir: '',
  projectPath: '',
  projectHistory: readProjectHistory(),
  skills: [],
  enabled: [],
  global: [],
  setups: [],
  sources: [],
  advice: [],
  claude: null,
  collapsedGroups: new Set(),
  knownGroups: new Set(),
  activeTag: '',
  searchQuery: '',
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
  skillSearch: document.querySelector('#skillSearch'),
  enabledList: document.querySelector('#enabledList'),
  agentsCount: document.querySelector('#agentsCount'),
  claudeCount: document.querySelector('#claudeCount'),
  skillList: document.querySelector('#skillList'),
  adviceList: document.querySelector('#adviceList'),
  tagTabs: document.querySelector('#tagTabs'),
  message: document.querySelector('#message'),
  errorMessage: document.querySelector('#errorMessage'),
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
elements.skillSearch.addEventListener('input', (event) => {
  state.searchQuery = event.target.value.trim().toLowerCase();
  render();
});
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
  withPreservedFocus(renderAll);
}

function renderAll() {
  elements.totalSkills.textContent = state.stats.total;
  elements.agentsCount.textContent = state.enabled.length;
  elements.claudeCount.textContent = state.claude?.skills?.length || 0;
  elements.heroTotalSkills.textContent = state.stats.total;
  elements.heroAgentsCount.textContent = state.enabled.length;
  elements.heroClaudeCount.textContent = state.claude?.skills?.length || 0;
  elements.activeProject.textContent = state.projectPath || '等待读取项目路径';
  renderAgentsSkills({ enabled: state.enabled, skills: state.skills, elements, onDisable: disable });
  renderClaudeStatus({ claude: state.claude, skills: state.skills, elements, onUnlink: unlinkClaudeSkill });
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
    item.dataset.focusScope = '';
    item.title = projectPath;

    const button = document.createElement('button');
    button.className = 'project-chip-path';
    button.type = 'button';
    button.textContent = projectPath;
    button.dataset.focusKey = `project-open:${projectPath}`;
    button.disabled = projectPath === state.projectPath;
    button.addEventListener('click', async () => {
      elements.projectPath.value = projectPath;
      await loadState({ button: null, feedback: true });
    });

    const removeButton = document.createElement('button');
    removeButton.className = 'project-chip-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.dataset.focusKey = `project-remove:${projectPath}`;
    removeButton.title = `移除项目：${projectPath}`;
    removeButton.setAttribute('aria-label', `从历史移除项目：${projectPath}`);
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

  state.advice.slice(0, 6).forEach((advice, index) => {
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
    const setupAction = (advice.actions || []).find((action) => action.type === 'run-setup-skill');
    if (setupAction) {
      const button = document.createElement('button');
      button.className = 'secondary advice-action';
      button.type = 'button';
      button.textContent = '查看配置指引';
      button.dataset.focusKey = `advice-action:${index}`;
      button.addEventListener('click', () => setMessage(setupAction.instruction));
      item.querySelector('div').append(button);
    }
    elements.adviceList.append(item);
  });
}

function renderSkills() {
  withPreservedFocus(renderSkillList);
}

function renderSkillList() {
  const filter = elements.sourceFilter.value;
  const enabledByTarget = new Map(state.enabled.filter((item) => item.isSymlink && item.targetPath).map((item) => [item.targetPath, item]));
  const enabledTargets = new Set(enabledByTarget.keys());
  const sourceSkills = filter ? state.skills.filter((skill) => skill.source === filter) : state.skills;
  const searchedSkills = state.searchQuery ? sourceSkills.filter((skill) => matchesSearchQuery(skill, state.searchQuery)) : sourceSkills;
  const skills = state.activeTag ? searchedSkills.filter((skill) => (skill.tags || []).includes(state.activeTag)) : searchedSkills;
  const groups = groupSkills(skills);

  elements.skillList.replaceChildren();

  if (skills.length === 0) { elements.skillList.append(hasActiveFilter() ? filteredEmpty() : libraryEmpty()); return; }

  initializeCollapsedGroups(groups);
  groups.forEach((group) => {
    const isCollapsed = state.collapsedGroups.has(group.key);
    const groupElement = document.createElement('section');
    groupElement.className = `skill-group${isCollapsed ? ' is-collapsed' : ''}`;
    groupElement.innerHTML = `
      <div class="group-bar" data-focus-scope>
        <div class="group-head">
          <h3 class="group-heading">
            <button class="group-toggle" type="button" aria-expanded="${!isCollapsed}">
              <span class="chevron" aria-hidden="true">▾</span>
              <span class="title"></span>
            </button>
          </h3>
          <div class="group-actions">
            <button class="icon-button group-enable-all" type="button">+</button>
            <button class="icon-button group-disable-all danger" type="button" title="清空该库已启用的 skill" aria-label="清空该库已启用的 skill">×</button>
          </div>
          <p></p>
        </div>
        <span class="badge"></span>
      </div>
      <div class="group-items"></div>
    `;

    groupElement.querySelector('.group-toggle .title').textContent = group.collection;
    const sourceInfo = findSourceInfo(group.key);
    const versionText = sourceInfo?.version ? ` · ${sourceInfo.version}` : '';
    groupElement.querySelector('p').textContent = `${group.collectionPath}${versionText}`;
    const setup = findCollectionSetup(group.source, group.collection);
    const badge = groupElement.querySelector('.badge');
    badge.textContent = `${group.source} · ${group.skills.length}${setup ? ` · ${setupStatusLabel(setup)}` : ''}`;
    if (setup) badge.title = setupTooltip(setup);
    const toggleButton = groupElement.querySelector('.group-toggle');
    toggleButton.dataset.focusKey = `group-toggle:${group.key}`;
    toggleButton.addEventListener('click', () => toggleGroup(group.key));
    const enableAllButton = groupElement.querySelector('.group-enable-all');
    const pendingSkills = group.skills.filter((skill) => canBulkEnableSkill(skill, enabledTargets));
    const enabledSkills = group.skills.filter((skill) => enabledByTarget.has(skill.path));
    const pendingSetupSkill = setup?.status !== 'ready' && setup?.status !== 'invalid' && !setup?.setupSkillEnabled;
    enableAllButton.disabled = pendingSkills.length === 0 && !pendingSetupSkill;
    enableAllButton.dataset.focusKey = `group-enable:${group.key}`;
    enableAllButton.textContent = enabledSkills.length > 0 ? `${enabledSkills.length}/${group.skills.length}` : '+';
    // 可见文字必须出现在可访问名里，否则语音控制用户念不出这个按钮。
    const enableAllLabel = enabledSkills.length > 0
      ? `已启用 ${enabledSkills.length}/${group.skills.length}，批量启用该库其余 skill`
      : '批量启用该库全部 skill';
    enableAllButton.title = enableAllLabel;
    enableAllButton.setAttribute('aria-label', enableAllLabel);
    if (enabledSkills.length === group.skills.length) enableAllButton.classList.add('is-complete');
    enableAllButton.addEventListener('click', () => enableGroup(group));
    const disableAllButton = groupElement.querySelector('.group-disable-all');
    disableAllButton.disabled = enabledSkills.length === 0;
    disableAllButton.dataset.focusKey = `group-disable:${group.key}`;
    disableAllButton.addEventListener('click', () => disableGroup(group));

    const items = groupElement.querySelector('.group-items');
    group.skills.forEach((skill) => items.append(renderSkill(skill, enabledTargets)));
    elements.skillList.append(groupElement);
  });
}

function hasActiveFilter() {
  return Boolean(state.searchQuery || state.activeTag || elements.sourceFilter.value);
}

function filterSignature() {
  return JSON.stringify([elements.sourceFilter.value, state.searchQuery, state.activeTag]);
}

function describeActiveFilter() {
  const parts = [];
  if (state.searchQuery) parts.push(`搜索「${elements.skillSearch.value.trim()}」`);
  if (elements.sourceFilter.value) parts.push(`来源 ${elements.sourceFilter.value}`);
  if (state.activeTag) parts.push(`标签 ${state.activeTag}`);
  return parts.join(' · ');
}

function libraryEmpty() {
  return emptyState('还没有 skill 原件', '把 skill 目录放入 official、github 或 personal，然后点右上角刷新。');
}

function filteredEmpty() {
  const element = emptyState(
    '没有匹配的 skill',
    `当前筛选：${describeActiveFilter()}。库里共有 ${state.stats.total} 个 skill。`
  );

  const button = document.createElement('button');
  button.className = 'secondary empty-action';
  button.type = 'button';
  button.textContent = '清除筛选条件';
  button.dataset.focusKey = 'clear-filters';
  button.addEventListener('click', clearFilters);
  element.append(button);

  return element;
}

function clearFilters() {
  elements.sourceFilter.value = '';
  elements.skillSearch.value = '';
  state.searchQuery = '';
  state.activeTag = '';
  render();
  elements.skillSearch.focus();
}

// 分组默认折叠可以压住 30 个库的长度，但筛选结果同样折叠时，
// 用户只看到一排组标题，会把「命中藏在折叠分组里」误读成「没搜到」。
// 因此筛选条件一变就展开全部命中分组；条件不变时仍尊重用户的手动折叠。
let lastFilterSignature = '';
let filterExpandedGroups = new Set();

function initializeCollapsedGroups(groups) {
  const signature = filterSignature();
  if (signature === lastFilterSignature) {
    groups.forEach((group) => collapseNewGroup(group.key));
    return;
  }

  lastFilterSignature = signature;
  filterExpandedGroups.forEach((key) => state.collapsedGroups.add(key));
  filterExpandedGroups = new Set();

  if (!hasActiveFilter()) {
    groups.forEach((group) => collapseNewGroup(group.key));
    return;
  }

  groups.forEach((group) => {
    const wasCollapsed = state.collapsedGroups.has(group.key) || !state.knownGroups.has(group.key);
    collapseNewGroup(group.key);
    if (!wasCollapsed) return;
    state.collapsedGroups.delete(group.key);
    filterExpandedGroups.add(group.key);
  });
}

function collapseNewGroup(key) {
  if (state.knownGroups.has(key)) return;
  state.knownGroups.add(key); state.collapsedGroups.add(key);
}

function renderSkill(skill, enabledTargets) {
    const isEnabled = enabledTargets.has(skill.path);
    const item = document.createElement('article');
    item.className = 'skill';
    item.dataset.focusScope = '';
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
    editButton.type = 'button';
    editButton.dataset.focusKey = `skill-edit:${skill.id}`;
    editButton.textContent = state.editingSkillId === skill.id ? '收起备注' : '编辑备注';
    editButton.addEventListener('click', () => {
      state.editingSkillId = state.editingSkillId === skill.id ? '' : skill.id;
      renderSkills();
    });
    actions.append(editButton);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.focusKey = `skill-enable:${skill.id}`;
    button.textContent = isEnabled ? '已启用' : '启用 agents skill';
    if (isEnabled) {
      // 已启用是状态而非禁用：用 aria-disabled 保留可聚焦性，
      // 键盘和读屏用户才能停在这里听到「已启用」。
      button.classList.add('is-enabled');
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.disabled = skill.source === 'archived';
    }
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      enable(skill);
    });
    actions.append(button);

    return item;
}

function renderTagTabs() {
  const tags = [...new Set(state.skills.flatMap((skill) => skill.tags || []))].sort((left, right) => left.localeCompare(right));
  elements.tagTabs.replaceChildren();
  if (tags.length === 0) return;

  const allButton = tagTabButton('全部标签', state.activeTag === '', 'tag:');
  allButton.addEventListener('click', () => {
    state.activeTag = '';
    render();
  });
  elements.tagTabs.append(allButton);

  tags.forEach((tag) => {
    const button = tagTabButton(tag, state.activeTag === tag, `tag:${tag}`);
    button.addEventListener('click', () => {
      state.activeTag = tag;
      render();
    });
    elements.tagTabs.append(button);
  });
}

function tagTabButton(text, isActive, focusKey) {
  const button = document.createElement('button');
  button.className = `category-tab${isActive ? ' is-active' : ''}`;
  button.type = 'button';
  button.textContent = text;
  button.dataset.focusKey = focusKey;
  // 选中状态此前只有背景色，读屏用户听不出当前过滤在哪一项。
  button.setAttribute('aria-pressed', String(isActive));
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
  badge.textContent = '不参与批量启用';
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
      <span>参与库级批量启用</span>
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

function matchesSearchQuery(skill, query) {
  const name = (skill.name || '').toLowerCase();
  const description = (skill.description || '').toLowerCase();
  const tags = (skill.tags || []).join(' ').toLowerCase();
  return name.includes(query) || description.includes(query) || tags.includes(query);
}

function toggleGroup(key) {
  state.collapsedGroups.has(key) ? state.collapsedGroups.delete(key) : state.collapsedGroups.add(key);
  renderSkills();
}

async function enable(skill) {
  if (!confirmSetupPreflight([skill.id])) return;
  const result = await api('/api/enable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, skillPath: skill.path, alias: skill.name }
  });
  setMessage(enableMessage(skill.name, result));
  await loadState({ button: null });
}

async function enableGroup(group) {
  const plan = await api('/api/enable-plan', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, skillIds: group.skills.map((skill) => skill.id) }
  });
  const skills = plan.targetSkillIds.map((skillId) => state.skills.find((skill) => skill.id === skillId)).filter(Boolean);
  const skipped = plan.skippedSkillIds;
  const pendingSetups = plan.setups;

  if (skills.length === 0) {
    setMessage(skipped.length ? `${group.collection} 没有需要启用的 skill，已跳过 ${skipped.length} 个不参与批量启用` : `${group.collection} 没有需要启用的 skill`);
    return;
  }

  if (pendingSetups.length > 0 && !confirmSetupPreflight(skills.map((skill) => skill.id))) return;

  const result = await api('/api/enable-collection', {
    method: 'POST',
    body: {
      projectPath: elements.projectPath.value,
      skillIds: group.skills.map((skill) => skill.id)
    }
  });

  const parts = [`已处理 ${group.collection}`];
  if (result.counts.enabled) parts.push(`启用 ${result.counts.enabled}`);
  if (result.counts.unchanged) parts.push(`已存在 ${result.counts.unchanged}`);
  if (result.counts.skipped) parts.push(`跳过 ${result.counts.skipped}`);
  if (result.counts.failed) parts.push(`失败 ${result.counts.failed}`);
  await loadState({ button: null });
  const refreshedSetups = result.refresh.ok ? result.setups : pendingSetups;
  const remainingSetups = refreshedSetups.filter((setup) => setup.status !== 'ready');
  if (remainingSetups.length > 0) parts.push(`待配置：${remainingSetups.map((setup) => setup.setupSkillName).join('、')}`);
  if (!result.refresh.ok) parts.push(`配置提醒刷新失败：${result.refresh.error}`);
  setMessage(parts.join('，'), result.counts.failed > 0 || !result.refresh.ok);
}

function findCollectionSetup(source, collection) {
  return (state.setups || []).find((setup) => setup.id === `${source}/${collection}`);
}

function findSetupsForSkillIds(skillIds) {
  const candidates = new Set(skillIds);
  return (state.setups || []).filter((setup) =>
    setup.status !== 'invalid' && setup.applicableSkillIds.some((skillId) => candidates.has(skillId))
  );
}

function confirmSetupPreflight(skillIds) {
  const setups = findSetupsForSkillIds(skillIds).filter((setup) => setup.status !== 'ready');
  if (setups.length === 0) return true;
  const detail = setups.map((setup) => {
    const status = setup.status === 'partial' ? '配置不完整' : '尚未配置';
    return `${setup.id}：${status}\n初始化 skill：${setup.setupSkillName}\n缺少：${setup.missingArtifacts.join('、')}`;
  }).join('\n\n');
  return window.confirm(`${detail}\n\n可以先启用，但完成配置前不能视为已就绪。启用后请在 Agent 中运行初始化 skill。`);
}

function setupStatusLabel(setup) {
  if (setup.status === 'missing') return setup.affectedEnabledSkillIds.length > 0 ? '待配置' : '需初始化';
  return { partial: '配置不完整', ready: '已就绪', invalid: '配置无效' }[setup.status] || setup.status;
}

function setupTooltip(setup) {
  const tooltips = {
    missing: '尚未配置，启用后需运行初始化 skill',
    partial: '仅完成部分配置，请运行初始化 skill',
    ready: '已完成初始化配置',
    invalid: '配置定义无效，请检查 collection-metadata 文件'
  };
  return tooltips[setup.status] || '';
}

function findSourceInfo(groupKey) {
  return state.sources.find((source) => source.installPath === groupKey);
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
    setMessage(`${group.collection} 没有可清空的 agents skill`);
    return;
  }

  if (!confirmBulkClear(`清空 ${group.collection} 的 ${aliases.length} 个 skill？`, aliases.length)) return;

  let removed = 0;
  let claudeRemoved = 0;
  let unchanged = 0;
  const failed = [];

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
      failed.push(alias);
    }
  }

  const parts = [`已清空 ${group.collection}`];
  if (removed) parts.push(`${removed} 个 agents skill`);
  if (claudeRemoved) parts.push(`${claudeRemoved} 个 Claude Code skill`);
  if (unchanged) parts.push(`已不存在 ${unchanged}`);
  // 只报失败个数的话，用户既不知道是哪些，也无从判断该重试还是手工处理。
  if (failed.length) parts.push(`以下 ${failed.length} 个未能清空，可单独重试：${failed.join('、')}`);
  setMessage(parts.join('，'), failed.length > 0);
  await loadState({ button: null });
}

// 批量清空会一次性删掉多个软链接，且没有撤销入口，因此先复述后果再执行。
function confirmBulkClear(question, count) {
  return window.confirm(`${question}\n\n将移除 ${count} 个软链接。skill 原件不受影响，之后可以重新启用。`);
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
    return `已启用 ${skillName}；Claude Code 自动同步失败：${result.claudeSync.error}。可点 Claude Code 栏的 + 手动同步。`;
  }

  return result.claudeSync ? `已启用 ${skillName}，并同步 Claude Code` : `已启用 ${skillName}`;
}

async function disable(alias) {
  await api('/api/disable', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已从 .agents/skills 移除 ${alias}`);
  await loadState({ button: null });
}

async function disableAgents() {
  const aliases = state.enabled.filter((skill) => skill.isSymlink).map((skill) => skill.alias);
  if (aliases.length === 0) {
    setMessage('没有可清空的 agents skill');
    return;
  }

  if (!confirmBulkClear(`清空 .agents/skills 里全部 ${aliases.length} 个 skill？`, aliases.length)) return;

  await withButtonState(elements.disableAgents, '…', async () => {
    await Promise.all(aliases.map((alias) => api('/api/disable', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value, alias }
    })));
    setMessage(`已清空 ${aliases.length} 个 agents skill`);
    await loadState({ button: null });
  });
}

async function syncClaude() {
  await withButtonState(elements.syncClaude, '…', async () => {
    const result = await api('/api/sync-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(`已同步到 Claude Code：${result.targetPath}`);
    await loadState({ button: null });
    await flashButton(elements.syncClaude, '✓');
  });
}

async function unlinkClaude() {
  const count = state.claude?.skills?.length || 0;
  if (count === 0) {
    setMessage('Claude Code 当前未启用 skill 入口');
    return;
  }

  if (!confirmBulkClear(`清空 Claude Code 里全部 ${count} 个 skill 入口？`, count)) return;

  // 圆形图标按钮宽 36px：多字文案会冲出边界，忙碌与完成态只用字形，
  // 具体结果交给下方的消息区。
  await withButtonState(elements.unlinkClaude, '…', async () => {
    const result = await api('/api/unlink-claude', {
      method: 'POST',
      body: { projectPath: elements.projectPath.value }
    });
    setMessage(result.removed ? `已清空 Claude Code 的 ${count} 个 skill 入口` : 'Claude Code 当前未启用 skill 入口');
    await loadState({ button: null });
    await flashButton(elements.unlinkClaude, '✓');
  });
}

async function unlinkClaudeSkill(alias) {
  await api('/api/unlink-claude-skill', {
    method: 'POST',
    body: { projectPath: elements.projectPath.value, alias }
  });
  setMessage(`已从 Claude Code 移除 ${alias}`);
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
    setMessage(payload.error || '请求失败。请确认 skillcaddy 服务仍在运行，然后重试。', true);
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

// 成功走 role="status"，失败走 role="alert"：失败此前和成功共用礼貌区域，
// 可能被排在队列后面才读到。写入一侧必须清空另一侧，否则会读出陈旧内容。
function setMessage(text, isError = false) {
  const target = isError ? elements.errorMessage : elements.message;
  const other = isError ? elements.message : elements.errorMessage;
  other.textContent = '';
  target.textContent = text;
}

// DOM 全量重建会把焦点掉回 <body>：键盘用户每展开一个分组、启用一个 skill，
// 都得从页首重新 Tab。渲染前记下焦点控件的稳定标识，渲染后再找回来。
let isRestoringFocus = false;

function withPreservedFocus(task) {
  if (isRestoringFocus) {
    task();
    return;
  }

  const focusKey = document.activeElement?.dataset?.focusKey || '';
  isRestoringFocus = true;
  try {
    task();
  } finally {
    isRestoringFocus = false;
  }

  restoreFocus(focusKey);
}

function restoreFocus(focusKey) {
  if (!focusKey) return;

  const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  if (!target) return;

  if (!target.disabled) {
    target.focus();
    return;
  }

  // 控件因这次操作变为不可用时，退到同一张卡片里第一个还能用的控件，
  // 而不是把焦点丢回页首。
  target.closest('[data-focus-scope]')?.querySelector('button:not(:disabled)')?.focus();
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
