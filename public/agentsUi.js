import { emptyState } from './emptyState.js';

export function renderAgentsSkills({ enabled, skills, elements, onDisable, scope = 'project', isPreview = false }) {
  const config = scopeConfig(scope, elements);
  const list = config.list;
  const clearButton = config.clearButton;
  clearButton.disabled = isPreview && config.previewOnly ? true : !enabled.some((skill) => skill.canDisable ?? skill.isSymlink);
  if (isPreview && config.previewOnly) {
    clearButton.title = '预览模式只读：先在下方读取你自己的项目再操作';
  }
  list.replaceChildren();
  if (enabled.length === 0) {
    list.append(emptyState(
      config.emptyTitle,
      config.emptyDetail
    ));
    return;
  }

  enabled.forEach((skill) => {
    const item = document.createElement('article');
    item.className = 'enabled';
    item.dataset.focusScope = '';
    item.innerHTML = `
      <div>
        <div class="enabled-head">
          <strong class="name"></strong>
          <span class="tag-pill enabled-source"></span>
        </div>
        <p class="path"></p>
      </div>
      <div class="actions"></div>
    `;
    item.querySelector('.name').textContent = skill.alias;
    item.querySelector('.path').textContent = skill.targetPath || skill.linkPath;

    const sourceSkill = skills.find((s) => s.path === skill.targetPath);
    const sourceChip = item.querySelector('.enabled-source');
    if (sourceSkill) {
      // 同名 skill 可能来自多个来源：alias 旁标注来源，否则两行同名条目无法区分。
      sourceChip.textContent = sourceSkill.source;
      sourceChip.title = `${sourceSkill.collection} 来源`;
    } else {
      sourceChip.hidden = true;
    }
    if (sourceSkill) {
      const description = sourceSkill.note || sourceSkill.description;
      if (description) item.title = description;
    }

    const button = document.createElement('button');
    button.className = 'secondary danger';
    button.type = 'button';
    // 单条用「移除」，只有整栏批量才叫「清空」：此前两者共用一个词，
    // 光看标签分不出作用域。
    button.textContent = '移除';
    button.dataset.focusKey = `${config.key}-remove:${skill.alias}`;
    button.dataset.focusFallbackSelector = `${config.selector} [data-focus-key^="${config.key}-remove:"]:not(:disabled)`;
    button.dataset.focusFallbackKey = 'skill-search';
    button.setAttribute('aria-label', `从${config.label} ${config.directory} 移除 ${skill.alias}${sourceSkill ? `（${sourceSkill.source}）` : ''}`);
    button.disabled = isPreview && config.previewOnly ? true : !(skill.canDisable ?? skill.isSymlink);
    if (isPreview && config.previewOnly) {
      button.title = '预览模式只读：先在下方读取你自己的项目再操作';
    }
    button.addEventListener('click', () => onDisable(skill.alias));
    item.querySelector('.actions').append(button);
    list.append(item);
  });
}

function scopeConfig(scope, elements) {
  if (scope === 'global') {
    return {
      key: 'global',
      label: '全局',
      directory: '.agents/skills',
      list: elements.globalList,
      clearButton: elements.disableGlobal,
      selector: '#globalList',
      previewOnly: false,
      emptyTitle: '还没有全局 skill',
      emptyDetail: '在原件库中选择「启用到全局」，即可让所有项目使用。'
    };
  }
  if (scope === 'hermes') {
    return {
      key: 'hermes',
      label: 'Hermes',
      directory: '~/.hermes/skills',
      list: elements.hermesList,
      clearButton: elements.disableHermes,
      selector: '#hermesList',
      previewOnly: false,
      emptyTitle: '还没有 Hermes skill',
      emptyDetail: '在原件库中选择「启用到 Hermes」，只会管理 eligible 的 official/github/personal skill。'
    };
  }
  return {
    key: 'agents',
    label: '当前项目',
    directory: '.agents/skills',
    list: elements.enabledList,
    clearButton: elements.disableAgents,
    selector: '#enabledList',
    previewOnly: true,
    emptyTitle: '当前项目还没有启用 skill',
    emptyDetail: '在「Skill 原件库」里展开任意分组，点「启用 agents skill」即可加入这里。'
  };
}
