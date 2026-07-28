export function renderClaudeStatus({ claude, skills, elements, onUnlink }) {
  elements.unlinkClaude.disabled = !claude || !claude.exists || claude.skills.length === 0;
  if (!claude || !claude.exists) {
    elements.claudeSkillList.replaceChildren();
    return;
  }

  renderClaudeSkills({ skills: claude.skills, sourceSkills: skills, elements, onUnlink });
}

function renderClaudeSkills({ skills, sourceSkills, elements, onUnlink }) {
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
        <button class="secondary danger" type="button" data-action="unlink"></button>
      </div>
    `;
    item.querySelector('strong').textContent = skill.alias;
    item.querySelector('p').textContent = skill.targetPath || (skill.isSymlink ? '断开的软链接' : '非软链接条目');

    const sourceSkill = sourceSkills.find((s) => s.name === skill.alias);
    if (sourceSkill) {
      const description = sourceSkill.note || sourceSkill.description;
      if (description) item.title = description;
    }

    const unlinkButton = item.querySelector('[data-action="unlink"]');
    unlinkButton.textContent = skill.isSymlink ? '清空' : '不可清空';
    unlinkButton.disabled = !skill.isSymlink;
    unlinkButton.addEventListener('click', () => onUnlink(skill.alias));
    elements.claudeSkillList.append(item);
  });
}
