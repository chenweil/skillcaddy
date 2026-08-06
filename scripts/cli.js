import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getState } from '../lib/skillStore.js';
import { installCliCommand } from '../lib/tuiInstall.js';
import { readVersion } from '../lib/version.js';
import { restartWeb, startWeb, stopWeb } from '../lib/webManager.js';
import { runSourceCli } from './source.js';

const CLI_FLAGS = new Set(['-h', '--help', '-v', '--version', '-u', '--update', '-a', '--analyze']);
const CLI_COMMANDS = new Set(['start', 'stop', 'restart', 'update', 'analyze', 'install', 'server', 'web']);

export function isCliCommand(argv = []) {
  return argv.some((arg) =>
    CLI_FLAGS.has(arg) ||
    CLI_COMMANDS.has(arg) ||
    arg.startsWith('-') && arg !== '--root' && !arg.startsWith('--root=')
  );
}

export function parseCliArgs(argv = []) {
  const result = {
    command: 'tui',
    projectPath: '',
    rootDir: '',
    port: undefined,
    open: true,
    error: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      result.command = 'help';
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      result.command = 'version';
      continue;
    }
    if (arg === '-u' || arg === '--update' || arg === 'update') {
      result.command = 'update';
      continue;
    }
    if (arg === '-a' || arg === '--analyze' || arg === 'analyze') {
      result.command = 'analyze';
      continue;
    }
    if (arg === 'start' || arg === 'stop' || arg === 'restart') {
      result.command = arg;
      continue;
    }
    if (arg === 'install') {
      const target = argv[index + 1];
      if (!['cli', 'tui'].includes(target)) {
        result.error = 'install 后需要 cli 或 tui';
        return result;
      }
      result.command = 'install';
      result.installTarget = target;
      index += 1;
      continue;
    }
    if (arg === 'web') {
      result.command = 'start';
      continue;
    }
    if (arg === 'server') {
      const next = argv[index + 1];
      if (!['start', 'stop', 'restart'].includes(next)) {
        result.error = 'server 后需要 start、stop 或 restart';
        return result;
      }
      result.command = next;
      index += 1;
      continue;
    }
    if (arg === '--root') {
      result.rootDir = argv[index + 1] || '';
      if (!result.rootDir) result.error = '--root 需要一个目录路径';
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      result.rootDir = arg.slice('--root='.length);
      if (!result.rootDir) result.error = '--root 需要一个目录路径';
      continue;
    }
    if (arg === '--project') {
      result.projectPath = argv[index + 1] || '';
      if (!result.projectPath) result.error = '--project 需要一个目录路径';
      index += 1;
      continue;
    }
    if (arg.startsWith('--project=')) {
      result.projectPath = arg.slice('--project='.length);
      if (!result.projectPath) result.error = '--project 需要一个目录路径';
      continue;
    }
    if (arg === '-p' || arg === '--port') {
      result.port = argv[index + 1] || '';
      if (!result.port) result.error = `${arg} 需要一个端口号`;
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      result.port = arg.slice('--port='.length);
      if (!result.port) result.error = '--port 需要一个端口号';
      continue;
    }
    if (arg === '--no-open') {
      result.open = false;
      continue;
    }
    if (arg.startsWith('-')) {
      result.error = `未知参数：${arg}`;
      return result;
    }
    if (!result.projectPath) {
      result.projectPath = arg;
    } else {
      result.error = `只能指定一个项目路径：${arg}`;
      return result;
    }
  }

  return result;
}

export function buildHelpText() {
  return `Skillcaddy：本地 skill 原件库与项目启用管理

用法：
  skillcaddy                         进入当前项目 TUI
  skillcaddy <projectPath>           管理指定项目
  skillcaddy start [projectPath]     启动 Web 管理器
  skillcaddy stop                    停止由 Skillcaddy 管理的 Web
  skillcaddy restart [projectPath]   重启 Web 管理器
  skillcaddy install cli              安装全局 CLI + TUI 命令
  skillcaddy install tui              同上，兼容 TUI 安装说法
  skillcaddy -v                      查看版本
  skillcaddy -h                      查看帮助
  skillcaddy -u [projectPath]        安全更新已登记的 Git skill 源
  skillcaddy -a [projectPath]        分析项目 skill 状态并给出推荐

选项：
  --root <dir>                       指定 Skillcaddy 原件库根目录
  -p, --port <port>                  Web 端口，默认 4173
  --no-open                          启动 Web 后不自动打开浏览器
  --project <dir>                    显式指定项目目录

说明：-u 只更新已登记的 Git 源；-a 只读，不会安装、启用或修改 skill。
`;
}

