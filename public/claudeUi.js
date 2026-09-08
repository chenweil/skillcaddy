import { emptyState } from './emptyState.js';

// Claude Code 段复用与 .agents/skills 完全相同的 .enabled 组件。
// 唯一差异：Claude Code 段有「同步」动作（项目 .agents/skills → Claude Code 软链），
// 因此额外接收 syncEnabled 回调，并在列头由 index.html 提供按钮。
export function renderClaudeStatus({ claude, skills, elements, onUnlink, onSync, isPreview = false }) {
  elements.unlinkClaude.disabled = isPreview || !claude || !claude.exists || claude.skills.length === 0;
  if (isPreview) {
    elements.unlinkClaude.title = '预览模式只读：先在下方读取你自己的项目再操作';
    elements.syncClaude.disabled = true;
    elements.syncClaude.title = '预览模式只读：先在下方读取你自己的项目再操作';
  } else {
    elements.syncClaude.disabled = !claude || !claude.exists;
    elements.syncClaude.title = '把项目已启用的 skill 同步到 Claude Code';
  }
  if (onSync) elements.syncClaude.onclick = onSync;
  if (!claude || !claude.exists) {
    // 此前这里直接清空，整栏渲染成一片空白：用户既不知道这栏是什么，
    // 也不知道同栏标题里的「同步」就是填充它的入口。
    elements.claudeSkillList.replaceChildren(emptyState(
      '还没有 Claude Code 入口',
      '点这一栏标题右侧的「同步」，把 .agents/skills 已启用的 skill 同步到 Claude Code。'
    ));
    return;
  }

  renderClaudeSkills({ skills: claude.skills, sourceSkills: skills, elements, onUnlink, isPreview });
}

function renderClaudeSkills({ skills, sourceSkills, elements, onUnlink, isPreview = false }) {
  elements.claudeSkillList.replaceChildren();
  if (skills.length === 0) {
    elements.claudeSkillList.append(emptyState(
      'Claude Code 还没有同步任何 skill',
      '点这一栏标题右侧的「同步」，把 .agents/skills 已启用的 skill 同步过来。'
    ));
    return;
  }

  skills.forEach((skill) => {
    const item = document.createElement('article');
    // 与 .agents/skills / 全局 / Hermes 同款结构：name + 来源徽标 + 路径 + 移除按钮。
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
    item.querySelector('.path').textContent = skill.targetPath || (skill.isSymlink ? '断开的软链接' : '非软链接条目');

    // Claude Code 软链的目标是某个 skill 原件；按 alias 找到来源后挂上 source 徽标，
    // 视觉上与 .agents/skills 列表对齐（同源同名条目也能靠徽标区分）。
    const sourceSkill = sourceSkills.find((s) => s.name === skill.alias);
    const sourceChip = item.querySelector('.enabled-source');
    if (sourceSkill) {
      sourceChip.textContent = sourceSkill.source;
      sourceChip.title = `${sourceSkill.collection} 来源`;
      const description = sourceSkill.note || sourceSkill.description;
      if (description) item.title = description;
    } else {
      sourceChip.hidden = true;
    }

    const button = document.createElement('button');
    button.className = 'secondary danger';
    button.type = 'button';
    // 与 agents 列表一致：单条用「移除」。
    button.textContent = '移除';
    button.dataset.focusKey = `claude-remove:${skill.alias}`;
    button.dataset.focusFallbackSelector = '#claudeSkillList [data-focus-key^="claude-remove:"]:not(:disabled)';
    button.dataset.focusFallbackKey = 'claude-sync';
    button.setAttribute('aria-label', `从 Claude Code 移除 ${skill.alias}`);
    button.disabled = isPreview || !skill.isSymlink;
    if (!skill.isSymlink) {
      button.textContent = '不可移除';
      button.title = '非软链接条目无法移除';
      button.setAttribute('aria-label', `${skill.alias} 不是软链接，无法移除`);
    }
    if (isPreview) button.title = '预览模式只读：先在下方读取你自己的项目再操作';
    button.addEventListener('click', () => onUnlink(skill.alias));
    item.querySelector('.actions').append(button);
    elements.claudeSkillList.append(item);
  });
}
