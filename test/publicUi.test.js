import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

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