function printWebResult(result, stdout) {
  const status = {
    started: 'Web 已启动',
    'already-running': result.managed ? 'Web 已在运行' : '检测到外部 Web 已在运行',
    stopped: 'Web 已停止',
    'not-running': 'Web 当前未运行',
    'not-managed': '端口上的 Web 不是由 Skillcaddy 管理，未停止',
    restarted: 'Web 已重启'
  }[result.status] || `Web 状态：${result.status}`;
  stdout.write(`${status}\n`);
  if (result.pid) stdout.write(`PID: ${result.pid}\n`);
  if (result.url) stdout.write(`URL: ${result.url}\n`);
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function stateTokens(state) {
  return [
    ...(state.skills || []),
    ...(state.enabled || []),
    ...(state.global || [])
  ].flatMap((skill) => [skill.id, skill.name, skill.alias, skill.collection, ...(skill.tags || [])])
    .map(normalizeToken)
    .filter(Boolean);
}

function allFeaturedCollections(catalog) {
  return Object.entries(catalog?.featured || {}).flatMap(([category, data]) =>
    (data?.collections || []).map((collection) => ({ ...collection, category, categoryLabel: data.label }))
  );
}

function findFeaturedCollection(id, catalog) {
  const wanted = normalizeToken(id);
  return allFeaturedCollections(catalog).find((collection) => {
    const candidates = [collection.id, collection.name, collection.repo];
    return candidates.some((candidate) => {
      const token = normalizeToken(candidate);
      const wantedPrefix = wanted.split('-')[0];
      return token === wanted ||
        token.startsWith(`${wanted}-`) ||
        wanted.startsWith(`${token}-`) ||
        token.startsWith(`${wantedPrefix}-`);
    });
  });
}

function collectionAlreadyPresent(collection, tokens) {
  const candidates = [collection.id, collection.name, ...(collection.skills || [])];
  return candidates.some((candidate) => tokens.includes(normalizeToken(candidate)));
}

function projectSignals(context = {}) {
  const technologies = new Set((context.technologies || []).map(normalizeToken));
  const signals = [];
  if (context.isCodeRepo) signals.push('development');
  if (technologies.has('typescript') || technologies.has('javascript') || technologies.has('react') || technologies.has('vue') || technologies.has('svelte')) {
    signals.push('development');
  }
  if (technologies.has('react') || technologies.has('vue') || technologies.has('svelte')) signals.push('frontend');
  if (technologies.has('golang')) signals.push('golang');
  return [...new Set(signals)];
}

function recommendationFromCollection(collection, reason) {
  return {
    id: collection.id,
    name: collection.name,
    category: collection.categoryLabel,
    repo: collection.repo,
    reason: reason || collection.reason
  };
}

export function buildRecommendations(state, catalog = {}, context = {}) {
  const maxRecommendations = catalog.recommendationStrategy?.maxRecommendations || 3;
  const tokens = stateTokens(state);
  const signals = projectSignals(context);
  const hasEnabledSkills = (state.enabled || []).length > 0 || (state.global || []).length > 0;
  const mode = hasEnabledSkills || (state.skills || []).length > 0 && !context.isCodeRepo
    ? 'gap-based'
    : signals.length > 0
      ? 'starter'
      : 'discovery';
  const recommendations = [];

  if (mode === 'discovery') {
    const ids = catalog.recommendationModes?.discovery?.recommend || ['skillsmp', 'skills-sh'];
    for (const id of ids.slice(0, maxRecommendations)) {
      const source = catalog.sources?.[id];
      recommendations.push({
        id,
        name: id,
        repo: source?.url,
        reason: source?.note || '先浏览发现入口，再根据项目场景选择 skill。'
      });
    }
  } else if (mode === 'starter') {
    const scenario = signals.includes('golang')
      ? catalog.scenarios?.golang
      : signals.includes('frontend')
        ? catalog.scenarios?.react
        : signals.includes('development')
          ? catalog.scenarios?.typescript || catalog.scenarios?.['new-project']
          : catalog.scenarios?.['new-project'];
    const ids = [
      ...(scenario?.recommend?.primary || []),
      ...(scenario?.recommend?.optional || [])
    ];
    for (const id of ids) {
      const collection = findFeaturedCollection(id, catalog);
      if (!collection || collectionAlreadyPresent(collection, tokens)) continue;
      recommendations.push(recommendationFromCollection(collection, scenario.description));
      if (recommendations.length >= maxRecommendations) break;
    }
  } else {
    const categoryOrder = [...signals, ...Object.keys(catalog.featured || {})];
    const seenCategories = new Set();
    for (const category of categoryOrder) {
      if (seenCategories.has(category)) continue;
      seenCategories.add(category);
      const data = catalog.featured?.[category];
      const collection = (data?.collections || []).find((candidate) => !collectionAlreadyPresent(candidate, tokens));
      if (!collection) continue;
      recommendations.push(recommendationFromCollection({ ...collection, category, categoryLabel: data.label }, `当前项目可继续补充${data.label}能力。`));
      if (recommendations.length >= maxRecommendations) break;
    }
  }

  return { mode, signals, recommendations };
}

function formatCounts(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function buildAnalysisReport(state, catalog = {}, context = {}) {
  const recommendation = buildRecommendations(state, catalog, context);
  const sourceCounts = formatCounts(state.skills || [], (skill) => skill.source);
  const enabledAliases = (state.enabled || []).map((skill) => skill.alias || skill.name).filter(Boolean);
  const technologies = context.technologies?.length ? context.technologies.join('、') : '未识别';
  const advice = state.advice || [];
  const lines = [
    'Skillcaddy 项目分析',
    `项目：${state.projectPath}`,
    `原件库：${state.rootDir}`,
    '',
    '当前状态：',
    `  原件库 skill：${state.stats?.total ?? state.skills?.length ?? 0}（可用 ${state.stats?.available ?? state.skills?.length ?? 0}）`,
    `  项目 Agents 已启用：${state.enabled?.length || 0}`,
    `  项目 Claude Code 已启用：${state.claude?.skills?.length || 0}`,
    `  全局 skill：${state.global?.length || 0}`,
    `  Collection setup：${state.setups?.length || 0}`,
    `  诊断项：${advice.length}`,
    `  项目线索：${technologies}`,
    ''
  ];

  if (sourceCounts.length > 0) {
    lines.push('原件来源：');
    for (const [source, count] of sourceCounts) lines.push(`  ${source}：${count}`);
    lines.push('');
  }

  lines.push('项目已启用：');
  lines.push(enabledAliases.length > 0 ? `  ${enabledAliases.join('、')}` : '  暂无');
  lines.push('', '诊断汇报：');
  if (advice.length === 0) {
    lines.push('  未发现需要立即处理的诊断项。');
  } else {
    for (const item of advice.slice(0, 8)) {
      lines.push(`  [${item.severity || 'info'}] ${item.title}`);
      if (item.detail) lines.push(`    ${item.detail}`);
    }
    if (advice.length > 8) lines.push(`  ……还有 ${advice.length - 8} 项，TUI/Web 中可查看完整诊断。`);
  }

  lines.push('', `推荐模式：${catalog.recommendationModes?.[recommendation.mode]?.label || recommendation.mode}`);
  lines.push('推荐（最多 3 个，仅供参考，不会自动安装）：');
  if (recommendation.recommendations.length === 0) {
    lines.push('  暂无足够上下文生成具体推荐；可先补充项目场景或浏览推荐平台。');
  } else {
    recommendation.recommendations.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.name}`);
      if (item.category) lines.push(`     分类：${item.category}`);
      if (item.repo) lines.push(`     入口：${item.repo}`);
      if (item.reason) lines.push(`     理由：${item.reason}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

async function detectProjectContext(projectPath) {
  const context = { isCodeRepo: false, technologies: [] };
  const add = (value) => {
    if (value && !context.technologies.includes(value)) context.technologies.push(value);
  };

  try {
    const packageJson = JSON.parse(await readFile(path.join(projectPath, 'package.json'), 'utf8'));
    context.isCodeRepo = true;
    add('Node.js');
    const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    if (dependencyNames.some((name) => name === 'typescript' || name === 'tsx' || name === 'ts-node')) add('TypeScript');
    if (dependencyNames.some((name) => name === 'react' || name === 'react-dom')) add('React');
    if (dependencyNames.some((name) => name === 'vue')) add('Vue');
    if (dependencyNames.some((name) => name === 'svelte')) add('Svelte');
  } catch {
    // Other project markers below still provide useful signals.
  }

  const markers = [
    ['go.mod', 'Golang'],
    ['Cargo.toml', 'Rust'],
    ['pyproject.toml', 'Python'],
    ['tsconfig.json', 'TypeScript']
  ];
  for (const [file, technology] of markers) {
    try {
      await access(path.join(projectPath, file));
      context.isCodeRepo = true;
      add(technology);
    } catch {
      // Marker is optional.
    }
  }
  return context;
}

async function loadCatalog(rootDir) {
  try {
    return JSON.parse(await readFile(
      path.join(rootDir, 'skills', 'skillcaddy-manager', 'references', 'featured-skills.json'),
      'utf8'
    ));
  } catch {
    return {};
  }
}

export async function runCli({
  argv = [],
  rootDir = process.cwd(),
  runtimeRootDir = rootDir,
  stdout = process.stdout,
  stderr = process.stderr,
  handlers = {}
} = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    stderr.write(`错误：${parsed.error}\n\n`);
    stderr.write(buildHelpText());
    return 2;
  }

  const resolvedRootDir = path.resolve(parsed.rootDir || rootDir);
  const resolvedRuntimeRootDir = path.resolve(runtimeRootDir);
  const projectPath = path.resolve(parsed.projectPath || process.cwd());
  const actions = {
    readVersion,
    startWeb,
    stopWeb,
    restartWeb,
    runSourceCli,
    installCliCommand,
    getState,
    loadCatalog,
    detectProjectContext,
    ...handlers
  };

  if (
    ['start', 'stop', 'restart'].includes(parsed.command) &&
    resolvedRootDir !== resolvedRuntimeRootDir
  ) {
    stderr.write('错误：Web 生命周期需要使用 CLI 所在 clone 的根目录；--root 仅用于原件库操作\n');
    return 2;
  }

  try {
    if (parsed.command === 'help') {
      stdout.write(buildHelpText());
      return 0;
    }
    if (parsed.command === 'version') {
      const version = await actions.readVersion(resolvedRootDir);
      stdout.write(`${version.name} v${version.version}\n`);
      return 0;
    }
    if (parsed.command === 'install') {
      const result = await actions.installCliCommand(resolvedRootDir);
      stdout.write(`${result.message}\n`);
      stdout.write(`source: ${result.sourcePath}\n`);
      stdout.write(`target: ${result.targetPath}\n`);
      if (result.command) stdout.write(`command: ${result.command}\n`);
      return 0;
    }
    if (parsed.command === 'update') {
      return actions.runSourceCli({
        argv: ['update-git'],
        rootDir: resolvedRootDir,
        projectPath,
        stdout,
        stderr
      });
    }
    if (parsed.command === 'analyze') {
      const [state, catalog, context] = await Promise.all([
        actions.getState(resolvedRootDir, projectPath, { readOnly: true }),
        actions.loadCatalog(resolvedRootDir),
        actions.detectProjectContext(projectPath)
      ]);
      stdout.write(buildAnalysisReport(state, catalog, context));
      return 0;
    }

    const lifecycleOptions = {
      rootDir: resolvedRootDir,
      projectPath,
      port: parsed.port,
      open: parsed.open
    };
    if (parsed.command === 'start') {
      printWebResult(await actions.startWeb(lifecycleOptions), stdout);
      return 0;
    }
    if (parsed.command === 'stop') {
      printWebResult(await actions.stopWeb(lifecycleOptions), stdout);
      return 0;
    }
    if (parsed.command === 'restart') {
      printWebResult(await actions.restartWeb(lifecycleOptions), stdout);
      return 0;
    }

    stderr.write(buildHelpText());
    return 2;
  } catch (error) {
    stderr.write(`错误：${error.message}\n`);
    return error.exitCode || 1;
  }
}
