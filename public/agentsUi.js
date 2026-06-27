export function renderAgentsSkills({ enabled, elements, onDisable }) {
  elements.enabledList.replaceChildren();
  if (enabled.length === 0) {
    elements.enabledList.append(empty('当前项目还没有启用 skill'));
    return;
  }

  enabled.forEach((skill) => {
    const item = document.createElement('article');
    item.className = 'enabled';
    item.innerHTML = `
      <div>
        <strong class="name"></strong>
        <p class="path"></p>
      </div>
      <div class="actions"></div>
    `;
    item.querySelector('.name').textContent = skill.isSymlink ? `🔗 ${skill.alias}` : skill.alias;
    item.querySelector('.path').textContent = skill.targetPath || skill.linkPath;

    const button = document.createElement('button');
    button.className = 'secondary danger';
    button.textContent = '清理';
    button.disabled = !skill.isSymlink;
    button.addEventListener('click', () => onDisable(skill.alias));
    item.querySelector('.actions').append(button);
    elements.enabledList.append(item);
  });
}

function empty(text) {
  const element = document.createElement('div');
  element.className = 'empty';
  element.textContent = text;
  return element;
}
