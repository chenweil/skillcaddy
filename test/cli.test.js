import { readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnalysisReport,
  buildHelpText,
  buildRecommendations,
  isCliCommand,
  parseCliArgs,
  runCli
} from '../scripts/cli.js';
import { makeTempDir } from './testHelpers.js';

function captureOutput() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

const catalog = {
  recommendationStrategy: { maxRecommendations: 3 },
  recommendationModes: {
    discovery: { label: '发现入口', recommend: ['skillsmp', 'skills-sh'] },
    starter: { label: '场景起步库' },
    'gap-based': { label: '补短板推荐' }
  },
  sources: {
    skillsmp: { url: 'https://skillsmp.com', note: '平台入口' },
    'skills-sh': { url: 'https://www.skills.sh', note: '热度入口' }
  },
  scenarios: {
    typescript: {
      description: 'TypeScript 项目',
      recommend: { primary: ['starter-suite'] }
    }
  },
  featured: {
    development: {
      label: '开发类',
      collections: [{
        id: 'starter-suite',
        name: 'starter/skills',
        repo: 'https://example.test/starter',
        skills: ['tdd'],
        reason: '开发流程'
      }]
    }
  }
};

test('CLI preserves no-argument TUI compatibility while recognizing lifecycle commands', () => {
  assert.equal(isCliCommand([]), false);
  assert.equal(isCliCommand(['/tmp/project']), false);
  assert.equal(isCliCommand(['--root', '/tmp/library', '/tmp/project']), false);
  assert.equal(isCliCommand(['start']), true);
  assert.equal(isCliCommand(['-a']), true);
  assert.deepEqual(parseCliArgs(['restart', '--port', '4317', '/tmp/project']), {
    command: 'restart',
    projectPath: '/tmp/project',
    rootDir: '',
    port: '4317',
    open: true,
    error: ''
  });
  assert.equal(parseCliArgs(['server', 'stop']).command, 'stop');
  assert.equal(parseCliArgs(['-u', '/tmp/project']).command, 'update');
  assert.equal(parseCliArgs(['install', 'tui']).installTarget, 'tui');
});

test('CLI help and version are deterministic', async () => {
  assert.match(buildHelpText(), /skillcaddy start/);
  assert.match(buildHelpText(), /skillcaddy install cli/);
  const output = captureOutput();
  assert.equal(await runCli({ argv: ['-v'], rootDir: '/tmp/skillcaddy', ...output.streams, handlers: {
    readVersion: async () => ({ name: 'skillcaddy', version: '9.9.9' })
  } }), 0);
  assert.equal(output.stdout(), 'skillcaddy v9.9.9\n');
});

test('CLI -u delegates to the existing safe Git batch update boundary', async () => {
  const output = captureOutput();
  const calls = [];
  assert.equal(await runCli({
    argv: ['-u', '/tmp/project'],
    rootDir: '/tmp/library',
    ...output.streams,
    handlers: {
      runSourceCli: async (options) => {
        calls.push(options);
        options.stdout.write('batch update\n');
        return 0;
      }
    }
  }), 0);
  assert.deepEqual(calls[0].argv, ['update-git']);
  assert.equal(calls[0].rootDir, '/tmp/library');
  assert.equal(calls[0].projectPath, '/tmp/project');
  assert.equal(output.stdout(), 'batch update\n');
});

test('CLI rejects a custom data root for Web lifecycle commands', async () => {
  const output = captureOutput();

  assert.equal(
    await runCli({
      argv: ['start', '--root', '/tmp/library'],
      rootDir: '/tmp/skillcaddy-clone',
      runtimeRootDir: '/tmp/skillcaddy-clone',
      ...output.streams,
      handlers: {
        startWeb: async () => {
          throw new Error('startWeb should not be called');
        }
      }
    }),
    2
  );
  assert.match(output.stderr(), /Web 生命周期需要使用 CLI 所在 clone/);
});

test('CLI exposes explicit global CLI installation and keeps tui as an alias', async () => {
  const output = captureOutput();
  const calls = [];
  assert.equal(await runCli({
    argv: ['install', 'tui'],
    rootDir: '/tmp/library',
    ...output.streams,
    handlers: {
      installCliCommand: async (rootDir) => {
        calls.push(rootDir);
        return {
          message: 'installed',
          sourcePath: rootDir,
          targetPath: '/tmp/global/skillcaddy',
          command: 'skillcaddy'
        };
      }
    }
  }), 0);
  assert.deepEqual(calls, ['/tmp/library']);
  assert.match(output.stdout(), /installed/);
  assert.match(output.stdout(), /command: skillcaddy/);
});

test('CLI -a is read-only and reports state plus bounded recommendations', async () => {
  const output = captureOutput();
  let stateReads = 0;
  assert.equal(await runCli({
    argv: ['-a'],
    rootDir: '/tmp/library',
    ...output.streams,
    handlers: {
      getState: async () => {
        stateReads += 1;
        return {
          rootDir: '/tmp/library',
          projectPath: '/tmp/project',
          skills: [],
          enabled: [],
          global: [],
          setups: [],
          advice: [],
          claude: { skills: [] },
          stats: { total: 0, available: 0 }
        };
      },
      loadCatalog: async () => catalog,
      detectProjectContext: async () => ({ isCodeRepo: false, technologies: [] })
    }
  }), 0);
  assert.equal(stateReads, 1);
  assert.match(output.stdout(), /Skillcaddy 项目分析/);
  assert.match(output.stdout(), /推荐模式：发现入口/);
  assert.match(output.stdout(), /skillsmp/);
  assert.equal(output.stderr(), '');
});

test('CLI -a does not create source directories during analysis', async () => {
  const root = await makeTempDir('cli-analysis-read-only-root-');
  const project = await makeTempDir('cli-analysis-read-only-project-');
  const before = await readdir(root);
  const output = captureOutput();

  assert.equal(
    await runCli({
      argv: ['-a', project],
      rootDir: root,
      ...output.streams
    }),
    0
  );
  assert.deepEqual(await readdir(root), before);
});

test('analysis recommendation mode uses a starter candidate for a code project', () => {
  const result = buildRecommendations({ skills: [], enabled: [], global: [] }, catalog, {
    isCodeRepo: true,
    technologies: ['Node.js', 'TypeScript']
  });
  assert.equal(result.mode, 'starter');
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].id, 'starter-suite');
});

test('analysis report includes diagnostics and does not promise installation', () => {
  const report = buildAnalysisReport({
    rootDir: '/tmp/library',
    projectPath: '/tmp/project',
    skills: [{ source: 'github', name: 'tdd', collection: 'demo' }],
    enabled: [{ alias: 'tdd' }],
    global: [],
    setups: [],
    advice: [{ severity: 'warning', title: '需要检查', detail: '请确认配置' }],
    claude: { skills: [] },
    stats: { total: 1, available: 1 }
  }, catalog, { isCodeRepo: true, technologies: ['Node.js'] });
  assert.match(report, /\[warning\] 需要检查/);
  assert.match(report, /不会自动安装/);
});
