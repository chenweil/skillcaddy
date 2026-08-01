import { emptyState } from './emptyState.js';

export function renderAgentsSkills({ enabled, skills, elements, onDisable }) {
  elements.disableAgents.disabled = !enabled.some((skill) => skill.isSymlink);
  elements.enabledList.replaceChildren();
  if (enabled.length === 0) {
    elements.enabledList.append(emptyState(
      '当前项目还没有启用 skill',
      '在右侧「Skill 原件库」里展开任意分组，点「启用 agents skill」即可加入这里。'
    ));
    return;
  }

  enabled.forEach((skill) => {
    const item = document.createElement('article');
    item.className = 'enabled';
    item.dataset.focusScope = '';
    item.innerHTML = `
      <div>
        <strong class="name"></strong>
        <p class="path"></p>
      </div>
      <div class="actions"></div>
    `;
    item.querySelector('.name').textContent = skill.alias;
    item.querySelector('.path').textContent = skill.targetPath || skill.linkPath;

    const sourceSkill = skills.find((s) => s.path === skill.targetPath);
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
    button.dataset.focusKey = `agents-remove:${skill.alias}`;
    button.dataset.focusFallbackSelector = '#enabledList [data-focus-key^="agents-remove:"]:not(:disabled)';
    button.dataset.focusFallbackKey = 'skill-search';
    button.setAttribute('aria-label', `从 .agents/skills 移除 ${skill.alias}`);
    button.disabled = !skill.isSymlink;
    button.addEventListener('click', () => onDisable(skill.alias));
    item.querySelector('.actions').append(button);
    elements.enabledList.append(item);
  });
}
