#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { execFile, spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  disableAlias,
  enableSkillChoice,
  formatAdvice,
  listEnabledAliases,
  listSkillChoices,
  loadTuiState,
  saveSkillMetadata,
  summarizeState,
  syncClaude
} from '../lib/tuiActions.js';
import {
  formatCompactSkillChoice,
  formatSkillTableDivider,
  formatSkillTableHeader,
  getSkillIntroduction,
  getSkillPage,
  getSkillTableLayout
} from '../lib/tuiLayout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const codeRootDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(options.root || process.env.SKILLCADDY_ROOT || codeRootDir);

const rl = createInterface({ input, output });
let state = await loadTuiState(rootDir, options.projectPath || process.cwd());

try {
  await mainLoop();
} finally {
  rl.close();
}

async function mainLoop() {
  while (true) {
    printSummary();
    console.log([
      '1. 查看已启用 skill',
      '2. 浏览/搜索 skill',
      '3. 启用 skill',
      '4. 清理已启用 skill',
      '5. 同步 Claude Code',
      '6. 编辑 skill metadata',
      '7. 查看项目诊断',
      '8. 刷新项目状态',
      '9. 更新 GitHub skill 库',
      '10. 批量生成中文 note',
      'q. 退出'
    ].join('\n'));

    const choice = await ask('选择操作');
    if (choice === 'q') return;

    try {
      if (choice === '1') printEnabledSkills();
      else if (choice === '2') await browseSkills();
      else if (choice === '3') await enableSkillFlow();
      else if (choice === '4') await disableAliasFlow();
      else if (choice === '5') await syncClaudeFlow();
      else if (choice === '6') await editMetadataFlow();
      else if (choice === '7') printAdvice();
      else if (choice === '8') await refreshState();
      else if (choice === '9') await updateGithubSkillsFlow();
      else if (choice === '10') await batchTranslateNotesFlow();
      else console.log('未知操作');
    } catch (error) {
      console.log(`错误：${error.message}`);
    }

    await ask('回车继续');
  }
}

function printSummary() {
  const summary = summarizeState(state);
  console.log('\nSkillcaddy TUI');
  console.log(`原件库: ${rootDir}`);
  console.log(`项目: ${summary.projectPath}`);
  console.log(`Skills: ${summary.totalSkills}  可用: ${summary.availableSkills}  Agents: ${summary.enabledAgents}  Claude: ${summary.enabledClaude}  诊断: ${summary.advice}`);
  console.log('');
}

async function refreshState() {
  console.log(`当前原件库: ${rootDir}`);
  const nextProject = await ask(`项目路径 [${state.projectPath}]`);
  state = await loadTuiState(rootDir, nextProject || state.projectPath);
  console.log('已刷新');
}

async function updateGithubSkillsFlow() {
  const githubDir = path.join(rootDir, 'github');
  console.log(`将更新 GitHub skill 库: ${githubDir}`);
  console.log('dirty 的子库会被跳过；不会 stash、reset 或覆盖本地改动。');
  const confirm = await ask('确认运行更新? y/N');
  if (!['y', 'yes'].includes(confirm.toLowerCase())) return;

  await runCommand('bash', [path.join(codeRootDir, 'scripts', 'pull-github.sh'), githubDir]);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log('已重新扫描本地状态');
}

function printEnabledSkills() {
  console.log('\n已启用 skill / Agents');
  if (state.enabled.length === 0) {
    console.log('当前项目没有启用 Agents skill');
  } else {
    printSkillChoices(state.enabled.map(toEnabledSkillChoice));
  }

  console.log('\n已启用 skill / Claude Code');
  const claudeSkills = state.claude?.skills || [];
  if (claudeSkills.length === 0) {
    console.log('当前项目没有启用 Claude Code skill');
  } else {
    printSkillChoices(claudeSkills.map((skill, index) => {
      const agentsSkill = state.enabled.find((item) => item.alias === skill.alias);
      return toEnabledSkillChoice(agentsSkill || skill, index);
    }));
  }
}

function toEnabledSkillChoice(enabledSkill, index) {
  const sourceSkill = findSourceSkillForEnabled(enabledSkill);
  return {
    index: index + 1,
    enabled: true,
    skill: sourceSkill || {
      name: enabledSkill.alias,
      note: enabledSkill.isSymlink ? '' : '非软链接',
      path: enabledSkill.targetPath || enabledSkill.linkPath,
      autoEnable: true
    }
  };
}

