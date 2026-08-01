import { emptyState } from './emptyState.js';

export function renderClaudeStatus({ claude, skills, elements, onUnlink }) {
  elements.unlinkClaude.disabled = !claude || !claude.exists || claude.skills.length === 0;
  if (!claude || !claude.exists) {
    // 此前这里直接清空，整栏渲染成一片空白：用户既不知道这栏是什么，
    // 也不知道同栏标题里的 + 就是填充它的入口。
    elements.claudeSkillList.replaceChildren(emptyState(
      '还没有 Claude Code 入口',
      '点这一栏标题右侧的 + ，把 .agents/skills 已启用的 skill 同步到 Claude Code。'
    ));
    return;
  }

  renderClaudeSkills({ skills: claude.skills, sourceSkills: skills, elements, onUnlink });
}

function renderClaudeSkills({ skills, sourceSkills, elements, onUnlink }) {
  elements.claudeSkillList.replaceChildren();
  if (skills.length === 0) {
    elements.claudeSkillList.append(emptyState(
      'Claude Code 还没有同步任何 skill',
      '点这一栏标题右侧的 + ，把 .agents/skills 已启用的 skill 同步过来。'
    ));
    return;
  }

  skills.forEach((skill) => {
    const item = document.createElement('div');
    item.className = 'claude-skill';
    item.dataset.focusScope = '';
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
    unlinkButton.textContent = skill.isSymlink ? '移除' : '不可移除';
    unlinkButton.dataset.focusKey = `claude-remove:${skill.alias}`;
    unlinkButton.dataset.focusFallbackSelector = '#claudeSkillList [data-focus-key^="claude-remove:"]:not(:disabled)';
    unlinkButton.dataset.focusFallbackKey = 'claude-sync';
    unlinkButton.setAttribute('aria-label', skill.isSymlink
      ? `从 Claude Code 移除 ${skill.alias}`
      : `${skill.alias} 不是软链接，无法移除`);
    unlinkButton.disabled = !skill.isSymlink;
    unlinkButton.addEventListener('click', () => onUnlink(skill.alias));
    elements.claudeSkillList.append(item);
  });
}
