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
  hero: document.querySelector('.hero'),
  controlsForm: document.querySelector('#controlsForm'),
  projectPath: document.querySelector('#projectPath'),
  addProject: document.querySelector('#addProject'),
  projectHistory: document.querySelector('#projectHistory'),
  loadProject: document.querySelector('#loadProject'),
  refreshButton: document.querySelector('#refreshButton'),
  disableAgents: document.querySelector('#disableAgents'),
  disableGlobal: document.querySelector('#disableGlobal'),
  unlinkClaude: document.querySelector('#unlinkClaude'),
  syncClaude: document.querySelector('#syncClaude'),
  claudeSkillList: document.querySelector('#claudeSkillList'),
  totalSkills: document.querySelector('#totalSkills'),
  sourceFilter: document.querySelector('#sourceFilter'),
  skillSearch: document.querySelector('#skillSearch'),
  enabledList: document.querySelector('#enabledList'),
  globalList: document.querySelector('#globalList'),
  agentsCount: document.querySelector('#agentsCount'),
  globalCount: document.querySelector('#globalCount'),
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

// These module-level states must be initialized before the startup top-level
// await below can resume through loadState() -> render().
let lastFilterSignature = '';
let filterExpandedGroups = new Set();
let isRestoringFocus = false;
let messageTimer = null;
let searchDebounceTimer = null;
// 首访（无历史、URL 无项目参数）时服务端展示的是仓库默认状态：
// 标注为预览，避免用户把 skillcaddy 自带的 skill 当成「别人配好的项目」。
let isPreviewSession = false;

// 项目路径框在 form 里，Enter 走隐式提交；点「读取项目」也是同一条 submit 路径。
// 读取进行中按钮处于忙碌态，此时的重复提交（如连按 Enter）直接忽略。
elements.controlsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (elements.loadProject.disabled) return;
  isPreviewSession = false;
  // 用户开始读取自己的项目：hero 从此坍缩成状态带，不再占首屏。
  elements.hero.classList.add('is-compact');
  loadState({ feedback: true });
});
elements.addProject.addEventListener('click', addCurrentProject);
elements.refreshButton.addEventListener('click', () => loadState({ button: elements.refreshButton, feedback: true, label: '刷新' }));
elements.sourceFilter.addEventListener('change', render);
// 每个按键全量重建列表 DOM 在几百个 skill 时会卡顿，防抖到停顿后再渲染。
elements.skillSearch.addEventListener('input', (event) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.searchQuery = event.target.value.trim().toLowerCase();
    render();
  }, 120);
});
elements.unlinkClaude.addEventListener('click', unlinkClaude);
elements.syncClaude.addEventListener('click', syncClaude);
elements.disableAgents.addEventListener('click', disableAgents);
elements.disableGlobal.addEventListener('click', () => disableAgents('global'));

// 只做两个高频快捷键：/ 聚焦搜索，Esc 逐级清除（先清搜索词，再清全部筛选）。
// 输入控件内不劫持按键，避免与正常输入冲突。
document.addEventListener('keydown', (event) => {
  const isEditable = Boolean(event.target.closest?.('input, textarea, select, [contenteditable="true"]'));

  if (event.key === '/' && !isEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    elements.skillSearch.focus();
    return;
  }

  if (event.key !== 'Escape') return;

  if (event.target === elements.skillSearch && elements.skillSearch.value) {
    clearTimeout(searchDebounceTimer);
    elements.skillSearch.value = '';
    state.searchQuery = '';
    render();
    return;
  }

  // 第一下 Esc 清掉搜索词后焦点仍在搜索框：此时再按 Esc 必须继续清 tag/来源
  // 过滤，否则键盘用户（Sam）会卡在残留过滤里。搜索框因此不算 isEditable。
  const isSearchBox = event.target === elements.skillSearch;
  if ((!isEditable || isSearchBox) && hasActiveFilter()) clearFilters();
});