function findSourceSkillForEnabled(enabledSkill) {
  if (!enabledSkill) return null;
  if (enabledSkill.targetPath) {
    const byTarget = state.skills.find((skill) => skill.path === enabledSkill.targetPath);
    if (byTarget) return byTarget;
  }
  return state.skills.find((skill) => skill.name === enabledSkill.alias) || null;
}

async function browseSkills() {
  let query = '';
  let source = '';

  while (true) {
    const skills = listSkillChoices(state, { query, source, limit: state.skills.length });
    const libraries = groupSkillChoices(skills);
    console.log(`\nSkill 库${query ? ` / 搜索: ${query}` : ''}${source ? ` / 来源: ${source}` : ''}`);
    if (libraries.length === 0) {
      console.log(`没有匹配的 skill。当前原件库是 ${rootDir}；如果你在 worktree 里开发，请用 --root 指向真实原件库。`);
    } else {
      printLibraryChoices(libraries);
    }

    console.log('输入库序号进入库；/关键词 搜索；s 设置来源；r 重置；b 返回');
    const selected = await ask('选择');
    if (isBack(selected)) return;
    if (selected === 'r') {
      query = '';
      source = '';
      continue;
    }
    if (selected === 's') {
      source = await ask('来源 official/github/personal/archived，可空');
      continue;
    }
    if (selected.startsWith('/')) {
      query = selected.slice(1).trim();
      continue;
    }

    const index = Number(selected);
    if (!Number.isInteger(index) || index < 1 || index > libraries.length) {
      console.log('请输入列表序号，或使用 /关键词 搜索');
      continue;
    }

    await libraryFlow(libraries[index - 1]);
  }
}

async function libraryFlow(library) {
  let page = 1;

  while (true) {
    const skills = reindexChoices(listSkillChoices(state, {
      source: library.source,
      limit: state.skills.length
    }).filter((choice) => choice.skill.collection === library.collection));
    const currentLibrary = groupSkillChoices(skills)[0] || library;

    console.log(`\n库详情: ${library.source}/${library.collection}`);
    console.log(`路径: ${library.collectionPath}`);
    console.log(`Skills: ${currentLibrary.total}  可一键添加: ${currentLibrary.bulkable}  已启用: ${currentLibrary.enabled}  跳过一键: ${currentLibrary.skipped}`);
    const skillPage = getSkillPage(skills, page);
    page = skillPage.currentPage;
    printCompactSkillChoices(skillPage);
    console.log('──────────────────');
    console.log(`输入 skill 序号进入详情；a 一键添加；${skillPage.totalPages > 1 ? 'n/p 翻页；' : ''}b 返回`);

    const selected = await ask('选择');
    if (isBack(selected)) return;
    if (selected === 'n' && page < skillPage.totalPages) {
      page += 1;
      continue;
    }
    if (selected === 'p' && page > 1) {
      page -= 1;
      continue;
    }
    if (selected === 'a') {
      await enableLibraryFlow(currentLibrary, skills);
      continue;
    }

    const index = Number(selected);
    if (!Number.isInteger(index) || index < 1 || index > skills.length) {
      console.log('请输入 skill 序号，或 a 一键添加该库');
      continue;
    }

    await skillDetailFlow(skills[index - 1].skill.id);
  }
}

async function enableLibraryFlow(library, choices) {
  const targets = choices.filter((choice) => choice.skill.autoEnable !== false && !choice.enabled);
  const skipped = choices.filter((choice) => choice.skill.autoEnable === false && !choice.enabled);
  if (targets.length === 0) {
    console.log(skipped.length ? `没有需要启用的 skill，已跳过 ${skipped.length} 个不参与一键加入` : '没有需要启用的 skill');
    return;
  }

  console.log(`将启用 ${targets.length} 个 skill；跳过 ${skipped.length} 个不参与一键加入。`);
  targets.forEach((choice) => console.log(`- ${choice.skill.name}`));
  const confirm = await ask(`确认一键添加 ${library.source}/${library.collection}? y/N`);
  if (!['y', 'yes'].includes(confirm.toLowerCase())) return;

  let enabled = 0;
  let unchanged = 0;
  let failed = 0;
  for (const choice of targets) {
    try {
      const result = await enableSkillChoice(rootDir, state, choice.skill.id);
      result.unchanged ? unchanged += 1 : enabled += 1;
      state = await loadTuiState(rootDir, state.projectPath);
    } catch (error) {
      failed += 1;
      console.log(`失败 ${choice.skill.name}: ${error.message}`);
    }
  }

  console.log(`已处理 ${library.collection}: 启用 ${enabled}，已存在 ${unchanged}，跳过 ${skipped.length}，失败 ${failed}`);
}

