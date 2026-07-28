const DEFAULT_PAGE_SIZE = 10;
const TABLE_DIVIDER = ' | ';

export function getSkillPage(choices, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(choices.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    currentPage,
    totalPages,
    total: choices.length,
    start: choices.length === 0 ? 0 : start + 1,
    end: Math.min(start + pageSize, choices.length),
    choices: choices.slice(start, start + pageSize)
  };
}

export function getSkillTableLayout(columns) {
  const terminalWidth = Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 100;
  const singleColumn = terminalWidth < 40;
  const leftWidth = singleColumn
    ? terminalWidth
    : Math.min(38, Math.max(20, Math.floor(terminalWidth * 0.36)));

  return {
    leftWidth,
    introductionWidth: singleColumn
      ? 0
      : terminalWidth - leftWidth - getDisplayWidth(TABLE_DIVIDER)
  };
}

export function formatSkillTableHeader(layout) {
  if (layout.introductionWidth === 0) return 'Skill / 状态';
  return `${padDisplayWidth('Skill / 状态', layout.leftWidth)}${TABLE_DIVIDER}介绍`;
}

export function formatSkillTableDivider(layout) {
  if (layout.introductionWidth === 0) return '-'.repeat(layout.leftWidth);
  return `${'-'.repeat(layout.leftWidth)}+${'-'.repeat(layout.introductionWidth + 2)}`;
}

export function formatCompactSkillChoice(choice, indexWidth = 1, layout) {
  const status = choice.enabled
    ? '已启用'
    : choice.skill.autoEnable === false
      ? '手动添加'
      : '可添加';
  const prefix = `${String(choice.index).padStart(indexWidth)}. `;
  const suffix = `  ${status}`;
  const label = `${prefix}${choice.skill.name}${suffix}`;

  if (!layout) return label;

  const nameWidth = Math.max(1, layout.leftWidth - getDisplayWidth(prefix) - getDisplayWidth(suffix));
  const compactLabel = `${prefix}${truncateDisplayWidth(choice.skill.name, nameWidth)}${suffix}`;
  if (layout.introductionWidth === 0) return compactLabel;
  return `${padDisplayWidth(compactLabel, layout.leftWidth)}${TABLE_DIVIDER}${truncateDisplayWidth(getSkillIntroduction(choice.skill), layout.introductionWidth)}`;
}

export function getSkillIntroduction(skill) {
  return skill.note || skill.description || skill.path;
}

export function getDisplayWidth(value) {
  return [...String(value)].reduce((width, character) => width + (isWideCharacter(character) ? 2 : 1), 0);
}

export function truncateDisplayWidth(value, maxWidth) {
  const text = String(value);
  if (getDisplayWidth(text) <= maxWidth) return text;

  let result = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = getDisplayWidth(character);
    if (width + characterWidth + 1 > maxWidth) break;
    result += character;
    width += characterWidth;
  }
  return `${result}…`;
}

function padDisplayWidth(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - getDisplayWidth(value)))}`;
}

function isWideCharacter(character) {
  if (character === '…') return false;
  return character.codePointAt(0) > 0xff;
}