initializeProjectPathFromUrl();
initializeHeroState();
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
  elements.globalCount.textContent = state.global.length;
  elements.claudeCount.textContent = state.claude?.skills?.length || 0;
  elements.heroTotalSkills.textContent = state.stats.total;
  elements.heroAgentsCount.textContent = state.enabled.length;
  elements.heroClaudeCount.textContent = state.claude?.skills?.length || 0;
  elements.activeProject.textContent = isPreviewSession
    ? `默认预览：${state.projectPath || 'skillcaddy 仓库'}（在下方输入你的项目路径后点「读取项目」）`
    : state.projectPath || '等待读取项目路径';
  renderAgentsSkills({ enabled: state.enabled, skills: state.skills, elements, onDisable: disable, isPreview: isPreviewSession });
  renderAgentsSkills({ enabled: state.global, skills: state.skills, elements, onDisable: (alias) => disable(alias, 'global'), scope: 'global' });
  renderClaudeStatus({ claude: state.claude, skills: state.skills, elements, onUnlink: unlinkClaudeSkill, isPreview: isPreviewSession });
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
    removeButton.dataset.focusFallbackSelector = '#projectHistory .project-chip-remove';
    removeButton.dataset.focusFallbackKey = 'project-path';
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
  withPreservedFocus(renderProjectHistory);
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

// loadState 会把服务端回退的 rootDir 写进历史，因此不能用会话中的状态判断
// 「首次访客」，只能看启动瞬间：有历史或 URL 带项目的是老用户，hero 坍缩成
// 状态带；两者皆无的首次访客保留完整 hero 一整个会话。
function initializeHeroState() {
  const hasProjectParam = new URLSearchParams(window.location.search).has('projectPath');
  const isReturningUser = state.projectHistory.length > 0 || hasProjectParam;
  isPreviewSession = !isReturningUser;
  elements.hero.classList.toggle('is-compact', isReturningUser);
}

function syncProjectPathToUrl(projectPath) {
  const url = new URL(window.location.href);
  url.searchParams.set('projectPath', projectPath);
  window.history.replaceState({}, '', url);
}