async function enableSkillFlow() {
  const value = await chooseSkill('要启用的 skill 关键词或 id');
  if (!value) return;
  const result = await enableSkillChoice(rootDir, state, value);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log(result.unchanged ? `已存在：${result.alias}` : `已启用：${result.alias}`);
  if (result.claudeSync?.ok === false) {
    console.log(`Claude Code 同步失败：${result.claudeSync.error}`);
  }
}

async function disableAliasFlow() {
  const aliases = listEnabledAliases(state);
  if (aliases.length === 0) {
    console.log('当前项目没有 Agents skill');
    return;
  }
  aliases.forEach((item) => console.log(`${item.index}. ${item.label}${item.canDisable ? '' : ' (不可清理)'}`));
  const selected = await ask('输入序号或 skill 名称');
  const alias = resolveIndexedValue(aliases, selected, 'alias');
  const result = await disableAlias(state, alias);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log(result.removed ? `已清理：${alias}` : `未找到：${alias}`);
}

async function syncClaudeFlow() {
  const result = await syncClaude(state);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log(result.unchanged ? 'Claude Code 已是最新' : `已同步 Claude Code：${result.linkPath}`);
}

async function editMetadataFlow() {
  const value = await chooseSkill('要编辑 metadata 的 skill 关键词或 id');
  if (!value) return;
  await editAllMetadata(value);
}

async function skillDetailFlow(skillId) {
  while (true) {
    const skill = state.skills.find((item) => item.id === skillId);
    if (!skill) {
      console.log(`找不到 skill：${skillId}`);
      return;
    }

    printSkillDetail(skill);
    console.log([
      '1. 启用到 Agents，并同步 Claude Code',
      '2. 使用其他名称启用',
      '3. 清理当前项目 skill',
      '4. 编辑备注',
      '5. 编辑 tags',
      `6. ${skill.autoEnable === false ? '开启' : '关闭'}参与一键加入`,
      '7. 编辑全部 metadata',
      'b. 返回列表'
    ].join('\n'));

    const choice = await ask('选择操作');
    if (isBack(choice)) return;

    if (choice === '1') await enableSkillById(skill.id);
    else if (choice === '2') await enableSkillWithAlias(skill);
    else if (choice === '3') await disableSkillAlias(skill);
    else if (choice === '4') await editNote(skill);
    else if (choice === '5') await editTags(skill);
    else if (choice === '6') await toggleAutoEnable(skill);
    else if (choice === '7') await editAllMetadata(skill.id);
    else console.log('未知操作');
  }
}

function printSkillDetail(skill) {
  const enabled = findEnabledSkill(skill);
  console.log('\nSkill 详情');
  console.log(`名称: ${skill.name}`);
  console.log(`ID: ${skill.id}`);
  console.log(`来源: ${skill.source}/${skill.collection}`);
  console.log(`状态: ${enabled ? `已启用 skill=${enabled.alias}` : '未启用'}`);
  console.log(`一键加入: ${skill.autoEnable === false ? '否' : '是'}`);
  console.log(`Tags: ${(skill.tags || []).join(', ') || '-'}`);
  console.log(`介绍: ${getSkillIntroduction(skill)}`);
  console.log(`路径: ${skill.path}`);
  console.log('');
}

async function enableSkillById(skillId) {
  const result = await enableSkillChoice(rootDir, state, skillId);
  await reportEnableResult(result);
}

async function enableSkillWithAlias(skill) {
  const suggestedAlias = findSuggestedAlias(skill.id) || skill.name;
  const alias = await ask(`项目中的 skill 名称 [${suggestedAlias}]`) || suggestedAlias;
  const result = await enableSkillChoice(rootDir, state, skill.id, { alias });
  await reportEnableResult(result);
}

async function reportEnableResult(result) {
  state = await loadTuiState(rootDir, state.projectPath);
  console.log(result.unchanged ? `已存在：${result.alias}` : `已启用：${result.alias}`);
  if (result.claudeSync?.ok === false) {
    console.log(`Claude Code 同步失败：${result.claudeSync.error}`);
  }
}

function findSuggestedAlias(skillId) {
  for (const advice of state.advice) {
    const action = (advice.actions || []).find((item) => item.type === 'enable-with-alias' && item.skillId === skillId);
    if (action) return action.alias;
  }
  return '';
}

