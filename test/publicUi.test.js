import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

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
