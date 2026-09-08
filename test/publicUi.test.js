import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const enabledSource = await readFile(new URL('../public/enabled.css', import.meta.url), 'utf8');
const claudeUiSource = await readFile(new URL('../public/claudeUi.js', import.meta.url), 'utf8');

test('global collection enable button keeps its success state after completion', () => {
  assert.match(
    appSource,
    /if \(globalEnabledSkills\.length === group\.skills\.length\) globalEnableButton\.classList\.add\('is-complete'\)/
  );
  assert.match(
    styleSource,
    /\.group-enable-global\.is-complete\s*\{[\s\S]*?background: var\(--success\)/
  );
});

test('library actions keep project controls left of global controls', () => {
  assert.match(
    appSource,
    /class="scope-action-group project-scope-actions"[\s\S]*?class="scope-label">项目<\/span>[\s\S]*?group-enable-all[\s\S]*?group-disable-all[\s\S]*?class="scope-divider"[\s\S]*?class="scope-action-group global-scope-actions"[\s\S]*?class="scope-label">全局<\/span>[\s\S]*?group-enable-global[\s\S]*?>\+<\/button>[\s\S]*?group-disable-global[\s\S]*?>×<\/button>/
  );
  // 全局按钮不再使用「G+」「G×」自造记号：作用域由 scope-label 图例表达。
  assert.doesNotMatch(appSource, />G\+<\/button>/);
  assert.doesNotMatch(appSource, />G×<\/button>/);
  assert.match(appSource, /projectActions\.className = 'scope-action-group project-scope-actions'/);
  assert.match(appSource, /globalActions\.className = 'scope-action-group global-scope-actions'/);
});

test('Hermes scope is exposed separately from project and global actions', () => {
  assert.match(indexSource, /id="hermesCount"/);
  assert.match(indexSource, /id="hermesList"/);
  assert.match(appSource, /scope: 'hermes'/);
  assert.match(appSource, /group-enable-hermes/);
  assert.match(appSource, /启用 Hermes/);
});

test('collapsed skill groups defer card DOM until expansion', () => {
  assert.match(
    appSource,
    /if \(!isCollapsed\) \{[\s\S]*?group\.skills\.forEach\(\(skill\) => items\.append\(renderSkill\(skill, enabledTargets, globalTargets, hermesTargets\)\)\);[\s\S]*?\}/
  );
  assert.match(appSource, /sourceFilter\.addEventListener\('change', renderSkills\)/);
  assert.match(appSource, /state\.searchQuery = event\.target\.value\.trim\(\)\.toLowerCase\(\);\s*renderSkills\(\)/);
});

test('top bar uses a header while tag filters retain the navigation landmark', () => {
  assert.match(indexSource, /<header class="topbar">[\s\S]*?<\/header>/);
  assert.doesNotMatch(indexSource, /<nav class="topbar"/);
  assert.match(indexSource, /<nav id="tagTabs"[^>]*aria-label="Skill 标签过滤"/);
});

test('theme and metadata controls cover dark mode and mobile touch targets', () => {
  assert.match(styleSource, /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?color-scheme: dark/);
  assert.match(styleSource, /\.toggle-field\s*\{[\s\S]*?min-height: 44px/);
  assert.match(styleSource, /\.toggle-field input\s*\{[\s\S]*?width: 24px;[\s\S]*?min-height: 24px/);
  assert.match(styleSource, /\.metadata-actions button,[\s\S]*?min-height: 44px/);
});

test('Hermes topbar toggle persists to localStorage and applies body class', () => {
  assert.match(indexSource, /id="hermesToggle"[^>]*type="checkbox"/);
  assert.match(indexSource, /class="topbar-toggle"/);
  assert.match(styleSource, /\.topbar-toggle-track/);
  assert.match(appSource, /HERMES_TOGGLE_KEY\s*=\s*'skillcaddy\.showHermes'/);
  assert.match(appSource, /HERMES_TOGGLE_DEFAULT\s*=\s*false/);
  assert.match(appSource, /applyHermesToggle\(readHermesToggle\(\)\)/);
  assert.match(appSource, /localStorage\.setItem\(HERMES_TOGGLE_KEY/);
  assert.match(appSource, /document\.body\.classList\.toggle\('hermes-hidden',\s*!enabled\)/);
  // 关闭时三处同步折叠：已启用面板的 Hermes 段、库分组 Hermes 操作、单条 skill 卡 Hermes 按钮。
  assert.match(styleSource, /body\.hermes-hidden \[data-hermes-section\],[\s\S]*?body\.hermes-hidden \.hermes-scope-actions/);
});

test('enabled panel uses a single 2x2 grid and unifies column titles', () => {
  // 四个已启用段都在同一个 .enabled-grid 内（agents、Claude Code、global、hermes）。
  assert.match(indexSource, /class="enabled-grid"[\s\S]*?id="enabledList"[\s\S]*?id="claudeSkillList"[\s\S]*?id="globalList"[\s\S]*?id="hermesList"/);
  assert.match(indexSource, /data-hermes-section/);
  // 列头共享同一组 class，列内动作按钮复用 column-title-action / column-title-actions。
  assert.match(indexSource, /class="column-title-label"/);
  assert.match(indexSource, /class="column-title-actions"/);
  assert.match(indexSource, /class="column-title"/);
  assert.match(enabledSource, /\.column-title-actions\s*\{[\s\S]*?margin-left: auto/);
  assert.match(enabledSource, /\.enabled-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2/);
});

test('Claude Code list reuses the unified .enabled component', () => {
  // claudeUi 改用与 .agents/skills 同款的 .enabled 组件，并展示来源徽标。
  assert.match(claudeUiSource, /className = 'enabled'/);
  assert.match(claudeUiSource, /class="enabled-head"/);
  assert.match(claudeUiSource, /class="tag-pill enabled-source"/);
  // 旧 .claude-skill 已被替换；enforced.css 不再单独维护 .claude-list。
  assert.doesNotMatch(indexSource, /id="claudeSkillList"[^>]*class="claude-list"/);
});

test('library advice collapses into an SVG info toggle and popover', () => {
  // 触发按钮在 panel-title 旁，📢 emoji 被替换为内联 SVG（保持与 brand-mark/refresh 同款描线风）。
  assert.match(indexSource, /id="adviceToggle"/);
  assert.match(indexSource, /<svg class="advice-icon"[^>]*viewBox="0 0 16 16"/);
  assert.doesNotMatch(indexSource, /📢/);
  // 计数徽标 + popover 容器。
  assert.match(indexSource, /id="adviceCount" class="count">0<\/span>/);
  assert.match(indexSource, /id="adviceList" class="advice-list advice-popover"/);
  // JS 端：渲染时更新计数 + 切换 has-warning，popover 状态机由 aria-expanded 单一来源管控。
  assert.match(appSource, /elements\.adviceCount\.textContent = count/);
  assert.match(appSource, /elements\.adviceToggle\.classList\.toggle\('has-warning'/);
  assert.match(appSource, /function setAdvicePopoverOpen/);
  assert.match(appSource, /aria-expanded/);
  // 关闭路径：外部点击 + Esc 都能收起。
  assert.match(appSource, /document\.addEventListener\('click'/);
  assert.match(appSource, /event\.key === 'Escape'/);
  // CSS 端：popover 浮在按钮下方右对齐，触发按钮 0 条时整体隐藏。
  assert.match(styleSource, /\.advice-popover\s*\{[\s\S]*?position: absolute/);
  assert.match(styleSource, /\.advice-toggle\.has-warning\s*\{[\s\S]*?background: var\(--warning-surface\)/);
});
