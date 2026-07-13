import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCompactSkillChoice,
  getDisplayWidth,
  getSkillPage,
  getSkillTableLayout,
  truncateDisplayWidth
} from '../lib/tuiLayout.js';

test('paginates skill choices while preserving their library indexes', () => {
  const choices = Array.from({ length: 12 }, (_, index) => ({ index: index + 1 }));

  assert.deepEqual(getSkillPage(choices, 2), {
    currentPage: 2,
    totalPages: 2,
    total: 12,
    start: 11,
    end: 12,
    choices: choices.slice(10)
  });
});

test('formats compact skill rows with clear status', () => {
  assert.equal(formatCompactSkillChoice({
    index: 2,
    enabled: false,
    skill: { name: 'keel', autoEnable: false }
  }, 2), ' 2. keel  手动添加');
});

test('aligns a Chinese introduction column and truncates it to terminal width', () => {
  const layout = getSkillTableLayout(80);
  const row = formatCompactSkillChoice({
    index: 1,
    enabled: true,
    skill: {
      name: 'coding-protocol',
      note: '按风险等级分级的可靠编码执行协议，防止静默假设、过度工程以及未经验证的主张。'
    }
  }, 1, layout);

  assert.equal(layout.leftWidth, 28);
  assert.equal(layout.introductionWidth, 49);
  assert.match(row, /已启用/);
  assert.match(row, /\|/);
  assert.match(row, /…$/);
  assert.equal(getDisplayWidth(row.split(' | ')[1]), layout.introductionWidth);
  assert.equal(truncateDisplayWidth('中文介绍很长', 7), '中文介…');
});

test('uses the same compact row style for search and enabled choices', () => {
  const layout = getSkillTableLayout(100);
  const available = formatCompactSkillChoice({
    index: 1,
    enabled: false,
    skill: { name: 'ask-matt', note: '帮助选择合适的 skill 或工作流。' }
  }, 1, layout);
  const enabled = formatCompactSkillChoice({
    index: 2,
    enabled: true,
    skill: { name: 'coding-protocol', note: '按风险等级执行可靠编码流程。' }
  }, 1, layout);

  assert.match(available, /^1\. ask-matt  可添加/);
  assert.match(available, /\| 帮助选择合适的 skill 或工作流。$/);
  assert.match(enabled, /^2\. coding-protocol  已启用/);
  assert.match(enabled, /\| 按风险等级执行可靠编码流程。$/);
});

test('keeps status visible when a search result name is too long', () => {
  const row = formatCompactSkillChoice({
    index: 1,
    enabled: false,
    skill: {
      name: 'guizang-social-card-skill-with-a-long-name',
      note: '生成社交卡片图片集。'
    }
  }, 1, getSkillTableLayout(80));

  assert.match(row, /^1\. guizang-social-c…  可添加/);
  assert.match(row, /\| 生成社交卡片图片集。$/);
});