async function disableSkillAlias(skill) {
  const enabled = findEnabledSkill(skill);
  if (!enabled) {
    console.log('当前项目未启用这个 skill');
    return;
  }
  const confirm = await ask(`清理已启用 skill ${enabled.alias}? y/N`);
  if (!['y', 'yes'].includes(confirm.toLowerCase())) return;
  const result = await disableAlias(state, enabled.alias);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log(result.removed ? `已清理：${enabled.alias}` : `未找到：${enabled.alias}`);
}

async function editNote(skill) {
  const note = await ask(`备注 [${skill.note || ''}]`);
  if (!note) return;
  await saveSkillMetadata(rootDir, state, skill.id, { note });
  state = await loadTuiState(rootDir, state.projectPath);
  console.log('已保存备注');
}

async function editTags(skill) {
  const tags = await ask(`Tags 逗号分隔 [${(skill.tags || []).join(', ')}]`);
  if (!tags) return;
  await saveSkillMetadata(rootDir, state, skill.id, {
    tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  });
  state = await loadTuiState(rootDir, state.projectPath);
  console.log('已保存 tags');
}

async function toggleAutoEnable(skill) {
  await saveSkillMetadata(rootDir, state, skill.id, {
    autoEnable: skill.autoEnable === false
  });
  state = await loadTuiState(rootDir, state.projectPath);
  console.log('已更新一键加入设置');
}

async function editAllMetadata(skillId) {
  const skill = state.skills.find((item) => item.id === skillId);
  const note = await ask(`备注 [${skill?.note || ''}]`);
  const tags = await ask(`Tags 逗号分隔 [${(skill?.tags || []).join(', ')}]`);
  const autoEnableInput = await ask(`参与一键加入 true/false [${skill?.autoEnable !== false}]`);

  const metadata = {};
  if (note) metadata.note = note;
  if (tags) metadata.tags = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  if (autoEnableInput) metadata.autoEnable = parseBoolean(autoEnableInput);

  await saveSkillMetadata(rootDir, state, skillId, metadata);
  state = await loadTuiState(rootDir, state.projectPath);
  console.log('已保存 metadata');
}

function printAdvice() {
  const advice = formatAdvice(state.advice);
  if (advice.length === 0) {
    console.log('当前没有 advice');
    return;
  }
  advice.forEach((item) => {
    console.log(`${item.index}. [${item.severity}] ${item.title}`);
    console.log(`   ${item.detail}`);
  });
}

async function chooseSkill(prompt) {
  const query = await ask(prompt);
  const choices = listSkillChoices(state, { query, limit: 20 });
  if (choices.length === 0) {
    console.log(`没有匹配的 skill。当前原件库是 ${rootDir}；如果你在 worktree 里开发，请用 --root 指向真实原件库。`);
    return '';
  }
  if (choices.length === 1) {
    console.log(`匹配：${choices[0].label}${choices[0].enabled ? ' (已启用)' : ''}`);
    const confirm = await ask('直接使用这个 skill? Y/n');
    if (!confirm || ['y', 'yes'].includes(confirm.toLowerCase())) return choices[0].id;
  }
  printSkillChoices(choices);
  const selected = await ask('输入序号或完整 id');
  return resolveIndexedValue(choices, selected, 'id');
}

function printSkillChoices(choices) {
  printCompactSkillChoices(getSkillPage(choices, 1, Math.max(choices.length, 1)));
}

function printCompactSkillChoices(skillPage) {
  const indexWidth = String(skillPage.end).length;
  const tableLayout = getSkillTableLayout(output.columns);
  console.log(`\nSkills ${skillPage.start}-${skillPage.end} / ${skillPage.total}`);
  console.log(formatSkillTableHeader(tableLayout));
  console.log(formatSkillTableDivider(tableLayout));
  skillPage.choices.forEach((choice) => console.log(formatCompactSkillChoice(choice, indexWidth, tableLayout)));
  if (skillPage.totalPages > 1) {
    console.log(`第 ${skillPage.currentPage}/${skillPage.totalPages} 页`);
  }
}

function findEnabledSkill(skill) {
  return state.enabled.find((enabled) => enabled.targetPath === skill.path);
}