function renderAdvice() {
  elements.adviceList.replaceChildren();
  if (!state.advice || state.advice.length === 0) return;

  // 服务端最多生成 8 条（skillStore 6 + collectionSetup 2），全部渲染；
  // 此前 slice(0, 6) 会让第 7、8 条建议静默消失。
  state.advice.forEach((advice, index) => {
    const item = document.createElement('article');
    item.className = `advice ${advice.severity || 'info'}`;
    item.innerHTML = `
      <div>
        <strong></strong>
        <p></p>
      </div>
      <div class="advice-aside">
        <span class="advice-severity"></span>
        <span class="advice-type"></span>
      </div>
    `;
    item.querySelector('strong').textContent = advice.title;
    item.querySelector('p').textContent = advice.detail;
    // 严重级别必须有文字表达，不能只靠颜色区分。
    item.querySelector('.advice-severity').textContent = advice.severity === 'warning' ? '注意' : '提示';
    item.querySelector('.advice-type').textContent = advice.type;
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
  const globalByTarget = new Map(state.global.filter((item) => item.isSymlink && item.targetPath).map((item) => [item.targetPath, item]));
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
          <span class="badge"></span>
          <div class="group-actions">
            <div class="scope-action-group project-scope-actions">
              <span class="scope-label">项目</span>
              <button class="icon-button group-enable-all" type="button">+</button>
              <button class="icon-button group-disable-all danger" type="button" title="清空该库已启用的 skill" aria-label="清空该库已启用的 skill">×</button>
            </div>
            <span class="scope-divider" aria-hidden="true"></span>
            <div class="scope-action-group global-scope-actions">
              <span class="scope-label">全局</span>
              <button class="icon-button group-enable-global" type="button" title="批量启用到全局">+</button>
              <button class="icon-button group-disable-global danger" type="button" title="清空该库的全局 skill" aria-label="清空该库的全局 skill">×</button>
            </div>
          </div>
          <p></p>
        </div>
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
    const globalEnableButton = groupElement.querySelector('.group-enable-global');
    const globalPendingSkills = group.skills.filter((skill) => canBulkEnableSkill(skill, new Set(globalByTarget.keys())));
    const globalEnabledSkills = group.skills.filter((skill) => globalByTarget.has(skill.path));
    const removableGlobalSkills = group.skills.filter((skill) => (globalByTarget.get(skill.path)?.canDisable ?? false));
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
    enableAllButton.addEventListener('click', () => enableGroup(group, 'project', enableAllButton));
    globalEnableButton.disabled = globalPendingSkills.length === 0;
    globalEnableButton.dataset.focusKey = `group-enable-global:${group.key}`;
    // 与项目 + 保持一致：有已全局启用时显示进度计数，否则显示 +。
    globalEnableButton.textContent = globalEnabledSkills.length > 0 ? `${globalEnabledSkills.length}/${group.skills.length}` : '+';
    const globalEnableLabel = globalEnabledSkills.length > 0
      ? `已全局启用 ${globalEnabledSkills.length}/${group.skills.length}，批量启用该库其余 skill 到全局`
      : '批量启用该库全部 skill 到全局';
    globalEnableButton.title = globalEnableLabel;
    globalEnableButton.setAttribute('aria-label', globalEnableLabel);
    if (globalEnabledSkills.length === group.skills.length) globalEnableButton.classList.add('is-complete');
    globalEnableButton.addEventListener('click', () => enableGroup(group, 'global', globalEnableButton));
    const disableAllButton = groupElement.querySelector('.group-disable-all');
    disableAllButton.disabled = enabledSkills.length === 0;
    disableAllButton.dataset.focusKey = `group-disable:${group.key}`;
    disableAllButton.addEventListener('click', () => disableGroup(group, 'project', disableAllButton));
    const globalDisableButton = groupElement.querySelector('.group-disable-global');
    globalDisableButton.disabled = removableGlobalSkills.length === 0;
    globalDisableButton.dataset.focusKey = `group-disable-global:${group.key}`;
    globalDisableButton.addEventListener('click', () => disableGroup(group, 'global', globalDisableButton));

    const items = groupElement.querySelector('.group-items');
    group.skills.forEach((skill) => items.append(renderSkill(skill, enabledTargets, new Set(globalByTarget.keys()))));
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
  clearTimeout(searchDebounceTimer);
  elements.sourceFilter.value = '';
  elements.skillSearch.value = '';
  state.searchQuery = '';
  state.activeTag = '';
  render();
  elements.skillSearch.focus();
}

// 分组默认折叠可以压住 30 个库的长度，但筛选结果同样折叠时，
// 用户只看到一排组标题，会把「命中藏在折叠分组里」误读成「没搜到」。
// 因此带任何筛选（搜索词、标签、来源）时展开全部命中分组；无筛选时
// 默认折叠成列表，由用户按需展开自己要看的分组。
function initializeCollapsedGroups(groups) {
  const signature = filterSignature();
  if (signature === lastFilterSignature) {
    groups.forEach((group) => collapseNewGroup(group.key));
    return;
  }

  lastFilterSignature = signature;
  filterExpandedGroups.forEach((key) => state.collapsedGroups.add(key));
  filterExpandedGroups = new Set();

  if (!state.searchQuery && !state.activeTag && !elements.sourceFilter.value) {
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

function renderSkill(skill, enabledTargets, globalTargets = new Set()) {
    const isEnabled = enabledTargets.has(skill.path);
    const isGloballyEnabled = globalTargets.has(skill.path);
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
    const noteElement = item.querySelector('.note');
    if (skill.note) {
      noteElement.textContent = skill.note;
    } else {
      // 无备注时整行不渲染：171 行里 86 行是「未填写备注」空占位，没有信息量。
      noteElement.remove();
    }
    item.querySelector('.meta').textContent = skill.description || (skill.hasSkillFile ? '未填写 description' : '缺少 SKILL.md');
    item.querySelector('.path').textContent = skill.path;
    if (state.editingSkillId === skill.id) renderMetadataEditor(item.querySelector('.metadata-editor'), skill);

    const actions = item.querySelector('.actions');
    const projectActions = document.createElement('div');
    projectActions.className = 'scope-action-group project-scope-actions';    const globalActions = document.createElement('div');
    globalActions.className = 'scope-action-group global-scope-actions';
    const scopeDivider = document.createElement('span');
    scopeDivider.className = 'scope-divider';
    scopeDivider.setAttribute('aria-hidden', 'true');
    const editButton = document.createElement('button');
    editButton.className = 'secondary';
    editButton.type = 'button';
    editButton.dataset.focusKey = `skill-edit:${skill.id}`;
    editButton.textContent = state.editingSkillId === skill.id ? '收起备注' : '编辑备注';
    editButton.addEventListener('click', () => {
      state.editingSkillId = state.editingSkillId === skill.id ? '' : skill.id;
      renderSkills();
      // withPreservedFocus 会把焦点送回重渲染后的编辑按钮；
      // 打开表单时必须再显式送进 textarea，否则键盘用户 Tab 会从编辑按钮
      // 直接跳到下一行（WCAG 2.4.3 焦点顺序）。
      if (state.editingSkillId === skill.id) {
        document.querySelector(`[data-focus-key="skill-note:${skill.id}"]`)?.focus();
      }
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.focusKey = `skill-enable:${skill.id}`;
    button.textContent = isEnabled ? '已启用' : '启用 agents skill';
    // 无理由的灰按钮会让用户反复尝试后放弃：禁用必须给出原因和解法。
    const archivedReason = 'archived 来源不参与启用；如需使用，请先把 skill 目录移回 official、github 或 personal';
    if (isEnabled) {
      // 已启用是状态而非禁用：用 aria-disabled 保留可聚焦性，
      // 键盘和读屏用户才能停在这里听到「已启用」。
      button.classList.add('is-enabled');
      button.setAttribute('aria-disabled', 'true');
    } else if (skill.source === 'archived') {
      button.disabled = true;
      button.title = archivedReason;
      button.setAttribute('aria-label', `启用 agents skill（不可用）：${archivedReason}`);
    }
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      enable(skill);
    });
    projectActions.append(editButton, button);

    const globalButton = document.createElement('button');
    globalButton.type = 'button';
    globalButton.dataset.focusKey = `skill-enable-global:${skill.id}`;
    globalButton.textContent = isGloballyEnabled ? '已全局启用' : '启用到全局';
    if (isGloballyEnabled) {
      globalButton.classList.add('is-enabled');
      globalButton.setAttribute('aria-disabled', 'true');
    } else if (skill.source === 'archived') {
      globalButton.disabled = true;
      globalButton.title = archivedReason;
      globalButton.setAttribute('aria-label', `启用到全局（不可用）：${archivedReason}`);
    }
    globalButton.addEventListener('click', () => {
      if (globalButton.getAttribute('aria-disabled') === 'true') return;
      enable(skill, 'global');
    });
    globalActions.append(globalButton);
    actions.append(projectActions, scopeDivider, globalActions);

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

  // roving tabindex：26 个标签此前全部在 Tab 序里，键盘用户到第一个启用
  // 按钮要按 100+ 次 Tab；改为单一停靠点 + 方向键在标签间移动。
  elements.tagTabs.querySelectorAll('.category-tab').forEach((button) => {
    button.tabIndex = button.classList.contains('is-active') ? 0 : -1;
  });
}

// 方向键在标签间移动（roving tabindex），Home/End 跳首尾。
// 绑定一次即可：按钮每次重建，容器与委托逻辑不变。
elements.tagTabs.addEventListener('keydown', (event) => {
  const current = event.target.closest('.category-tab');
  if (!current) return;

  const tabs = [...elements.tagTabs.querySelectorAll('.category-tab')];
  const index = tabs.indexOf(current);
  if (index === -1) return;

  let nextIndex = -1;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else return;

  event.preventDefault();
  tabs.forEach((button) => { button.tabIndex = -1; });
  tabs[nextIndex].tabIndex = 0;
  tabs[nextIndex].focus();
});

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

  form.elements.note.dataset.focusKey = `skill-note:${skill.id}`;
  form.elements.note.dataset.focusFallbackKey = `skill-edit:${skill.id}`;
  form.elements.tags.dataset.focusKey = `skill-tags:${skill.id}`;
  form.elements.tags.dataset.focusFallbackKey = `skill-edit:${skill.id}`;
  form.elements.autoEnable.dataset.focusKey = `skill-auto-enable:${skill.id}`;
  form.elements.autoEnable.dataset.focusFallbackKey = `skill-edit:${skill.id}`;
  form.querySelector('button[type="submit"]').dataset.focusKey = `skill-save:${skill.id}`;
  form.querySelector('button[type="submit"]').dataset.focusFallbackKey = `skill-edit:${skill.id}`;
  form.querySelector('button[type="button"]').dataset.focusKey = `skill-cancel:${skill.id}`;
  form.querySelector('button[type="button"]').dataset.focusFallbackKey = `skill-edit:${skill.id}`;

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

async function enable(skill, scope = 'project') {
  if (scope === 'project' && !confirmSetupPreflight([skill.id])) return;
  const result = await api('/api/enable', {
    method: 'POST',
    body: {
      scope,
      ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
      skillPath: skill.path,
      alias: skill.name
    }
  });
  setMessage(enableMessage(skill.name, result, scope));
  await loadState({ button: null });
}

async function enableGroup(group, scope = 'project', button = null) {
  const plan = await api('/api/enable-plan', {
    method: 'POST',
    body: {
      scope,
      ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
      skillIds: group.skills.map((skill) => skill.id)
    }
  });
  const skills = plan.targetSkillIds.map((skillId) => state.skills.find((skill) => skill.id === skillId)).filter(Boolean);
  const skipped = plan.skippedSkillIds;
  const pendingSetups = plan.setups;

  if (skills.length === 0) {
    setMessage(skipped.length ? `${group.collection} 没有需要启用的 skill，已跳过 ${skipped.length} 个不参与批量启用` : `${group.collection} 没有需要启用的 skill`);
    return;
  }

  if (scope === 'project' && pendingSetups.length > 0 && !confirmSetupPreflight(skills.map((skill) => skill.id))) return;

  // 圆形图标按钮容不下多字文案，忙碌态只用省略号，结果交给 toast。
  const run = async () => {
    const result = await api('/api/enable-collection', {
      method: 'POST',
      body: {
        scope,
        ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
        skillIds: group.skills.map((skill) => skill.id)
      }
    });

    const parts = [`已处理 ${group.collection}`];
    if (result.counts.enabled) parts.push(`启用 ${result.counts.enabled}`);
    if (result.counts.unchanged) parts.push(`已存在 ${result.counts.unchanged}`);
    if (result.counts.skipped) parts.push(`跳过 ${result.counts.skipped}`);
    if (result.counts.failed) {
      const failedAliases = (result.outcomes || [])
        .filter((outcome) => outcome.status === 'failed')
        .map((outcome) => outcome.alias)
        .filter(Boolean);
      parts.push(failedAliases.length
        ? `以下 ${failedAliases.length} 个未能启用，可单独重试：${failedAliases.join('、')}`
        : `失败 ${result.counts.failed}`);
    }
    await loadState({ button: null });
    const refreshedSetups = result.refresh.ok ? result.setups : pendingSetups;
    const remainingSetups = refreshedSetups.filter((setup) => setup.status !== 'ready');
    if (scope === 'project' && remainingSetups.length > 0) parts.push(`待配置：${remainingSetups.map((setup) => setup.setupSkillName).join('、')}`);
    if (!result.refresh.ok) parts.push(`配置提醒刷新失败：${result.refresh.error}`);
    setMessage(parts.join('，'), result.counts.failed > 0 || !result.refresh.ok);
  };

  button ? await withButtonState(button, '…', run) : await run();
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

// 串行 2N 次往返会让 20 个 skill 的清空静止十几秒；全并发又可能瞬间打满本地
// 服务。固定小并发消费队列，调用方在 worker 里自行捕获错误并驱动进度提示。
const BULK_CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await worker(queue.shift());
    }
  });
  await Promise.all(runners);
}

async function disableGroup(group, scope = 'project', button = null) {
  const enabledItems = scope === 'global' ? state.global : state.enabled;
  const enabledByTarget = new Map(enabledItems.filter((item) => (item.canDisable ?? item.isSymlink) && item.targetPath).map((item) => [item.targetPath, item]));
  const aliases = group.skills
    .map((skill) => enabledByTarget.get(skill.path)?.alias)
    .filter(Boolean);

  if (aliases.length === 0) {
    setMessage(`${group.collection} 没有可清空的${scope === 'global' ? '全局' : ' agents'} skill`);
    return;
  }

  if (!confirmBulkClear(`清空 ${group.collection} 的 ${aliases.length} 个 skill？`, aliases.length)) return;

  const run = async () => {
    let removed = 0;
    let claudeRemoved = 0;
    let unchanged = 0;
    let settled = 0;
    const failed = [];

    await mapWithConcurrency(aliases, BULK_CONCURRENCY, async (alias) => {
      try {
        const result = await api('/api/disable', {
          method: 'POST',
          body: {
            scope,
            ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
            alias
          }
        });
        result.removed ? removed += 1 : unchanged += 1;

        if (scope === 'project') {
          const claudeResult = await api('/api/unlink-claude-skill', {
            method: 'POST',
            body: { projectPath: elements.projectPath.value, alias }
          });
          if (claudeResult.removed) claudeRemoved += 1;
        }
      } catch {
        failed.push(alias);
      } finally {
        settled += 1;
        setMessage(`清空 ${group.collection} 中：${settled}/${aliases.length}`);
      }
    });

    const parts = [`已清空${scope === 'global' ? '全局 ' : ' '}${group.collection}`];
    if (removed) parts.push(`${removed} 个${scope === 'global' ? '全局' : 'agents'} skill`);
    if (claudeRemoved) parts.push(`${claudeRemoved} 个 Claude Code skill`);
    if (unchanged) parts.push(`已不存在 ${unchanged}`);
    // 只报失败个数的话，用户既不知道是哪些，也无从判断该重试还是手工处理。
    if (failed.length) parts.push(`以下 ${failed.length} 个未能清空，可单独重试：${failed.join('、')}`);
    setMessage(parts.join('，'), failed.length > 0);
    await loadState({ button: null });
  };

  button ? await withButtonState(button, '…', run) : await run();
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

function enableMessage(skillName, result, scope = 'project') {
  if (result.claudeSync?.ok === false) {
    return `已启用 ${skillName}；Claude Code 自动同步失败：${result.claudeSync.error}。可点 Claude Code 栏的 + 手动同步。`;
  }

  return result.claudeSync
    ? `已启用 ${skillName}，并同步 Claude Code`
    : `${scope === 'global' ? '已全局启用' : '已启用'} ${skillName}`;
}

async function disable(alias, scope = 'project') {
  if (isPreviewSession && scope === 'project') {
    setMessage('预览模式只读：先在下方读取你自己的项目再操作', true);
    return;
  }
  await api('/api/disable', {
    method: 'POST',
    body: {
      scope,
      ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
      alias
    }
  });
  setMessage(`已从${scope === 'global' ? '全局' : '当前项目'} .agents/skills 移除 ${alias}`);
  await loadState({ button: null });
}

async function disableAgents(scope = 'project') {
  const enabledItems = scope === 'global' ? state.global : state.enabled;
  const aliases = enabledItems.filter((skill) => skill.canDisable ?? skill.isSymlink).map((skill) => skill.alias);
  if (aliases.length === 0) {
    setMessage(`没有可清空的${scope === 'global' ? '全局' : ' agents'} skill`);
    return;
  }

  if (isPreviewSession && scope === 'project') {
    setMessage('预览模式只读：先在下方读取你自己的项目再操作', true);
    return;
  }

  if (!confirmBulkClear(`清空 .agents/skills 里全部 ${aliases.length} 个 skill？`, aliases.length)) return;

  const clearButton = scope === 'global' ? elements.disableGlobal : elements.disableAgents;
  await withButtonState(clearButton, '…', async () => {
    const results = await Promise.allSettled(aliases.map((alias) => api('/api/disable', {
      method: 'POST',
      body: {
        scope,
        ...(scope === 'project' ? { projectPath: elements.projectPath.value } : {}),
        alias
      }
    })));
    const failed = results
      .map((result, index) => result.status === 'rejected' ? aliases[index] : null)
      .filter(Boolean);
    const removed = aliases.length - failed.length;
    const message = [`已清空 ${removed} 个${scope === 'global' ? '全局' : 'agents'} skill`];
    if (failed.length) message.push(`以下 ${failed.length} 个未能清空，可单独重试：${failed.join('、')}`);
    setMessage(message.join('，'), failed.length > 0);
    await loadState({ button: null });
  }, () => (scope === 'global' ? state.global : state.enabled).filter((skill) => skill.canDisable ?? skill.isSymlink).length === 0);
}

async function syncClaude() {
  if (isPreviewSession) {
    setMessage('预览模式只读：先在下方读取你自己的项目再操作', true);
    return;
  }
  await withButtonState(elements.syncClaude, '同步中', async () => {
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
  if (isPreviewSession) {
    setMessage('预览模式只读：先在下方读取你自己的项目再操作', true);
    return;
  }
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
  }, () => !state.claude || !state.claude.exists || state.claude.skills.length === 0);
}

async function unlinkClaudeSkill(alias) {
  if (isPreviewSession) {
    setMessage('预览模式只读：先在下方读取你自己的项目再操作', true);
    return;
  }
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
// toast 形态下成功确认读完即撤（按文案长度延时）；错误与失败清单需要用户
// 处理，常驻到下一条消息覆盖为止。
function setMessage(text, isError = false) {
  const target = isError ? elements.errorMessage : elements.message;
  const other = isError ? elements.message : elements.errorMessage;
  other.textContent = '';
  target.textContent = text;
  clearTimeout(messageTimer);
  if (!isError && text) {
    messageTimer = setTimeout(() => {
      elements.message.textContent = '';
    }, Math.min(8000 + text.length * 50, 20000));
  }
}

// DOM 全量重建会把焦点掉回 <body>：键盘用户每展开一个分组、启用一个 skill，
// 都得从页首重新 Tab。渲染前记下焦点控件的稳定标识，渲染后再找回来。
function withPreservedFocus(task) {
  if (isRestoringFocus) {
    task();
    return;
  }

  const focus = captureFocus();
  isRestoringFocus = true;
  try {
    task();
  } finally {
    isRestoringFocus = false;
    restoreFocus(focus);
  }
}

function captureFocus() {
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey || '';
  if (!focusKey) return null;

  const fallbackSelector = active.dataset.focusFallbackSelector || '';
  const fallbackCandidates = fallbackSelector ? [...document.querySelectorAll(fallbackSelector)] : [];
  return {
    focusKey,
    fallbackKey: active.dataset.focusFallbackKey || '',
    fallbackSelector,
    fallbackIndex: fallbackCandidates.indexOf(active)
  };
}

function restoreFocus(focus) {
  if (!focus?.focusKey) return;

  const target = document.querySelector(`[data-focus-key="${CSS.escape(focus.focusKey)}"]`);

  if (focusTarget(target)) {
    return;
  }

  if (target?.disabled) {
    const fallback = target.closest('[data-focus-scope]')?.querySelector('button:not(:disabled)');
    if (focusTarget(fallback)) return;
  }

  if (focus.fallbackSelector) {
    const candidates = [...document.querySelectorAll(focus.fallbackSelector)].filter((candidate) => !candidate.disabled);
    if (candidates.length > 0) {
      const index = Math.min(Math.max(focus.fallbackIndex, 0), candidates.length - 1);
      if (focusTarget(candidates[index])) return;
    }
  }

  if (focus.fallbackKey) {
    const fallback = document.querySelector(`[data-focus-key="${CSS.escape(focus.fallbackKey)}"]`);
    if (focusTarget(fallback)) return;
  }
}

function focusTarget(target) {
  if (!target || target.disabled) return false;
  target.focus();
  return true;
}

async function withButtonState(button, busyText, task, resolveDisabled = () => false) {
  const focus = captureFocus();
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await task();
  } finally {
    button.disabled = resolveDisabled();
    button.textContent = originalText;
    restoreFocus(focus);
  }
}

async function flashButton(button, text) {
  const originalText = button.textContent;
  button.textContent = text;
  await new Promise((resolve) => setTimeout(resolve, 700));
  button.textContent = originalText;
}
