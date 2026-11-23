import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const enabledSource = await readFile(new URL('../public/enabled.css', import.meta.url), 'utf8');
const agentsUiSource = await readFile(new URL('../public/agentsUi.js', import.meta.url), 'utf8');
const claudeUiSource = await readFile(new URL('../public/claudeUi.js', import.meta.url), 'utf8');
const hotUiSource = await readFile(new URL('../public/hotUi.js', import.meta.url), 'utf8');
const hotStyleSource = await readFile(new URL('../public/hot.css', import.meta.url), 'utf8');
const motionSource = await readFile(new URL('../public/motion.css', import.meta.url), 'utf8');

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

test('top bar exposes the repository beside the version badge', () => {
  assert.match(indexSource, /id="versionTag"[\s\S]*?id="githubLink"[^>]*href="https:\/\/github\.com\/chenweil\/skillcaddy"/);
  assert.match(indexSource, /id="githubLink"[^>]*target="_blank"[^>]*rel="noreferrer noopener"/);
  assert.match(indexSource, /id="githubLink"[\s\S]*?class="github-icon"[^>]*viewBox="0 0 16 16"/);
  assert.match(styleSource, /\.topbar-link\s*\{[\s\S]*?min-height: 36px[\s\S]*?border-radius: 999px/);
  assert.match(styleSource, /\.topbar-link:focus-visible\s*\{[\s\S]*?outline: 2px solid var\(--primary-strong\)/);
  assert.match(styleSource, /\.topbar-link-label\s*\{[\s\S]*?display: none/);
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

test('enabled panel presents four distinct agent channel slots', () => {
  // 四个已启用段都在同一个 .enabled-grid 内（Agents、Claude Code、全局、Hermes）。
  assert.match(indexSource, /class="enabled-grid"[\s\S]*?id="enabledList"[\s\S]*?id="claudeSkillList"[\s\S]*?id="globalList"[\s\S]*?id="hermesList"/);
  assert.match(indexSource, /data-hermes-section/);
  // 每个通道有专属标识和常驻用途说明，批量动作落在卡片底部。
  assert.match(indexSource, /class="scope-icon"[^>]*>⚙<\/span>[\s\S]*?<h3>Agents<\/h3>/);
  assert.match(indexSource, /class="scope-icon"[^>]*>⌬<\/span>[\s\S]*?<h3>Claude Code<\/h3>/);
  assert.match(indexSource, /class="scope-icon"[^>]*>⌂<\/span>[\s\S]*?<h3>全局<\/h3>/);
  assert.match(indexSource, /class="scope-icon"[^>]*>⏣<\/span>[\s\S]*?<h3>Hermes<\/h3>/);
  assert.match(indexSource, /class="scope-card-footer"[\s\S]*?id="disableAgents"/);
  assert.match(indexSource, /id="claudeSkillList"[\s\S]*?class="scope-card-footer"[\s\S]*?id="syncClaude"[\s\S]*?id="unlinkClaude"/);
  assert.match(indexSource, /class="column-title-actions"/);
  assert.match(indexSource, /class="column-title"/);
  assert.match(enabledSource, /\.scope-global,[\s\S]*?\.scope-hermes\s*\{[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(enabledSource, /\.list\.compact\s*\{[\s\S]*?max-height: 280px;[\s\S]*?overflow-y: auto/);
  assert.match(enabledSource, /\.enabled-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2/);
});

test('enabled panel provides one shared search for every channel', () => {
  assert.match(indexSource, /class="enabled-toolbar"[\s\S]*?id="enabledSearch"[^>]*type="search"/);
  assert.match(indexSource, /id="enabledSearch"[^>]*aria-controls="enabledList claudeSkillList globalList hermesList"/);
  assert.match(indexSource, /id="enabledSearchSummary"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(appSource, /enabledQuery: ''/);
  assert.match(appSource, /elements\.enabledSearch\.addEventListener\('input'/);
  assert.match(appSource, /applyHermesToggle\(next\);\s*renderEnabled\(\)/);
  assert.match(appSource, /renderAgentsSkills\(\{ enabled: state\.enabled[\s\S]*?query \}\)/);
  assert.match(appSource, /renderClaudeStatus\(\{ claude: state\.claude[\s\S]*?query \}\)/);
  assert.match(appSource, /命中 \$\{matched\} \/ \$\{total\} 个已启用条目/);
  assert.match(agentsUiSource, /const filtered = enabled\.filter\(\(skill\) => matchesEnabledQuery\(skill, skills, normalizedQuery\)\)/);
  assert.match(agentsUiSource, /没有匹配的 skill/);
  assert.match(claudeUiSource, /const filtered = claude\.skills\.filter\(\(skill\) => matchesEnabledQuery\(skill, skills, normalizedQuery\)\)/);
  assert.match(claudeUiSource, /没有匹配的 skill/);
  assert.match(enabledSource, /\.enabled-toolbar\s*\{[\s\S]*?\.enabled-search input/);
});

test('library skill cards expose the same note-first hover text as enabled cards', () => {
  assert.match(appSource, /const hoverText = skill\.note \|\| skill\.description;\s*if \(hoverText\) item\.title = hoverText;/);
  assert.match(agentsUiSource, /const description = sourceSkill\.note \|\| sourceSkill\.description;/);
  assert.match(claudeUiSource, /const description = sourceSkill\.note \|\| sourceSkill\.description;/);
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

test('Agents bulk-clear passes an explicit project scope', () => {
  // 回归：裸绑 click 会把 PointerEvent 当作 scope 传入，导致全部 /api/disable 被拒绝、
  // 提示文案出现 [object PointerEvent]。三个批量清空按钮都必须传字符串 scope。
  assert.match(appSource, /elements\.disableAgents\.addEventListener\('click', \(\) => disableAgents\('project'\)\)/);
  assert.match(appSource, /elements\.disableGlobal\.addEventListener\('click', \(\) => disableAgents\('global'\)\)/);
  assert.match(appSource, /elements\.disableHermes\.addEventListener\('click', \(\) => disableAgents\('hermes'\)\)/);
  assert.doesNotMatch(appSource, /addEventListener\('click', disableAgents\)/);
  // 纵深防御：disableAgents 入口把非字符串 scope 纠回 project。
  assert.match(appSource, /async function disableAgents\(scope = 'project'\) \{[^}]*?if \(typeof scope !== 'string'\) scope = 'project';/);
});

test('top bar adds exactly one new tab and keeps 已安装 as the default view', () => {
  assert.match(indexSource, /<nav class="topbar-tabs" aria-label="主导航">/);
  assert.match(indexSource, /data-view="installed"[^>]*aria-current="page">已安装<\/button>/);
  assert.match(indexSource, /data-view="hot"[^>]*>热门<\/button>/);
  assert.equal(indexSource.match(/data-view="/g).length, 2);
  // 热门容器与样式表随页面一起加载。
  assert.match(indexSource, /<link rel="stylesheet" href="\/hot\.css">/);
  assert.match(indexSource, /<section id="hotView"[^>]*hidden/);
  assert.match(indexSource, /<div id="hotGrid"/);
  assert.match(indexSource, /<div id="hotDetail"/);
});

test('hot view is routed by query parameters and restores scroll on back', () => {
  assert.match(appSource, /import \{ createHotView \} from '\.\/hotUi\.js'/);
  assert.match(appSource, /function readRoute\(\)/);
  assert.match(appSource, /params\.get\('view'\) === 'hot' \? 'hot' : 'installed'/);
  assert.match(appSource, /window\.addEventListener\('popstate'/);
  assert.match(appSource, /event\.state\?\.skillcaddy\?\.scrollY/);
  assert.match(appSource, /window\.history\.pushState/);
  // 项目路径写回 URL 时保留热门相关参数（replaceState 只改 projectPath）。
  assert.match(appSource, /function syncProjectPathToUrl[\s\S]*?url\.searchParams\.set\('projectPath'/);
  assert.match(appSource, /document\.body\.classList\.toggle\('view-hot', isHot\)/);
});

test('hot cards are links, not quick-add buttons', () => {
  assert.match(hotUiSource, /card\.className = 'hot-card'/);
  assert.match(hotUiSource, /card\.href = detailHref\(entry\)/);
  assert.match(hotUiSource, /onNavigate\(\{ source: entry\.source, skill: entry\.skillId \}\)/);
  // 卡片里没有直接写入原件库的入口：浏览与安装分离。
  assert.doesNotMatch(hotUiSource, /renderCard[\s\S]{0,400}?\/api\/hot\/install/);
  assert.match(hotUiSource, /loading = 'lazy'/);
  assert.match(hotUiSource, /decoding = 'async'/);
});

test('hot detail discloses source-granular acquisition and never fakes a metric', () => {
  assert.match(hotUiSource, /添加会加入整个来源/);
  assert.match(hotUiSource, /暂不支持一键添加/);
  assert.match(hotUiSource, /安装后可查看完整 SKILL\.md/);
  assert.match(hotUiSource, /内容来自来源，Skillcaddy 不执行它/);
  // 缺 stars 时整行隐藏，不补 0。
  assert.match(hotUiSource, /if \(value === null \|\| value === undefined \|\| value === ''\) continue/);
});

test('SKILL.md rendering never assigns HTML and only allows https links', () => {
  assert.doesNotMatch(hotUiSource, /\.innerHTML\s*=/);
  assert.match(hotUiSource, /document\.createTextNode/);
  assert.match(hotUiSource, /function renderInline/);
  // 链接协议白名单写在正则里：只匹配 https。
  assert.ok(hotUiSource.includes('(https:\\/\\/[^\\s)]+)'), 'link pattern is https-only');
  // 代码块与标题都走 textContent。
  assert.match(hotUiSource, /code\.textContent = codeLines\.join/);
});

test('hot styles cover the grid, skeleton state, and the detail sidebar', () => {
  assert.match(hotStyleSource, /\.hot-grid\s*\{[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(236px, 1fr\)\)/);
  assert.match(hotStyleSource, /\.hot-skeleton-cover\s*\{[\s\S]*?animation: hot-shimmer/);
  assert.match(hotStyleSource, /\.hot-detail-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 280px/);
  // 容器内 [hidden] 必须真的隐藏：否则 .hot-custom 这类 display:flex 会盖掉 UA 规则。
  assert.match(hotStyleSource, /\.hot-view \[hidden\]\s*\{\s*display: none !important;/);
});

test('hot view hides the Hermes toggle, which has no target there', () => {
  // 热门页不涉及启用范围：开关留着点了也无效，直接在热门视图里隐藏。
  assert.match(hotStyleSource, /body\.view-hot \.topbar-toggle\s*\{\s*display: none;/);
});

test('switching skills inside a source happens in place, not by page navigation', () => {
  // 整行是切换控件，并且靠事件委托绑定：详情页局部重渲染不会丢监听。
  assert.match(hotUiSource, /row\.dataset\.skillId = skill\.skillId/);
  assert.match(hotUiSource, /els\.detail\.addEventListener\('click'/);
  assert.match(hotUiSource, /selectSkill\(row\.dataset\.skillId\)/);
  // 旧的「查看」按钮已移除：它只改 URL 不改变可见结果，用户以为没反应。
  assert.doesNotMatch(hotUiSource, /textContent = '查看'/);
  // 切换后标题写明是哪个 skill，并把面板滚进视口。
  assert.match(hotUiSource, /SKILL\.MD · \$\{detail\.entry\.skillId\}/);
  assert.match(hotUiSource, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  // 只替换地址栏状态，不堆历史记录。
  assert.match(appSource, /function replaceRoute\(patch\)/);
  assert.match(appSource, /window\.history\.replaceState\(window\.history\.state, '', url\)/);
  assert.match(hotStyleSource, /\.detail-skill-row\.is-current\s*\{[\s\S]*?background: var\(--hot-active-wash\)/);
});

test('large sources cap the skill list and offer an in-place filter', () => {
  assert.match(hotUiSource, /const SKILL_LIST_SCROLL_THRESHOLD = 8;/);
  assert.match(hotUiSource, /const SKILL_FILTER_THRESHOLD = 12;/);
  assert.match(hotUiSource, /is-scrollable/);
  assert.match(hotUiSource, /在 \$\{skills\.length\} 个 skill 里筛选…/);
  assert.match(hotUiSource, /没有匹配的 skill/);
  // 首屏渲染后要把「当前」行滚进列表视口，否则 43 个 skill 里找不到自己在看哪个。
  assert.match(hotUiSource, /syncSkillListScroll\(\)/);
  assert.match(hotStyleSource, /\.detail-skills\.is-scrollable\s*\{[\s\S]*?max-height: 340px;[\s\S]*?overflow-y: auto;/);
});

test('hot surface colours follow the theme instead of light-only tokens', () => {
  // --brand-blue-wash 只在亮色 :root 定义，暗色下不翻；用在背景上会变成「浅蓝底+浅蓝字」。
  assert.doesNotMatch(hotStyleSource, /background: var\(--brand-blue-wash\)/);
  assert.match(hotStyleSource, /@media \(prefers-color-scheme: dark\) \{\s*\.hot-view \{[\s\S]*?--hot-surface: #111d30/);
  // 卡片/阅读区/相关推荐都用主题感知的表面色，而不是与页面同色的 canvas。
  assert.match(hotStyleSource, /\.hot-card \{[\s\S]*?background: var\(--hot-surface\)/);
  assert.match(hotStyleSource, /\.skillmd \{[\s\S]*?background: var\(--hot-surface\)/);
});

test('motion is opt-in and fully disabled when the system asks for less', () => {
  assert.match(indexSource, /href="\/hot\.css">\s*<link rel="stylesheet" href="\/motion\.css">/);
  // 所有动画规则都在 no-preference 里。
  const noPref = motionSource.split('@media (prefers-reduced-motion: no-preference)')[1] || '';
  assert.match(noPref, /\.view-enter\s*\{/);
  assert.match(noPref, /\.hot-grid\.is-entering \.hot-card\s*\{/);
  assert.match(noPref, /\.skillmd\.is-swapping\s*\{/);
  // reduce 分支必须把持续动画也停掉。
  assert.match(motionSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hot-skeleton-cover\s*\{\s*animation: none;/);
  // 视图入场在 JS 侧同样跳过，避免留下等不到 animationend 的类名。
  assert.match(appSource, /prefers-reduced-motion: reduce\)'\)\.matches\) return;/);
});

test('card entrance is staggered by index and only replays on fresh data', () => {
  assert.match(hotUiSource, /card\.style\.setProperty\('--i', String\(Math\.min\(index, 11\)\)\)/);
  assert.match(hotUiSource, /const animate = state\.animateCards;/);
  assert.match(hotUiSource, /els\.grid\.classList\.toggle\('is-entering', animate\)/);
  assert.match(motionSource, /animation-delay: calc\(var\(--i, 0\) \* 22ms\)/);
});

test('search and category filtering reuse the loaded payload instead of refetching', () => {
  assert.match(hotUiSource, /function loadMatchesRoute\(route\)/);
  assert.match(hotUiSource, /if \(loadMatchesRoute\(route\)\) \{\s*renderList\(\);/);
  assert.match(hotUiSource, /state\.listQuery = \{ window: route\.window, days: route\.days \|\| null \}/);
});