function groupSkillChoices(choices) {
  const groups = new Map();
  for (const choice of choices) {
    const key = `${choice.skill.source}/${choice.skill.collection}`;
    if (!groups.has(key)) {
      groups.set(key, {
        index: groups.size + 1,
        key,
        source: choice.skill.source,
        collection: choice.skill.collection,
        collectionPath: choice.skill.collectionPath,
        total: 0,
        enabled: 0,
        skipped: 0,
        bulkable: 0
      });
    }
    const group = groups.get(key);
    group.total += 1;
    if (choice.enabled) group.enabled += 1;
    if (choice.skill.autoEnable === false) group.skipped += 1;
    if (!choice.enabled && choice.skill.autoEnable !== false) group.bulkable += 1;
  }

  return [...groups.values()];
}

function printLibraryChoices(libraries) {
  libraries.forEach((library) => {
    const parts = [`${library.total} 个 skill`];
    if (library.enabled) parts.push(`已启用 ${library.enabled}`);
    if (library.skipped) parts.push(`一键跳过 ${library.skipped}`);
    console.log(`${library.index}. ${library.source}/${library.collection} (${parts.join('，')})`);
  });
}

function reindexChoices(choices) {
  return choices.map((choice, index) => ({ ...choice, index: index + 1 }));
}

function resolveIndexedValue(items, selected, field) {
  const text = String(selected || '').trim();
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= items.length) {
    return items[index - 1][field];
  }
  return text;
}

function parseBoolean(value) {
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  throw new Error('autoEnable 必须是 true 或 false');
}

async function ask(prompt) {
  return (await rl.question(`${prompt}: `)).trim();
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: codeRootDir,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function isBack(value) {
  return String(value || '').trim().toLowerCase() === 'b';
}

async function batchTranslateNotesFlow() {
  // 1. 筛选待翻译的 skills
  const pending = state.skills.filter((skill) => {
    if (skill.source === 'archived') return false;
    const note = String(skill.note || '').trim();
    const description = String(skill.description || '').trim();
    return description && !note;
  });

  if (pending.length === 0) {
    console.log('所有 skill 都已有中文介绍');
    return;
  }

  console.log(`\n待翻译 skill: ${pending.length} 个`);

  // 2. 让用户选择批次大小
  console.log('处理方式:');
  console.log('  1. 处理 5 个');
  console.log('  2. 处理 10 个');
  console.log('  3. 处理全部');
  console.log('  b. 返回');

  const batchChoice = await ask('选择');
  if (isBack(batchChoice)) return;

  let batchSize;
  if (batchChoice === '1') batchSize = 5;
  else if (batchChoice === '2') batchSize = 10;
  else if (batchChoice === '3') batchSize = pending.length;
  else {
    console.log('未知选项');
    return;
  }

  const toProcess = pending.slice(0, batchSize);
  console.log(`\n将处理 ${toProcess.length} 个 skill:\n`);

  // 3. 显示待处理列表
  toProcess.forEach((skill, index) => {
    console.log(`${index + 1}. ${skill.name} [${skill.source}/${skill.collection}]`);
  });

  const confirmStart = await ask('\n开始处理? y/N');
  if (!['y', 'yes'].includes(confirmStart.toLowerCase())) return;

  // 4. 逐个处理
  const results = [];
  for (let i = 0; i < toProcess.length; i += 1) {
    const skill = toProcess[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`[${i + 1}/${toProcess.length}] ${skill.name}`);
    console.log(`来源: ${skill.source}/${skill.collection}`);
    console.log(`\n英文描述:`);
    console.log(skill.description);
    console.log('');

    const note = await ask('输入中文介绍 (留空跳过, q 退出)');
    if (note.toLowerCase() === 'q') {
      console.log('已中断');
      break;
    }
    if (!note) {
      console.log('已跳过');
      results.push({ skill, status: 'skipped' });
      continue;
    }

    try {
      await saveSkillMetadata(rootDir, state, skill.id, { note });
      state = await loadTuiState(rootDir, state.projectPath);
      console.log('✓ 已保存');
      results.push({ skill, status: 'saved', note });
    } catch (error) {
      console.log(`✗ 保存失败: ${error.message}`);
      results.push({ skill, status: 'failed', error: error.message });
    }
  }

  // 5. 汇总结果
  console.log(`\n${'─'.repeat(50)}`);
  console.log('处理完成');
  const saved = results.filter((r) => r.status === 'saved').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log(`已保存: ${saved}，已跳过: ${skipped}，失败: ${failed}`);
}

function parseArgs(args) {
  const options = { root: '', projectPath: '' };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      options.root = args[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
      continue;
    }
    if (!options.projectPath) options.projectPath = arg;
  }

  return options;
}
