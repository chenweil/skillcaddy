export function renderClaudeStatus({ claude, elements, onRead, onUnlink }) {
  if (!claude || !claude.exists) {
    elements.claudeStatus.textContent = 'Claude Code：未加入 agents skill';
    elements.claudeSkillList.replaceChildren();
    elements.claudeSkillContent.replaceChildren();
    elements.unlinkClaude.disabled = true;
    return;
  }

  elements.unlinkClaude.disabled = !claude.isSymlink;
  const type = claude.isSymlink ? '软链接' : '非软链接';
  elements.claudeStatus.textContent = `Claude Code：${type} ${claude.linkPath} -> ${claude.targetPath || '真实目录'} · ${claude.skills.length} 个 skill`;
  renderClaudeSkills({ skills: claude.skills, elements, onRead, onUnlink });
}

export function renderClaudeSkillContent(elements, result) {
  elements.claudeSkillContent.innerHTML = `
    <div class="content-head">
      <strong></strong>
      <span></span>
    </div>
    <pre></pre>
  `;
  elements.claudeSkillContent.querySelector('strong').textContent = result.alias;
  elements.claudeSkillContent.querySelector('span').textContent = result.path;
  elements.claudeSkillContent.querySelector('pre').textContent = result.content;
}

function renderClaudeSkills({ skills, elements, onRead, onUnlink }) {
  elements.claudeSkillList.replaceChildren();
  if (skills.length === 0) return;

  skills.forEach((skill) => {
    const item = document.createElement('div');
    item.className = 'claude-skill';
    item.innerHTML = `
      <div>
        <strong></strong>
        <p></p>
      </div>
      <div class="actions">
        <button class="secondary" type="button" data-action="read">查看</button>
        <button class="secondary" type="button" data-action="unlink"></button>
      </div>
    `;
    item.querySelector('strong').textContent = skill.alias;
    item.querySelector('p').textContent = skill.targetPath || (skill.isSymlink ? '断开的软链接' : '非软链接条目');
    item.querySelector('[data-action="read"]').addEventListener('click', () => onRead(skill.alias));

    const unlinkButton = item.querySelector('[data-action="unlink"]');
    unlinkButton.textContent = skill.isSymlink ? '清理' : '不可清理';
    unlinkButton.disabled = !skill.isSymlink;
    unlinkButton.addEventListener('click', () => onUnlink(skill.alias));
    elements.claudeSkillList.append(item);
  });
}
